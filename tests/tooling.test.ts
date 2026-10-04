import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import type { Backup, InferDatabase, NostrbaseClient } from "../src";
import { MemoryPersistenceAdapter, reference, zodTable } from "../src";
import { encodeRecord } from "../src/protocol";
import type { TestDB } from "./helpers";
import { alice, bob, setup } from "./helpers";

const clients: NostrbaseClient<TestDB>[] = [];
function fixture(options: Parameters<typeof setup>[0] = {}) {
  const result = setup(options);
  clients.push(result.client);
  return result;
}
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.closeAsync()));
});

describe("query extensions", () => {
  it("searches fields locally with normalized words and sends NIP50 search when requested", async () => {
    const { client, transport } = fixture();
    await client.from("todos").insert([
      { id: "1", title: "Café build toolkit", done: false },
      { id: "2", title: "Build site", done: false },
    ]);
    expect(
      (await client.from("todos").textSearch("title", "CAFE toolkit")).data?.map((row) => row.id),
    ).toEqual(["1"]);
    expect((await client.events.search("toolkit", { kinds: [30078] })).error).toBeNull();
    expect(transport.requests.at(-1)?.[0]).toMatchObject({ search: "toolkit" });
    expect((await client.events.search(" ")).error?.code).toBe("INVALID_QUERY");
  });
  it("pages by timestamp and event id without repeating a boundary and validates cursor scope", async () => {
    const { client, transport } = fixture();
    await client
      .from("todos")
      .insert(["1", "2", "3"].map((id) => ({ id, title: id, done: false })));
    const first = await client.from("todos").page(2);
    expect(first.data).toHaveLength(2);
    expect(first.meta?.nextCursor).toBeTypeOf("string");
    const second = await client.from("todos").page(2, { cursor: first.meta?.nextCursor });
    expect(second.data).toHaveLength(1);
    expect(new Set([...(first.data ?? []), ...(second.data ?? [])].map((row) => row.id)).size).toBe(
      3,
    );
    expect(transport.requests.some((filters) => filters[0]?.until !== undefined)).toBe(true);
    expect(
      (await client.from("projects").page(2, { cursor: first.meta?.nextCursor })).error?.code,
    ).toBe("INVALID_QUERY");
    expect((await client.from("todos").page(2).order("title")).error?.code).toBe("INVALID_QUERY");
  });
  it("reads a verified local cache when offline", async () => {
    const { client, transport } = fixture();
    await client.from("todos").insert({ title: "cached", done: false });
    transport.readFailure = true;
    const before = transport.requests.length;
    const cached = await client.from("todos").local();
    expect(cached.data).toHaveLength(1);
    expect(cached.meta?.cached).toBe(true);
    expect(transport.requests.length).toBe(before);
    expect((await client.from("todos")).error?.code).toBe("RELAY_ERROR");
  });
  it("queues CRUD without any relay requests, restores state, and flushes exact events", async () => {
    const adapter = new MemoryPersistenceAdapter();
    const { client, transport } = fixture({ persistence: { adapter } });
    transport.readFailure = true;
    const inserted = await client
      .from("todos")
      .insert({ id: "one", title: "queued", done: false })
      .queue()
      .select()
      .single();
    expect(inserted.error).toBeNull();
    expect(inserted.meta?.queued).toBe(true);
    expect(inserted.meta?.receipts?.[0]?.queued).toBe(true);
    await client.from("todos").update({ done: true }).eq("id", "one").queue();
    expect((await client.from("todos").local().single()).data?.done).toBe(true);
    expect(transport.published).toHaveLength(0);
    expect(transport.requests).toHaveLength(0);
    await client.closeAsync();
    const { client: restored } = fixture({ persistence: { adapter }, transport });
    await restored.ready();
    expect((await restored.from("todos").local().single()).data?.done).toBe(true);
    transport.readFailure = false;
    expect((await restored.offline.flush()).error).toBeNull();
    expect(transport.published).toHaveLength(2);
    expect(await restored.offline.list()).toEqual([]);
    await restored.from("todos").delete().eq("id", "one").queue();
    expect((await restored.from("todos").local()).data).toEqual([]);
    expect((await restored.offline.flush()).error).toBeNull();
    expect(transport.published.at(-1)?.kind).toBe(5);
  });
});

