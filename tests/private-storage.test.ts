import { verifyEvent } from "nostr-tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NostrbaseClient } from "../src/client";
import { NostrbasePrivateTables } from "../src/private";
import { encodeRecord, recordIdentifier, scopeTag } from "../src/protocol";
import { NostrbaseStorage } from "../src/storage";
import type { ChangePayload, NostrEvent } from "../src/types";
import type { TestDB } from "./helpers";
import { alice, bob, setup } from "./helpers";

const clients: NostrbaseClient<TestDB>[] = [];
function fixture(options: Parameters<typeof setup>[0] = {}) {
  const result = setup(options);
  clients.push(result.client);
  return { ...result, privateTables: new NostrbasePrivateTables(result.client) };
}
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  vi.restoreAllMocks();
});

describe("private personal tables", () => {
  it("encrypts real NIP-44 records and keeps indexes and persistent events free of plaintext", async () => {
    const { client, transport, privateTables } = fixture();
    const result = await privateTables
      .from("todos")
      .insert({ id: "secret", title: "unshared secret", done: false })
      .select();
    expect(result.error).toBeNull();
    expect(result.data?.[0]?.title).toBe("unshared secret");
    const event = transport.published[0];
    if (!event) throw new Error("Expected a published event.");
    expect(verifyEvent(event)).toBe(true);
    expect(event.content).not.toContain("unshared secret");
    expect(event.tags).toEqual([
      ["d", recordIdentifier("test-app", "private:todos", "secret")],
      ["t", scopeTag("test-app", "private:todos")],
      ["encryption", "nip44-self"],
    ]);
    expect(JSON.stringify(client.eventStore.getByFilters({ kinds: [30078] }))).not.toContain(
      "unshared secret",
    );
    expect(
      JSON.parse(await alice.nip44.decrypt(await alice.getPublicKey(), event.content)).data.title,
    ).toBe("unshared secret");
    expect((await privateTables.from("todos").select("id,title").eq("done", false)).data).toEqual([
      { id: "secret", title: "unshared secret" },
    ]);
    expect((await client.from("todos").select()).data).toEqual([]);
  });
  it("supports own updates/deletions and preserves public records at the same table/id", async () => {
    const { client, privateTables } = fixture();
    await client.from("todos").insert({ id: "same", title: "public", done: false });
    await privateTables.from("todos").insert({ id: "same", title: "private", done: false });
    expect(
      (await privateTables.from("todos").insert({ id: "same", title: "duplicate", done: false }))
        .error?.code,
    ).toBe("CONFLICT");
    const updated = await privateTables
      .from("todos")
      .update({ done: true })
      .eq("id", "same")
      .select()
      .single();
    expect(updated.data?.done).toBe(true);
    const replaced = await privateTables
      .from("todos")
      .upsert({ id: "same", title: "new", done: false })
      .select()
      .single();
    expect(replaced.data?.title).toBe("new");
    expect((await privateTables.from("todos").delete().eq("id", "same")).count).toBe(1);
    expect((await privateTables.from("todos").select()).data).toEqual([]);
    expect((await client.from("todos").select().single()).data?.title).toBe("public");
    expect(
      (
        await privateTables
          .from("todos")
          .insert({ id: "same", title: "recreated", done: false })
          .select()
      ).error,
    ).toBeNull();
    expect((await privateTables.from("todos").select().single()).data?.title).toBe("recreated");
  });
  it("rejects foreign author access, missing encryption, malformed ciphertext and wrong routes", async () => {
    const { client, transport, privateTables } = fixture();
    expect((await privateTables.from("todos").author(await bob.getPublicKey())).error?.code).toBe(
      "PERMISSION_DENIED",
    );
    await privateTables.from("todos").insert({ id: "a", title: "hidden", done: false });
    await client.auth.signInWithSigner(bob);
    expect((await privateTables.from("todos").select()).data).toEqual([]);
    await client.auth.signInWithSigner(alice);
    const plain = encodeRecord(
      "test-app",
      "todos",
      "different",
      { title: "forged", done: false },
      1,
      1,
    );
    transport.events.push(
      await alice.signEvent({
        ...plain,
        content: await alice.nip44.encrypt(await alice.getPublicKey(), plain.content),
        tags: [
          ["d", recordIdentifier("test-app", "private:todos", "wrong")],
          ["t", scopeTag("test-app", "private:todos")],
          ["encryption", "nip44-self"],
        ],
      }),
    );
    transport.events.push(
      await alice.signEvent({
        ...plain,
        content: "bad ciphertext",
        tags: [
          ["d", recordIdentifier("test-app", "private:todos", "bad")],
          ["t", scopeTag("test-app", "private:todos")],
          ["encryption", "nip44-self"],
        ],
      }),
    );
    expect((await privateTables.from("todos").select()).data?.map((row) => row.id)).toEqual(["a"]);
    await client.auth.signInWithSigner({
      getPublicKey: () => alice.getPublicKey(),
      signEvent: (event) => alice.signEvent(event),
    });
    expect((await privateTables.from("todos").select()).error?.code).toBe("AUTH_FAILED");
  });
  it("exports only ciphertext, restores private backups, and queues encrypted signed writes explicitly", async () => {
    const { client, transport, privateTables } = fixture();
    transport.readFailure = true;
    const queued = await privateTables
      .from("todos")
      .insert({ id: "queued", title: "queue-secret", done: false })
      .queue()
      .select();
    expect(queued.error).toBeNull();
    expect(queued.meta?.queued).toBe(true);
    expect(transport.published).toHaveLength(0);
    const pending = await client.offline.list();
    expect(pending).toHaveLength(1);
    expect(JSON.stringify(pending)).not.toContain("queue-secret");
    expect((await privateTables.from("todos").local().select()).data?.[0]?.title).toBe(
      "queue-secret",
    );
    const archive = await client.backup.export();
    expect(JSON.stringify(archive.data)).not.toContain("queue-secret");
    const restored = fixture();
    expect((await restored.client.backup.import(JSON.stringify(archive.data))).error).toBeNull();
    expect((await restored.privateTables.from("todos").local().single()).data?.title).toBe(
      "queue-secret",
    );
    transport.readFailure = false;
    expect((await client.offline.flush()).error).toBeNull();
    expect(transport.published).toHaveLength(1);
  });
  it("honors external NIP-09 deletes without scope tags and never restores deleted rows from backup", async () => {
    const { transport, privateTables } = fixture();
    await privateTables.from("todos").insert({ id: "delete", title: "gone", done: false });
    const record = transport.published[0];
    if (!record) throw new Error("Expected record.");
    const deleted = await alice.signEvent({
      kind: 5,
      created_at: record.created_at + 1,
      content: "",
      tags: [
        ["e", record.id],
        ["a", `30078:${record.pubkey}:${record.tags[0]?.[1]}`],
      ],
    });
    transport.events.push(deleted);
    expect((await privateTables.from("todos").select()).data).toEqual([]);
    const backup = {
      format: "nostrbase-backup" as const,
      version: 1 as const,
      namespace: "test-app",
      exportedAt: Date.now(),
      events: [record, deleted],
    };
    const restored = fixture();
    await restored.client.backup.import(backup);
    expect((await restored.privateTables.from("todos").local().select()).data).toEqual([]);
    expect(
      (await privateTables.from("todos").insert({ id: "delete", title: "back", done: false }))
        .error,
    ).toBeNull();
    expect((await privateTables.from("todos").select().single()).data?.title).toBe("back");
  });
  it("supports private cursor pages, local search, and accurate partial write receipts", async () => {
    const { privateTables } = fixture();
    await privateTables.from("todos").insert([
      { id: "a", title: "search alpha", done: false },
      { id: "b", title: "search beta", done: true },
    ]);
    const first = await privateTables.from("todos").local().page(1);
    expect(first.data).toHaveLength(1);
    const second = await privateTables
      .from("todos")
      .local()
      .page(1, { cursor: first.meta?.nextCursor });
    expect(second.data).toHaveLength(1);
    expect(second.data?.[0]?.id).not.toBe(first.data?.[0]?.id);
    expect(
      (await privateTables.from("todos").local().textSearch("title", "alpha")).data?.[0]?.id,
    ).toBe("a");
    expect(
      (await privateTables.from("projects").local().page(1, { cursor: first.meta?.nextCursor }))
        .error?.code,
    ).toBe("INVALID_QUERY");
    const partial = fixture({ relays: ["wss://one.test", "wss://two.test"], minWriteAcks: 2 });
    partial.transport.publishStatuses = [
      { url: "wss://one.test", ok: true },
      { url: "wss://two.test", ok: false },
    ];
    const result = await partial.privateTables
      .from("todos")
      .insert({ title: "partial", done: false })
      .select();
    expect(result.error?.code).toBe("PUBLISH_FAILED");
    expect(result.count).toBe(1);
    expect(result.data?.[0]?.title).toBe("partial");
    expect(result.meta?.partial).toBe(true);
  });
  it.each(["signout", "account-switch"] as const)(
    "withholds committed plaintext after %s during a delayed publish",
    async (action) => {
      const { client, transport, privateTables } = fixture();
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reached: () => void = () => {};
      const publishing = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const publish = transport.publish.bind(transport);
      vi.spyOn(transport, "publish").mockImplementation(async (relays, event) => {
        const receipts = await publish(relays, event);
        if (transport.published.length === 2) {
          reached();
          await gate;
        }
        return receipts;
      });
      const resultPromise = Promise.resolve(
        privateTables
          .from("todos")
          .insert([
            { id: "first", title: "first-secret", done: false },
            { id: "second", title: "second-secret", done: false },
          ])
          .select(),
      );
      await publishing;
      if (action === "signout") await client.auth.signOut();
      else await client.auth.signInWithSigner(bob);
      release();
      const result = await resultPromise;
      expect(result.error?.code).toBe(action === "signout" ? "AUTH_REQUIRED" : "AUTH_FAILED");
      expect(result.data).toEqual([]);
      expect(result.meta?.receipts).toHaveLength(2);
      expect(result.meta?.partial).toBe(true);
      expect(JSON.stringify(result)).not.toContain("first-secret");
      expect(JSON.stringify(result)).not.toContain("second-secret");
    },
  );
  it("does not emit older private events when query or sync already cached a newer version", async () => {
    const { client, transport, privateTables } = fixture();
    const changes: ChangePayload<TestDB["todos"]>[] = [];
    const subscription = await privateTables.subscribe("todos", (change) => changes.push(change));
    const pubkey = await alice.getPublicKey();
    async function event(title: string, timestamp: number) {
      const plain = encodeRecord(
        "test-app",
        "todos",
        "shared",
        { title, done: false },
        1,
        timestamp,
      );
      return alice.signEvent({
        ...plain,
        content: await alice.nip44.encrypt(pubkey, plain.content),
        tags: [
          ["d", recordIdentifier("test-app", "private:todos", "shared")],
          ["t", scopeTag("test-app", "private:todos")],
          ["encryption", "nip44-self"],
        ],
      });
    }
    const older = await event("older", 2);
    const newer = await event("newer", 3);
    client.ingest(newer);
    transport.live.next(older);
    transport.live.next(newer);
    await vi.waitFor(() => expect(changes).toHaveLength(1));
    expect(changes[0]?.new?.title).toBe("newer");
    subscription.unsubscribe();
  });
  it("does not emit a stale deletion for an older event when a newer private record is cached", async () => {
    const { client, transport, privateTables } = fixture();
    await privateTables.from("todos").insert({ id: "stale-delete", title: "old", done: false });
    const older = transport.published[0];
    if (!older) throw new Error("Expected old event.");
    const changes: ChangePayload<TestDB["todos"]>[] = [];
    const subscription = await privateTables.subscribe("todos", (change) => changes.push(change));
    const pubkey = await alice.getPublicKey();
    const plain = encodeRecord(
      "test-app",
      "todos",
      "stale-delete",
      { title: "latest", done: false },
      older.created_at,
      older.created_at + 2,
    );
    const newer = await alice.signEvent({
      ...plain,
      content: await alice.nip44.encrypt(pubkey, plain.content),
      tags: older.tags,
    });
    client.ingest(newer);
    transport.live.next(
      await alice.signEvent({
        kind: 5,
        created_at: older.created_at + 1,
        content: "",
        tags: [["e", older.id]],
      }),
    );
    transport.live.next(newer);
    await vi.waitFor(() => expect(changes).toHaveLength(1));
    expect(changes[0]?.eventType).toBe("UPDATE");
    expect(changes[0]?.new?.title).toBe("latest");
    subscription.unsubscribe();
  });
  it("rechecks the shared store after a delayed decrypt before emitting a private change", async () => {
    const { client, transport, privateTables } = fixture();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const decrypt = vi.fn(async (pubkey: string, ciphertext: string) => {
      await gate;
      return alice.nip44.decrypt(pubkey, ciphertext);
    });
    await client.auth.signInWithSigner({
      getPublicKey: () => alice.getPublicKey(),
      signEvent: (event) => alice.signEvent(event),
      nip44: { encrypt: (pubkey, content) => alice.nip44.encrypt(pubkey, content), decrypt },
    });
    const changes: ChangePayload<TestDB["todos"]>[] = [];
    const subscription = await privateTables.subscribe("todos", (change) => changes.push(change));
    const pubkey = await alice.getPublicKey();
    async function event(title: string, timestamp: number) {
      const plain = encodeRecord("test-app", "todos", "race", { title, done: false }, 1, timestamp);
      return alice.signEvent({
        ...plain,
        content: await alice.nip44.encrypt(pubkey, plain.content),
        tags: [
          ["d", recordIdentifier("test-app", "private:todos", "race")],
          ["t", scopeTag("test-app", "private:todos")],
          ["encryption", "nip44-self"],
        ],
      });
    }
    const older = await event("older", 2);
    const newer = await event("newer", 3);
    transport.live.next(older);
    await vi.waitFor(() => expect(decrypt).toHaveBeenCalledTimes(1));
    client.ingest(newer);
    release();
    transport.live.next(newer);
    await vi.waitFor(() => expect(changes).toHaveLength(1));
    expect(changes[0]?.new?.title).toBe("newer");
    subscription.unsubscribe();
  });
  it("emits queued private writes locally and does not duplicate changes when a relay later echoes them", async () => {
    const { client, transport, privateTables } = fixture();
    const changes: ChangePayload<TestDB["todos"]>[] = [];
    const subscription = await privateTables.subscribe("todos", (change) => changes.push(change));
    transport.readFailure = true;
    await privateTables
      .from("todos")
      .insert({ id: "local-live", title: "queued", done: false })
      .queue();
    await vi.waitFor(() => expect(changes).toHaveLength(1));
    expect(transport.published).toHaveLength(0);
    transport.readFailure = false;
    await client.offline.flush();
    await privateTables.from("todos").update({ title: "updated" }).eq("id", "local-live").queue();
    await vi.waitFor(() => expect(changes).toHaveLength(2));
    await privateTables.from("todos").delete().eq("id", "local-live").queue();
    await vi.waitFor(() => expect(changes).toHaveLength(3));
    expect(changes.map((change) => change.eventType)).toEqual(["INSERT", "UPDATE", "DELETE"]);
    subscription.unsubscribe();
  });
  it("isolates observer errors and releases private subscriptions on transport failure", async () => {
    const { transport, privateTables } = fixture();
    const callback = vi.fn(() => {
      if (callback.mock.calls.length === 1) throw new Error("observer");
    });
    const onError = vi.fn(() => {
      throw new Error("error observer");
    });
    await privateTables.subscribe("todos", callback, onError);
    await privateTables.from("todos").insert({ title: "one", done: false }).queue();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    await privateTables.from("todos").insert({ title: "two", done: false }).queue();
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(2));
    transport.live.error(new Error("disconnected"));
    expect(onError).toHaveBeenCalledTimes(2);
    expect(transport.activeSubscriptions).toBe(0);
    await privateTables.from("todos").insert({ title: "three", done: false }).queue();
    expect(callback).toHaveBeenCalledTimes(2);
  });
  it("resolves cursor candidates at their latest address before returning private records", async () => {
    const { client, transport, privateTables } = fixture();
    const pubkey = await alice.getPublicKey();
    async function event(title: string, timestamp: number) {
      const plain = encodeRecord(
        "test-app",
        "todos",
        "cursor-current",
        { title, done: false },
        50,
        timestamp,
      );
      return alice.signEvent({
        ...plain,
        content: await alice.nip44.encrypt(pubkey, plain.content),
        tags: [
          ["d", recordIdentifier("test-app", "private:todos", "cursor-current")],
          ["t", scopeTag("test-app", "private:todos")],
          ["encryption", "nip44-self"],
        ],
      });
    }
    transport.events.push(await event("historical", 100), await event("current", 200));
    const cursor = encodeURIComponent(
      JSON.stringify({
        namespace: "test-app",
        table: "todos",
        timestamp: 150,
        eventId: "f".repeat(64),
      }),
    );
    const result = await privateTables.from("todos").page(10, { cursor });
    expect(result.error).toBeNull();
    expect(result.data).toEqual([]);
    expect(
      transport.requests.flat().some((filter) => filter["#d"] && filter.until === undefined),
    ).toBe(true);
    expect((await privateTables.from("todos").local().single()).data?.title).toBe("current");
    expect(client.eventStore.getByFilters({ kinds: [30078] })).toHaveLength(1);
  });
  it("stops a subscription if the user signs out while cache decryption is pending", async () => {
    const { client, privateTables, transport } = fixture();
    await privateTables.from("todos").insert({ title: "private", done: false });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const decrypt = vi.fn(async (pubkey: string, ciphertext: string) => {
      await gate;
      return alice.nip44.decrypt(pubkey, ciphertext);
    });
    await client.auth.signInWithSigner({
      getPublicKey: () => alice.getPublicKey(),
      signEvent: (event) => alice.signEvent(event),
      nip44: { encrypt: (pubkey, content) => alice.nip44.encrypt(pubkey, content), decrypt },
    });
    const subscription = privateTables.subscribe("todos", () => {}).catch((error) => error);
    await vi.waitFor(() => expect(decrypt).toHaveBeenCalledTimes(1));
    expect(transport.activeSubscriptions).toBe(1);
    await client.auth.signOut();
    expect(transport.activeSubscriptions).toBe(0);
    release();
    expect((await subscription).code).toBe("AUTH_REQUIRED");
  });
  it("emits decrypted live changes and releases state and subscriptions on sign-out", async () => {
    const { client, transport, privateTables } = fixture();
    const changes: ChangePayload<TestDB["todos"]>[] = [];
    const sub = await privateTables.subscribe("todos", (change) => changes.push(change));
    await privateTables.from("todos").insert({ id: "live", title: "first", done: false });
    await vi.waitFor(() => expect(changes).toHaveLength(1));
    await privateTables.from("todos").update({ title: "second" }).eq("id", "live");
    await vi.waitFor(() => expect(changes).toHaveLength(2));
    await privateTables.from("todos").delete().eq("id", "live");
    await vi.waitFor(() => expect(changes).toHaveLength(3));
    expect(changes.map((change) => change.eventType)).toEqual(["INSERT", "UPDATE", "DELETE"]);
    expect(changes[1]?.new?.title).toBe("second");
    await client.auth.signOut();
    expect(transport.activeSubscriptions).toBe(0);
    sub.unsubscribe();
    privateTables.close();
  });
});

