import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { roundTrip } from "../../integration/blossom/browser";
import { createClient, PrivateKeySigner } from "../../src";
import { UpstreamBlossom } from "./support/blossom-service";

const alice = new PrivateKeySigner(new Uint8Array(32).fill(61));
const bob = new PrivateKeySigner(new Uint8Array(32).fill(62));
const owner = createClient({
  namespace: "upstream-blossom",
  relays: ["ws://127.0.0.1:1"],
  signer: alice,
});
const foreign = createClient({
  namespace: "upstream-blossom",
  relays: ["ws://127.0.0.1:1"],
  signer: bob,
});
const clients = [owner, foreign];
let server: UpstreamBlossom;

async function upload(text: string) {
  const blob = new Blob([text], { type: "text/plain" });
  const result = await owner.storage.from(server.url).upload("integration.txt", blob);
  expect(result.error).toBeNull();
  if (!result.data) throw new Error("Expected an upstream blob descriptor.");
  expect(result.data.sha256).toBe(createHash("sha256").update(text).digest("hex"));
  expect(result.data.size).toBe(blob.size);
  expect(result.data.type).toBe("text/plain");
  expect(new URL(result.data.url).origin).toBe(server.url);
  return result.data;
}

async function authorization(tags: string[][], signer = alice): Promise<string> {
  const event = await signer.signEvent({
    kind: 24242,
    created_at: Math.floor(Date.now() / 1000) - 1,
    content: "Local integration authorization",
    tags,
  });
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64url")}`;
}