describe("schemas and record references", () => {
  it("validates Zod schemas and infers record types", async () => {
    const schema = {
      todos: zodTable(z.object({ title: z.string().min(1), done: z.boolean() })),
      projects: zodTable(z.object({ name: z.string() })),
    };
    type DB = InferDatabase<typeof schema>;
    expectTypeOf<DB["todos"]>().toEqualTypeOf<{ title: string; done: boolean }>();
    const { client } = fixture({ schema });
    expect((await client.from("todos").insert({ title: "", done: false })).error?.code).toBe(
      "INVALID_RECORD",
    );
    expect(
      (await client.from("todos").insert({ title: "validated", done: false })).error,
    ).toBeNull();
  });
  it("resolves references by author and preserves missing records in batches", async () => {
    const { client } = fixture();
    await client.from("projects").insert({ id: "p", name: "Project" });
    const target = reference("projects", "p", await alice.getPublicKey());
    expect((await client.relations.resolve(target)).data?.name).toBe("Project");
    const batch = await client.relations.resolveMany([
      target,
      reference("projects", "missing", await alice.getPublicKey()),
    ]);
    expect(batch.error).toBeNull();
    expect(batch.data?.[1]).toBeNull();
    expect(batch.meta?.partial).toBe(true);
  });
});

describe("backups, migrations and local inspector", () => {
  it("round-trips signed public and private records without exposing private plaintext", async () => {
    const { client, transport } = fixture();
    await client.from("todos").insert({ id: "public", title: "public title", done: false });
    await client.private
      .from("todos")
      .insert({ id: "private", title: "never export this text", done: false });
    const archive = await client.backup.export();
    expect(archive.data?.events).toHaveLength(2);
    expect(JSON.stringify(archive.data)).not.toContain("never export this text");
    const { client: reader } = fixture();
    expect((await reader.backup.import(JSON.stringify(archive.data))).data?.imported).toBe(2);
    expect((await reader.from("todos").local()).data?.[0]?.title).toBe("public title");
    expect((await reader.private.from("todos").local()).data?.[0]?.title).toBe(
      "never export this text",
    );
    expect(transport.published).toHaveLength(2);
    const malformed = structuredClone(archive.data) as Backup;
    if (malformed.events[0]) malformed.events[0].content = "tampered";
    const { client: fresh } = fixture();
    expect((await fresh.backup.import(malformed)).error?.code).toBe("INVALID_RECORD");
    expect(fresh.eventStore.getByFilters({})).toEqual([]);
  });
  it("imports tombstones before stale records and rejects foreign archives", async () => {
    const { client } = fixture();
    await client.from("todos").insert({ id: "deleted", title: "x", done: false });
    await client.from("todos").delete().eq("id", "deleted");
    const backup = await client.backup.export();
    const { client: reader } = fixture();
    expect((await reader.backup.import(backup.data as Backup)).error).toBeNull();
    expect((await reader.from("todos").local()).data).toEqual([]);
    expect(
      (await reader.backup.import({ ...(backup.data as Backup), namespace: "foreign" })).error
        ?.code,
    ).toBe("INVALID_RECORD");
  });
  it("migrates legacy data owned by the signer and validates all planned data before publishing", async () => {
    const { client, transport } = fixture();
    const now = Math.floor(Date.now() / 1000);
    transport.events.push(
      await alice.signEvent(encodeRecord("test-app", "todos", "one", { name: "legacy" }, now, now)),
    );
    transport.events.push(
      await bob.signEvent(encodeRecord("test-app", "todos", "two", { name: "foreign" }, now, now)),
    );
    const transform = (data: { name: string }) => ({ title: data.name, done: false });
    const dryRun = await client.migrations.run("todos", transform, { dryRun: true });
    expect(dryRun.data).toMatchObject({ examined: 1, changed: 1 });
    expect(transport.published).toHaveLength(0);
    const migrated = await client.migrations.run("todos", transform);
    expect(migrated.error).toBeNull();
    expect(migrated.data?.rows[0]?.title).toBe("legacy");
    expect(migrated.data?.rows[0]?._nostr.createdAt).toBe(now);
    expect(transport.published).toHaveLength(1);
  });
  it("shows public data and encrypted metadata safely in a read-only dashboard", async () => {
    const { client } = fixture();
    await client.from("todos").insert({ title: "</script><img onerror=bad()> café", done: false });
    await client.private.from("todos").insert({ title: "private secret payload", done: false });
    const snapshot = await client.dashboard.snapshot();
    expect(snapshot.tables.find((table) => table.private)).toMatchObject({ count: 1, rows: [] });
    const html = await client.dashboard.render();
    expect(html).toContain("Local cache inspector");
    expect(html).not.toContain("<img onerror=bad()>");
    expect(html).not.toContain("private secret payload");
    expect(JSON.stringify(client.diagnostics.list())).not.toContain("private secret payload");
    expect(snapshot.logs.some((entry) => entry.type === "publish")).toBe(true);
  });
  it("keeps diagnostic buffers bounded and does not log record contents", async () => {
    const { client } = fixture({ diagnostics: { capacity: 3 } });
    await client.from("todos").insert({ title: "not in logs", done: false });
    expect(client.diagnostics.list().length).toBeLessThanOrEqual(3);
    expect(JSON.stringify(client.diagnostics.list())).not.toContain("not in logs");
  });
});