const hello = new Blob(["hello"], { type: "text/plain" });
const helloHash = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const otherHash = "a".repeat(64);
const desc = {
  url: `https://files.test/${helloHash}.txt`,
  sha256: helloHash,
  size: 5,
  type: "text/plain",
  uploaded: 10,
};
function authEvent(init: RequestInit): NostrEvent {
  const header = new Headers(init.headers).get("Authorization");
  if (!header) throw new Error("Expected Authorization header.");
  expect(header).toMatch(/^Nostr [A-Za-z0-9_-]+$/);
  const encoded = header.slice(6).replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
}
describe("Blossom storage", () => {
  it("uploads binary bytes with hash scoped auth and verifies descriptor", async () => {
    const { client } = fixture();
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      expect(url).toBe("https://files.test/upload");
      expect(init?.method).toBe("PUT");
      expect(init?.body).toBe(hello);
      expect(new Headers(init?.headers).get("X-SHA-256")).toBe(helloHash);
      expect(init?.redirect).toBe("error");
      const event = authEvent(init ?? {});
      expect(verifyEvent(event)).toBe(true);
      expect(event.kind).toBe(24242);
      expect(event.tags).toContainEqual(["t", "upload"]);
      expect(event.tags).toContainEqual(["server", "files.test"]);
      expect(event.tags).toContainEqual(["x", helloHash]);
      return Response.json(desc, { status: 201 });
    });
    const files = new NostrbaseStorage(client, { fetch: fetcher }).from("https://files.test");
    expect((await files.upload("notes/hello.txt", hello)).data).toEqual({
      ...desc,
      name: "notes/hello.txt",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(() => new NostrbaseStorage(client).from("https://files.test/bucket")).toThrow(/origin/);
    expect(() => new NostrbaseStorage(client).from("https://user:pass@files.test")).toThrow(
      /origin/,
    );
  });
  it("rejects altered hashes and invalid descriptor URLs", async () => {
    const { client } = fixture();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ...desc, sha256: otherHash }))
      .mockResolvedValueOnce(Response.json({ ...desc, url: "javascript:alert(1)" }))
      .mockResolvedValueOnce(new Response("modified"));
    const files = new NostrbaseStorage(client, { fetch: fetcher }).from("https://files.test");
    expect((await files.upload("test.txt", hello)).error?.code).toBe("INVALID_RECORD");
    expect((await files.upload("test.txt", hello)).error?.code).toBe("INVALID_RECORD");
    expect((await files.download(helloHash)).error?.code).toBe("INVALID_RECORD");
  });
  it("downloads verified public bytes without a signer", async () => {
    const { client } = fixture({ signer: undefined });
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      expect(url).toBe(`https://files.test/${helloHash}`);
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      return new Response(hello);
    });
    const files = new NostrbaseStorage(client, { fetch: fetcher }).from("https://files.test");
    expect(await (await files.download(helloHash)).data?.text()).toBe("hello");
    expect((await files.download("../bad")).error?.code).toBe("INVALID_QUERY");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("returns precise partial deletion outcomes and uses independent scoped tokens", async () => {
    const { client } = fixture();
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      const event = authEvent(init ?? {});
      expect(event.tags).toContainEqual(["t", "delete"]);
      expect(event.tags).toContainEqual(["x", String(url).split("/").at(-1)]);
      return new Response(null, { status: String(url).endsWith(otherHash) ? 403 : 204 });
    });
    const files = new NostrbaseStorage(client, { fetch: fetcher }).from("https://files.test");
    const result = await files.remove([helloHash, otherHash]);
    expect(result.count).toBe(1);
    expect(result.error?.code).toBe("PUBLISH_FAILED");
    expect(result.data?.map((item) => item.ok)).toEqual([true, false]);
    expect(result.data?.[1]?.error?.code).toBe("PERMISSION_DENIED");
    expect((await files.remove([helloHash, "invalid"])).error?.code).toBe("INVALID_QUERY");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("lists with cursor/limit and validates every descriptor", async () => {
    const { client } = fixture();
    const pubkey = await alice.getPublicKey();
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      expect(url).toBe(`https://files.test/list/${pubkey}?cursor=${helloHash}&limit=5`);
      expect(authEvent(init ?? {}).tags).toContainEqual(["t", "list"]);
      return Response.json([desc]);
    });
    const files = new NostrbaseStorage(client, { fetch: fetcher }).from("https://files.test");
    expect((await files.list(undefined, { cursor: helloHash, limit: 5 })).data).toEqual([desc]);
    expect((await files.list(pubkey, { limit: 0 })).error?.code).toBe("INVALID_QUERY");
  });
  it("supports cancellation and timeout without swallowing errors", async () => {
    const { client } = fixture();
    const fetcher = vi.fn<typeof fetch>(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
            once: true,
          });
        }),
    );
    const files = new NostrbaseStorage(client, { fetch: fetcher, timeout: 10 }).from(
      "https://files.test",
    );
    expect((await files.download(helloHash)).error?.code).toBe("ABORTED");
    expect((await files.download(helloHash, { signal: AbortSignal.abort() })).error?.code).toBe(
      "ABORTED",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
