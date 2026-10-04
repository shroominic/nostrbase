import { describe, expect } from "vitest";
import { alice } from "./helpers";
import { BlossomServer } from "./support/blossom";
import { required, test } from "./support/lifecycle";

describe("Blossom over real HTTP", () => {
  test("uploads, lists, downloads and deletes with independently verified authorization and byte integrity", async ({
    scope,
  }) => {
    const server = await new BlossomServer().start();
    scope.defer(() => server.close());
    const { client } = scope.client();
    const bucket = client.storage.from(server.url);
    const bytes = new Uint8Array([0, 255, 16, 128, 1]);
    const uploaded = await bucket.upload(
      "binary.dat",
      new Blob([bytes], { type: "application/octet-stream" }),
    );
    expect(uploaded.error).toBeNull();
    const hash = required(uploaded.data).sha256;
    const listed = await bucket.list(undefined, { limit: 1 });
    expect(listed.error).toBeNull();
    expect(listed.data?.map((blob) => blob.sha256)).toEqual([hash]);
    expect((await bucket.list(undefined, { cursor: hash })).data).toEqual([]);
    const publicReader = scope.client({ signer: undefined }).client.storage.from(server.url);
    const downloaded = await publicReader.download(hash);
    expect(downloaded.error).toBeNull();
    expect(new Uint8Array(await required(downloaded.data).arrayBuffer())).toEqual(bytes);
    expect((await bucket.download(hash, { authenticated: true })).error).toBeNull();
    const removed = await bucket.remove([hash, hash]);
    expect(removed.error).toBeNull();
    expect(removed.count).toBe(1);
    expect((await publicReader.download(hash)).error?.code).toBe("NOT_FOUND");
    expect(
      server.requests.map((request) => [
        request.method,
        request.token?.tags.find((tag) => tag[0] === "t")?.[1] ?? "public",
      ]),
    ).toEqual([
      ["PUT", "upload"],
      ["GET", "list"],
      ["GET", "list"],
      ["GET", "public"],
      ["GET", "get"],
      ["DELETE", "delete"],
      ["GET", "public"],
    ]);
    const author = await alice.getPublicKey();
    expect(
      server.requests
        .filter((request) => request.token)
        .every((request) => request.token?.pubkey === author),
    ).toBe(true);
  });

  test("rejects corrupted download bytes and reports partial deletes with the exact failing hash", async ({
    scope,
  }) => {
    const server = await new BlossomServer().start();
    scope.defer(() => server.close());
    const bucket = scope.client().client.storage.from(server.url);
    const first = required((await bucket.upload("first.txt", new Blob(["first"]))).data);
    const second = required((await bucket.upload("second.txt", new Blob(["second"]))).data);
    server.corruptDownload = true;
    expect((await bucket.download(first.sha256)).error?.code).toBe("INVALID_RECORD");
    server.deniedDeletes.add(second.sha256);
    const result = await bucket.remove([first.sha256, second.sha256]);
    expect(result.error?.code).toBe("PUBLISH_FAILED");
    expect(result.count).toBe(1);
    expect(result.data?.map((item) => [item.sha256, item.ok, item.error?.code ?? null])).toEqual([
      [first.sha256, true, null],
      [second.sha256, false, "PERMISSION_DENIED"],
    ]);
    expect([...server.objects.keys()]).toEqual([second.sha256]);
  });

  test("cancellation interrupts response-body consumption and closes the HTTP stream", async ({
    scope,
  }) => {
    const server = await new BlossomServer().start();
    scope.defer(() => server.close());
    const bucket = scope.client().client.storage.from(server.url);
    const uploaded = required(
      (await bucket.upload("large.txt", new Blob(["never finish reading this body"]))).data,
    );
    server.stallBody = true;
    const controller = new AbortController();
    const pending = bucket.download(uploaded.sha256, { signal: controller.signal });
    await server.bodyStarted.promise;
    controller.abort();
    const result = await pending;
    expect(result.error?.code).toBe("ABORTED");
    expect(result.data).toBeNull();
    await server.bodyClosed.promise;
  });

  test("an upload redirect is not followed with the signed authorization token", async ({
    scope,
  }) => {
    const server = await new BlossomServer().start();
    scope.defer(() => server.close());
    server.redirectUpload = true;
    const bucket = scope.client().client.storage.from(server.url);
    const result = await bucket.upload("file.txt", new Blob(["private HTTP credentials"]));
    expect(result.error).not.toBeNull();
    expect(result.data).toBeNull();
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.path).toBe("/upload");
  });
});