describe("integration review regressions", () => {
  it("rejects an event carrying a cached verification symbol after mutation", async () => {
    const { client, transport } = fixture();
    const now = Math.floor(Date.now() / 1000);
    const signed = await alice.signEvent(
      encodeRecord(
        "test-app",
        "todos",
        "cached-verification",
        { title: "genuine", done: false },
        now,
        now,
      ),
    );
    const { verifyEvent } = await import("nostr-tools");
    expect(verifyEvent(signed)).toBe(true);
    transport.events.push({
      ...signed,
      content: JSON.stringify({
        v: 1,
        namespace: "test-app",
        table: "todos",
        id: "cached-verification",
        createdAt: now,
        data: { title: "forged", done: false },
      }),
    });
    expect((await client.from("todos")).data).toEqual([]);
  });
  it("does not publish a delayed signature after signing out or changing signer", async () => {
    let complete: (() => void) | undefined;
    let started: (() => void) | undefined;
    const signing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { client, transport } = fixture({
      signer: {
        getPublicKey: alice.getPublicKey.bind(alice),
        signEvent: async (template) => {
          started?.();
          await new Promise<void>((resolve) => {
            complete = resolve;
          });
          return alice.signEvent(template);
        },
      },
    });
    const pending = Promise.resolve(
      client.from("todos").insert({ title: "old account", done: false }),
    );
    await signing;
    await client.auth.signOut();
    complete?.();
    expect((await pending).error?.code).toBe("AUTH_FAILED");
    expect(transport.published).toHaveLength(0);
  });
  it("exports deletion history so a restored backup rejects stale relay copies", async () => {
    const { client, transport } = fixture();
    await client.from("todos").insert({ id: "gone", title: "deleted", done: false });
    await client.from("todos").delete().eq("id", "gone");
    const archive = await client.backup.export();
    expect(archive.data?.events.some((event) => event.kind === 5)).toBe(true);
    const { client: restored, transport: staleRelay } = fixture();
    const original = transport.published[0];
    if (!original) throw new Error("Expected the original signed record.");
    staleRelay.events.push(original);
    expect((await restored.backup.import(archive.data as Backup)).error).toBeNull();
    expect((await restored.from("todos")).data).toEqual([]);
  });
  it("rejects stale page versions from one relay when another relay has a newer address", async () => {
    const { client, transport } = fixture();
    const old = await alice.signEvent(
      encodeRecord("test-app", "todos", "one", { title: "old", done: false }, 100, 100),
    );
    const newest = await alice.signEvent(
      encodeRecord("test-app", "todos", "one", { title: "new", done: true }, 100, 200),
    );
    transport.events.push(old, newest);
    const cursor = encodeURIComponent(
      JSON.stringify({
        namespace: "test-app",
        table: "todos",
        timestamp: 150,
        eventId: "f".repeat(64),
      }),
    );
    const page = await client.from("todos").page(10, { cursor });
    expect(page.error).toBeNull();
    expect(page.data).toEqual([]);
    expect(
      transport.requests.some(
        (filters) => filters[0]?.["#d"]?.length && filters[0]?.until === undefined,
      ),
    ).toBe(true);
  });
});
