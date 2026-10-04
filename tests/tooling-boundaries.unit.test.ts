import { describe, expect } from "vitest";
import type { Backup } from "../src";
import { encodeRecord } from "../src/protocol";
import { alice, bob } from "./helpers";
import { deferred, required, test } from "./support/lifecycle";

describe("migration planning and partial writes", () => {
  test("validates every destination before publishing when the last planned record is invalid", async ({
    scope,
  }) => {
    const { client, transport } = scope.client();
    await client.from("todos").insert([
      { id: "a", title: "a", done: false },
      { id: "b", title: "b", done: false },
    ]);
    transport.published.length = 0;
    let calls = 0;
    const result = await client.migrations.run("todos", (data) => {
      calls++;
      return calls === 2
        ? ({ title: "invalid", done: "wrong" } as never)
        : { ...data, title: "changed" };
    });
    expect(result.error?.code).toBe("INVALID_RECORD");
    expect(result.data).toMatchObject({ examined: 2, changed: 0, rows: [], receipts: [] });
    expect(transport.published).toEqual([]);
    expect((await client.from("todos").local()).data?.map((row) => row.title).sort()).toEqual([
      "a",
      "b",
    ]);
  });

  test("skipped and unchanged records are examined but do not become writes", async ({ scope }) => {
    const { client, transport } = scope.client();
    await client.from("todos").insert([
      { id: "skip", title: "skip", done: false },
      { id: "same", title: "same", done: false },
      { id: "change", title: "change", done: false },
    ]);
    transport.published.length = 0;
    const result = await client.migrations.run("todos", (data) =>
      data.title === "skip" ? null : data.title === "same" ? data : { ...data, done: true },
    );
    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({ examined: 3, changed: 1 });
    expect(result.data?.rows.map((row) => row.id)).toEqual(["change"]);
    expect(transport.published).toHaveLength(1);
  });

  test("stops at the first rejected migration write and preserves the committed rows and all attempted receipts", async ({
    scope,
  }) => {
    const { client, transport } = scope.client();
    await client.from("todos").insert([
      { id: "a", title: "a", done: false },
      { id: "b", title: "b", done: false },
      { id: "c", title: "c", done: false },
    ]);
    transport.published.length = 0;
    transport.failPublishAt = 2;
    const result = await client.migrations.run("todos", (data) => ({ ...data, done: true }));
    expect(result.error?.code).toBe("PUBLISH_FAILED");
    expect(result.data?.changed).toBe(1);
    expect(result.data?.receipts).toHaveLength(2);
    expect(result.meta?.receipts).toEqual(result.data?.receipts);
    expect(result.meta?.partial).toBe(true);
    expect(transport.published).toHaveLength(2);
    expect(
      (await client.from("todos").local()).data?.filter((row) => row.done).map((row) => row.id),
    ).toEqual(result.data?.rows.map((row) => row.id));
  });

  test("cannot migrate as a new author if the account changes during an async transform", async ({
    scope,
  }) => {
    const { client, transport } = scope.client();
    await client.from("todos").insert({ id: "a", title: "a", done: false });
    transport.published.length = 0;
    const started = deferred();
    const release = deferred();
    scope.defer(() => release.resolve());
    const pending = client.migrations.run("todos", async (data) => {
      started.resolve();
      await release.promise;
      return { ...data, done: true };
    });
    await started.promise;
    await client.auth.signInWithSigner(bob);
    release.resolve();
    const result = await pending;
    expect(result.error?.code).toBe("PERMISSION_DENIED");
    expect(result.data?.changed).toBe(0);
    expect(transport.published).toEqual([]);
  });

  test("queued migration replaces obsolete fields without relay access", async ({ scope }) => {
    const { client, transport } = scope.client();
    client.ingest(
      await alice.signEvent(
        encodeRecord("test-app", "todos", "legacy", { legacyName: "old", obsolete: true }, 10, 10),
      ),
    );
    const result = await client.migrations.run(
      "todos",
      (data: { legacyName: string }) => ({ title: data.legacyName, done: false }),
      { queue: true },
    );
    expect(result.error).toBeNull();
    expect(result.data?.changed).toBe(1);
    expect(result.data?.receipts[0]?.queued).toBe(true);
    expect((await client.from("todos").local().single()).data).toMatchObject({
      id: "legacy",
      title: "old",
      done: false,
      _nostr: { createdAt: 10 },
    });
    expect((await client.from("todos").local().single()).data).not.toHaveProperty("obsolete");
    expect(transport.requests).toEqual([]);
    expect(transport.published).toEqual([]);
  });
});

describe("backup validation and ownership", () => {
  test("validates the final archive event before importing the first valid event", async ({
    scope,
  }) => {
    const { client, transport } = scope.client();
    const signed = await alice.signEvent(
      encodeRecord("test-app", "todos", "valid", { title: "x", done: false }, 10, 10),
    );
    const other = await alice.signEvent(
      encodeRecord("foreign", "todos", "other", { title: "other", done: false }, 10, 10),
    );
    const archive: Backup = {
      format: "nostrbase-backup",
      version: 1,
      namespace: "test-app",
      exportedAt: 1,
      events: [signed, other],
    };
    expect((await client.backup.import(archive)).error?.code).toBe("INVALID_RECORD");
    expect(client.cachedEvents()).toEqual([]);
    expect(transport.published).toEqual([]);
  });

  test("rejects an e-only deletion signed by another author even when its target belongs to this backup", async ({
    scope,
  }) => {
    const { client } = scope.client();
    const signed = await alice.signEvent(
      encodeRecord("test-app", "todos", "x", { title: "x", done: false }, 10, 10),
    );
    const foreignDelete = await bob.signEvent({
      kind: 5,
      created_at: 20,
      content: "",
      tags: [["e", signed.id]],
    });
    const archive: Backup = {
      format: "nostrbase-backup",
      version: 1,
      namespace: "test-app",
      exportedAt: 1,
      events: [signed, foreignDelete],
    };
    expect((await client.backup.import(archive)).error?.code).toBe("INVALID_RECORD");
    expect(client.cachedEvents()).toEqual([]);
  });

  test("exported events and imported input cannot be used to mutate cached signed data", async ({
    scope,
  }) => {
    const writer = scope.client().client;
    await writer.from("todos").insert({ id: "x", title: "original", done: false });
    const archive = required((await writer.backup.export()).data);
    const reader = scope.client().client;
    expect((await reader.backup.import(archive)).error).toBeNull();
    required(archive.events[0]).content = "tampered after import";
    expect((await writer.from("todos").local().single()).data?.title).toBe("original");
    expect((await reader.from("todos").local().single()).data?.title).toBe("original");
    expect(
      (await reader.backup.import(required((await writer.backup.export()).data))).data?.duplicates,
    ).toBe(1);
  });
});