describe("independently maintained Blossom server", () => {
  beforeAll(async () => {
    server = await UpstreamBlossom.start();
  });
  afterAll(async () => {
    await Promise.all(clients.map((client) => client.closeAsync()));
    await server?.close();
  });

  it("accepts SDK signed upload/list/download/delete and keeps byte identity", async () => {
    const text = "Independent upstream Blossom content ✓";
    const blob = await upload(text);
    const bucket = owner.storage.from(server.url);
    const listed = await bucket.list();
    expect(listed.error).toBeNull();
    expect(listed.data).toContainEqual({
      url: blob.url,
      sha256: blob.sha256,
      size: blob.size,
      type: blob.type,
      uploaded: blob.uploaded,
    });
    const downloaded = await bucket.download(blob.sha256, { authenticated: true });
    expect(downloaded.error).toBeNull();
    expect(await downloaded.data?.text()).toBe(text);
    const removed = await bucket.remove([blob.sha256]);
    expect(removed.error).toBeNull();
    expect(removed.data).toEqual([{ sha256: blob.sha256, ok: true, error: null }]);
    expect((await bucket.download(blob.sha256)).error?.code).toBe("NOT_FOUND");
    expect((await bucket.list()).data?.some((entry) => entry.sha256 === blob.sha256)).toBe(false);
  });

  it("preserves server state across a real process restart", async () => {
    const text = "Blossom SQLite and file persistence";
    const blob = await upload(text);
    await server.restart();
    const bucket = owner.storage.from(server.url);
    expect(await (await bucket.download(blob.sha256)).data?.text()).toBe(text);
    expect((await bucket.list()).data?.some((entry) => entry.sha256 === blob.sha256)).toBe(true);
    expect((await bucket.remove([blob.sha256])).error).toBeNull();
  });

  it("denies a foreign deletion/list and preserves the owner's object", async () => {
    const blob = await upload("Owner authorization boundary");
    const other = foreign.storage.from(server.url);
    const denied = await other.remove([blob.sha256]);
    expect(denied.error?.code).toBe("PUBLISH_FAILED");
    expect(denied.data?.[0]?.error?.code).toBe("PERMISSION_DENIED");
    expect(denied.data?.[0]?.ok).toBe(false);
    expect((await other.list(await alice.getPublicKey())).error?.code).toBe("PERMISSION_DENIED");
    expect((await owner.storage.from(server.url).download(blob.sha256)).error).toBeNull();
    expect((await owner.storage.from(server.url).remove([blob.sha256])).error).toBeNull();
  });

  it("retains shared content until the last uploader removes its ownership", async () => {
    const text = "Shared content-addressed object";
    const blob = await upload(text);
    const foreignBucket = foreign.storage.from(server.url);
    const second = await foreignBucket.upload(
      "second.txt",
      new Blob([text], { type: "text/plain" }),
    );
    expect(second.error).toBeNull();
    expect(second.data?.sha256).toBe(blob.sha256);
    const ownerBucket = owner.storage.from(server.url);
    expect((await ownerBucket.remove([blob.sha256])).error).toBeNull();
    expect((await ownerBucket.list()).data?.some((entry) => entry.sha256 === blob.sha256)).toBe(
      false,
    );
    expect(await (await foreignBucket.download(blob.sha256)).data?.text()).toBe(text);
    expect((await foreignBucket.remove([blob.sha256])).error).toBeNull();
    expect((await ownerBucket.download(blob.sha256)).error?.code).toBe("NOT_FOUND");
  });

  it("rejects absent, forged, expired, wrong-action, wrong-server and wrong-hash authorization", async () => {
    const blob = await upload("Server validates each scoped signature");
    const now = Math.floor(Date.now() / 1000);
    const base = [
      ["t", "delete"],
      ["expiration", String(now + 300)],
      ["server", "127.0.0.1"],
      ["x", blob.sha256],
    ];
    const valid = await authorization(base);
    const forged = JSON.parse(Buffer.from(valid.slice(6), "base64url").toString()) as {
      content: string;
    };
    forged.content = "Tampered after signing";
    const cases = [
      { name: "missing", token: undefined },
      {
        name: "signature",
        token: `Nostr ${Buffer.from(JSON.stringify(forged)).toString("base64url")}`,
      },
      {
        name: "expired",
        token: await authorization(
          base.map((tag) => (tag[0] === "expiration" ? ["expiration", String(now - 5)] : tag)),
        ),
      },
      {
        name: "action",
        token: await authorization(base.map((tag) => (tag[0] === "t" ? ["t", "upload"] : tag))),
      },
      {
        name: "server",
        token: await authorization(
          base.map((tag) => (tag[0] === "server" ? ["server", "different.invalid"] : tag)),
        ),
      },
      {
        name: "hash",
        token: await authorization(
          base.map((tag) => (tag[0] === "x" ? ["x", "0".repeat(64)] : tag)),
        ),
      },
    ];
    for (const item of cases) {
      const response = await fetch(`${server.url}/${blob.sha256}`, {
        method: "DELETE",
        headers: item.token ? { Authorization: item.token } : {},
      });
      if (item.name === "signature") expect(response.status).toBe(400);
      else expect([401, 403], item.name).toContain(response.status);
      expect(response.headers.get("access-control-allow-origin"), item.name).toBe("*");
      expect(
        (await owner.storage.from(server.url).download(blob.sha256)).error,
        item.name,
      ).toBeNull();
    }
    expect((await owner.storage.from(server.url).remove([blob.sha256])).error).toBeNull();
  });

  it("returns an explicit server rejection when upload exceeds its configured size limit", async () => {
    const rejected = await owner.storage
      .from(server.url)
      .upload("oversize.bin", new Blob([new Uint8Array(65_537)]));
    expect(rejected.data).toBeNull();
    expect(rejected.error?.code).toBe("RELAY_ERROR");
    expect(rejected.error?.message).toContain("413");
  });

  it("permits the SDK headers in browser preflight for upload and deletion", async () => {
    for (const method of ["PUT", "DELETE"]) {
      const preflight = await fetch(`${server.url}/upload`, {
        method: "OPTIONS",
        headers: {
          Origin: "http://127.0.0.1:12345",
          "Access-Control-Request-Method": method,
          "Access-Control-Request-Headers": "authorization,content-type,x-sha-256",
        },
      });
      expect(preflight.ok).toBe(true);
      expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
      expect(preflight.headers.get("access-control-allow-methods")?.split(",")).toContain(method);
      const headers =
        preflight.headers.get("access-control-allow-headers")?.toLowerCase().split(",") ?? [];
      expect(headers).toContain("authorization");
      expect(headers).toContain("content-type");
      expect(headers.includes("x-sha-256") || headers.includes("*")).toBe(true);
    }
  });

  it("runs the complete SDK round trip in Chromium across separate HTTP origins", async () => {
    const bundle = await build({
      entryPoints: [resolve("integration/blossom/browser.ts")],
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      globalName: "BlossomTest",
    });
    const javascript = bundle.outputFiles[0]?.text;
    if (!javascript) throw new Error("Expected a browser SDK bundle.");
    const app = createServer((request, response) => {
      if (request.url === "/sdk.js")
        response.writeHead(200, { "Content-Type": "text/javascript" }).end(javascript);
      else
        response
          .writeHead(200, { "Content-Type": "text/html" })
          .end('<!doctype html><script src="/sdk.js"></script>');
    });
    app.listen(0, "127.0.0.1");
    await once(app, "listening");
    const origin = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      browser = await chromium.launch();
      const page = await browser.newPage();
      await page.goto(origin);
      expect(origin).not.toBe(server.url);
      const result = await page.evaluate(async (url) => {
        const harness = globalThis as unknown as { BlossomTest: { roundTrip: typeof roundTrip } };
        return harness.BlossomTest.roundTrip(url);
      }, server.url);
      expect(result.size).toBe(result.inputSize);
      expect(result.listError).toBeNull();
      expect(result.listed).toBe(true);
      expect(result.downloadError).toBeNull();
      expect(result.download).toBe(result.expected);
      expect(result.foreignDelete).toBe("PERMISSION_DENIED");
      expect(result.removeError).toBeNull();
      expect(result.removed).toBe(true);
      expect(result.absent).toBe("NOT_FOUND");
    } finally {
      await browser?.close();
      app.closeAllConnections();
      await new Promise<void>((done, fail) => app.close((error) => (error ? fail(error) : done())));
    }
  });
});
