import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { EventStore } from "applesauce-core";
import { RelayPool } from "applesauce-relay";
import { buildStorageVector } from "applesauce-relay/negentropy";
import { IDBFactory } from "fake-indexeddb";
import { matchFilter } from "nostr-tools";
import { BehaviorSubject } from "rxjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { Negentropy } from "../node_modules/applesauce-relay/dist/lib/negentropy.js";
import { NostrbaseOffline } from "../src/offline";
import {
  IndexedDBPersistenceAdapter,
  MemoryPersistenceAdapter,
  NostrbasePersistence,
} from "../src/persistence";
import { addressOf, encodeRecord, scopeTag } from "../src/protocol";
import { NostrbaseSync } from "../src/sync";
import { ApplesauceTransport } from "../src/transport";
import type { Filter, NostrEvent, Result, Session } from "../src/types";
import { alice, bob, MemoryTransport } from "./helpers";

const namespace = "test-app";
const relayUrl = "wss://relay.test";
const disposals: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
});
async function event(id = "one", time = 10): Promise<NostrEvent> {
  return alice.signEvent(
    encodeRecord(namespace, "todos", id, { title: id, done: false }, time, time),
  );
}
function queueHost(transport = new MemoryTransport()) {
  let user: Session | null = null;
  const store = new EventStore();
  disposals.push(() => store.dispose());
  const controller = new AbortController();
  const host = {
    namespace,
    minWriteAcks: 1,
    auth: { getSession: async (): Promise<Result<Session>> => ({ data: user, error: null }) },
    ready: async () => {},
    assertOpen: () => {},
    signal: (signal?: AbortSignal) =>
      signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    ingest: (value: NostrEvent) => store.add(value) !== null,
    publish: async (value: NostrEvent, _signal?: AbortSignal) => ({
      id: value.id,
      eventId: value.id,
      relays: await transport.publish([relayUrl], value),
    }),
  };
  return {
    host,
    store,
    transport,
    signIn: async (signer = alice) => {
      const pubkey = await signer.getPublicKey();
      user = { user: { id: pubkey, pubkey } };
    },
    signOut: () => {
      user = null;
    },
  };
}
function syncHost(transport = new MemoryTransport()) {
  const store = new EventStore();
  const connected = new BehaviorSubject(false);
  const negentropy = vi.fn(
    async (
      _local: NostrEvent[],
      _filter: Filter,
      _reconcile: (have: string[], need: string[]) => Promise<void>,
      _options: { signal?: AbortSignal },
    ): Promise<boolean> => {
      throw new Error("Relay does not support NIP-77");
    },
  );
  const relay = { negentropy, connected$: connected };
  const pool = { relay: () => relay } as unknown as RelayPool;
  const controller = new AbortController();
  const host = {
    namespace,
    relays: [relayUrl],
    pool,
    eventStore: store,
    transport,
    timeout: 100,
    ready: async () => {},
    assertOpen: () => {},
    signal: (signal?: AbortSignal) =>
      signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
    ingest: (value: NostrEvent) => store.add(value) !== null,
  };
  disposals.push(() => {
    controller.abort();
    connected.complete();
    store.dispose();
  });
  return { host, negentropy, connected, transport, store };
}

describe("durable event persistence", () => {
  it("isolates namespaces and commits queue and cache in separate IndexedDB stores", async () => {
    const factory = new IDBFactory();
    let adapter = new IndexedDBPersistenceAdapter("cache-test", factory);
    const signed = await event();
    await adapter.putEvents([signed], "app-a");
    await adapter.putQueue({ event: signed, queuedAt: 1, attempts: 0, relays: [] }, "app-a");
    await adapter.putEvents([await event("two")], "app-b");
    await adapter.close();
    adapter = new IndexedDBPersistenceAdapter("cache-test", factory);
    expect((await adapter.loadEvents("app-a")).map((value) => value.id)).toEqual([signed.id]);
    expect(await adapter.loadQueue("app-a")).toHaveLength(1);
    expect(await adapter.loadQueue("app-b")).toEqual([]);
    await adapter.removeQueue(signed.id, "app-a");
    expect(await adapter.loadQueue("app-a")).toEqual([]);
    expect(await adapter.loadEvents("app-a")).toHaveLength(1);
    await adapter.close();
  });
  it("replays tombstones first and ignores corrupted cache signatures", async () => {
    const adapter = new MemoryPersistenceAdapter();
    const signed = await event();
    const valid = await event("valid");
    const deletion = await alice.signEvent({
      kind: 5,
      created_at: 11,
      content: "",
      tags: [["a", addressOf(valid)]],
    });
    await adapter.putEvents(
      [signed, { ...signed, content: "tampered" }, valid, deletion],
      namespace,
    );
    // A tampered entry with the same id replaces the original. Only verified entries load, with the tombstone first.
    const ingested: NostrEvent[] = [];
    const persistence = new NostrbasePersistence(
      {
        namespace,
        ingest: (value) => {
          ingested.push(value);
          return true;
        },
      },
      { adapter },
    );
    await persistence.ready();
    expect(ingested.map((value) => value.id)).toEqual([deletion.id, valid.id]);
    await persistence.close();
  });
  it("stores ciphertext unchanged, batches writes, and flushes before close", async () => {
    const adapter = new MemoryPersistenceAdapter();
    const put = vi.spyOn(adapter, "putEvents");
    const persistence = new NostrbasePersistence(
      { namespace, ingest: () => true },
      { adapter, batchSize: 2, flushInterval: 60000 },
    );
    await persistence.ready();
    const cipher = await alice.signEvent({
      kind: 30078,
      created_at: 10,
      tags: [["d", "cipher"]],
      content: "opaque-nip44-ciphertext",
    });
    persistence.record(
      await alice.signEvent({ kind: 20000, created_at: 10, content: "live", tags: [] }),
    );
    persistence.record(cipher);
    persistence.record(await event("second"));
    persistence.record(await event("third"));
    await persistence.close();
    expect(
      (await adapter.loadEvents(namespace)).find((value) => value.id === cipher.id)?.content,
    ).toBe(cipher.content);
    expect(put.mock.calls.every(([batch]) => batch.length <= 2)).toBe(true);
    expect(await adapter.loadEvents(namespace)).toHaveLength(3);
  });
  it("retains pending events after a failed commit so explicit flush can retry", async () => {
    const adapter = new MemoryPersistenceAdapter();
    vi.spyOn(adapter, "putEvents").mockRejectedValueOnce(new Error("storage full"));
    const persistence = new NostrbasePersistence(
      { namespace, ingest: () => true },
      { adapter, flushInterval: 60000 },
    );
    await persistence.ready();
    persistence.record(await event());
    await expect(persistence.flush()).rejects.toThrow("storage full");
    await persistence.flush();
    expect(await adapter.loadEvents(namespace)).toHaveLength(1);
    await persistence.close();
  });
});

describe("signed offline queue", () => {
  it("persists first, survives restart, restores cache, and replays the exact signed event", async () => {
    const factory = new IDBFactory();
    const adapter = new IndexedDBPersistenceAdapter("queue-test", factory);
    const first = queueHost();
    await first.signIn();
    const queue = new NostrbaseOffline(first.host, { adapter });
    const signed = await event();
    const result = await queue.enqueueSigned(signed);
    expect(result.data).toMatchObject({ queued: true, persisted: true, eventId: signed.id });
    expect(first.transport.published).toEqual([]);
    await queue.close();
    const next = queueHost();
    await next.signIn();
    const second = new NostrbaseOffline(next.host, {
      adapter: new IndexedDBPersistenceAdapter("queue-test", factory),
    });
    await second.ready();
    expect(next.store.hasEvent(signed.id)).toBe(true);
    expect((await second.flush()).error).toBeNull();
    expect(next.transport.published).toEqual([structuredClone(signed)]);
    expect(await second.list()).toEqual([]);
    await second.close();
  });
  it("checks ownership, rejects invalid and ephemeral events, and never publishes another account's queue", async () => {
    const setup = queueHost();
    await setup.signIn();
    const queue = new NostrbaseOffline(setup.host);
    const signed = await event();
    expect((await queue.enqueueSigned({ ...signed, content: "tampered" })).error?.code).toBe(
      "INVALID_RECORD",
    );
    expect(
      (
        await queue.enqueueSigned(
          await bob.signEvent({ kind: 1, created_at: 10, tags: [], content: "other" }),
        )
      ).error?.code,
    ).toBe("PERMISSION_DENIED");
    expect(
      (
        await queue.enqueueSigned(
          await alice.signEvent({ kind: 20000, created_at: 10, tags: [], content: "broadcast" }),
        )
      ).error?.code,
    ).toBe("INVALID_RECORD");
    await queue.enqueueSigned(signed);
    await setup.signIn(bob);
    expect((await queue.flush()).data).toEqual([]);
    expect(setup.transport.published).toEqual([]);
    await expect(queue.remove(signed.id)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    setup.signOut();
    expect((await queue.flush()).error?.code).toBe("AUTH_REQUIRED");
    await queue.close();
  });
  it("keeps failed writes with receipts, deduplicates queued events, and retries without signing", async () => {
    const setup = queueHost();
    await setup.signIn();
    setup.transport.publishStatuses = [{ url: relayUrl, ok: false, message: "blocked" }];
    const queue = new NostrbaseOffline(setup.host);
    const signed = await event();
    await queue.enqueueSigned(signed);
    await queue.enqueueSigned(signed);
    expect(await queue.list()).toHaveLength(1);
    expect((await queue.flush()).error?.code).toBe("PUBLISH_FAILED");
    expect((await queue.list())[0]).toMatchObject({
      attempts: 1,
      relays: [{ message: "blocked" }],
    });
    setup.transport.publishStatuses = [{ url: relayUrl, ok: true }];
    expect((await queue.flush()).error).toBeNull();
    expect(setup.transport.published).toEqual([structuredClone(signed), structuredClone(signed)]);
    expect(await queue.list()).toEqual([]);
    await queue.close();
  });
  it("ignores corrupt and ephemeral persisted queue entries during hydration and reports replay failure", async () => {
    const setup = queueHost();
    await setup.signIn();
    const adapter = new MemoryPersistenceAdapter();
    const signed = await event();
    const ephemeral = await alice.signEvent({
      kind: 20000,
      created_at: 10,
      tags: [],
      content: "expired broadcast",
    });
    await adapter.putQueue(
      { event: { ...signed, content: "tampered" }, queuedAt: 1, attempts: 0, relays: [] },
      namespace,
    );
    await adapter.putQueue({ event: ephemeral, queuedAt: 2, attempts: 0, relays: [] }, namespace);
    const queue = new NostrbaseOffline(setup.host, { adapter });
    await queue.ready();
    expect(setup.store.hasEvent(signed.id)).toBe(false);
    expect(setup.store.hasEvent(ephemeral.id)).toBe(false);
    expect(await queue.list()).toEqual([]);
    expect((await queue.flush()).error?.code).toBe("INVALID_RECORD");
    expect(setup.transport.published).toEqual([]);
    await queue.close();
  });
  it("preserves enqueue order when the clock has equal milliseconds", async () => {
    const setup = queueHost();
    await setup.signIn();
    const queue = new NostrbaseOffline(setup.host);
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      const first = await event("first", 10);
      const second = await event("second", 11);
      await queue.enqueueSigned(first);
      await queue.enqueueSigned(second);
      const entries = await queue.list();
      expect(entries.map((entry) => entry.event.id)).toEqual([first.id, second.id]);
      expect(entries.map((entry) => entry.queuedAt)).toEqual([1000, 1001]);
      await queue.flush();
      expect(setup.transport.published.map((value) => value.id)).toEqual([first.id, second.id]);
    } finally {
      clock.mockRestore();
      await queue.close();
    }
  });
  it("hydrates queued deletion tombstones before their targeted records", async () => {
    const setup = queueHost();
    await setup.signIn();
    const adapter = new MemoryPersistenceAdapter();
    const signed = await event();
    const deletion = await alice.signEvent({
      kind: 5,
      created_at: 11,
      content: "",
      tags: [["e", signed.id]],
    });
    await adapter.putQueue({ event: signed, queuedAt: 1, attempts: 0, relays: [] }, namespace);
    await adapter.putQueue({ event: deletion, queuedAt: 2, attempts: 0, relays: [] }, namespace);
    const ingest = vi.spyOn(setup.host, "ingest");
    const queue = new NostrbaseOffline(setup.host, { adapter });
    await queue.ready();
    expect(ingest.mock.calls.map(([value]) => value.id)).toEqual([deletion.id, signed.id]);
    await queue.close();
  });
  it("stops replay if the active account changes while committing an attempt", async () => {
    const setup = queueHost();
    await setup.signIn();
    const adapter = new MemoryPersistenceAdapter();
    const queue = new NostrbaseOffline(setup.host, { adapter });
    await queue.enqueueSigned(await event());
    const original = adapter.putQueue.bind(adapter);
    vi.spyOn(adapter, "putQueue").mockImplementation(async (...args) => {
      await original(...args);
      await setup.signIn(bob);
    });
    expect((await queue.flush()).error?.code).toBe("AUTH_FAILED");
    expect(setup.transport.published).toEqual([]);
    expect(await queue.list()).toHaveLength(1);
    await queue.close();
  });
  it("supports cancellation and entry removal", async () => {
    const setup = queueHost();
    await setup.signIn();
    const queue = new NostrbaseOffline(setup.host, { maxEntries: 1 });
    const signed = await event();
    await queue.enqueueSigned(signed);
    expect((await queue.enqueueSigned(await event("two"))).error?.code).toBe("CONFLICT");
    const controller = new AbortController();
    controller.abort();
    expect((await queue.flush({ signal: controller.signal })).error?.code).toBe("ABORTED");
    expect(await queue.remove(signed.id)).toBe(true);
    expect(await queue.remove(signed.id)).toBe(false);
    await queue.close();
  });
});

describe("Negentropy recovery", () => {
  it("pulls missing IDs with Applesauce, filters local vectors, and never publishes cached events", async () => {
    const setup = syncHost();
    const local = await event("local");
    const missing = await event("remote");
    const unrelated = await alice.signEvent({
      kind: 1,
      created_at: 10,
      tags: [],
      content: "profile",
    });
    setup.store.add(local);
    setup.store.add(unrelated);
    setup.transport.events.push(missing);
    setup.negentropy.mockImplementation(async (vector, _filter, reconcile) => {
      expect(vector.every((value) => value.kind === 30078)).toBe(true);
      await reconcile([local.id], [missing.id]);
      return true;
    });
    const sync = new NostrbaseSync(setup.host);
    const result = await sync.pull({ kinds: [30078], "#t": [scopeTag(namespace, "todos")] });
    expect(result.error).toBeNull();
    expect(result.meta?.sync[0]?.strategy).toBe("negentropy");
    expect(setup.store.hasEvent(missing.id)).toBe(true);
    expect(setup.transport.published).toEqual([]);
    expect(setup.transport.requests[0]).toEqual([{ ids: [missing.id] }]);
    sync.close();
  });
  it("uses ordinary scoped query recovery for unsupported relays and fetches untagged deletes", async () => {
    const setup = syncHost();
    const signed = await event();
    const deletion = await alice.signEvent({
      kind: 5,
      created_at: 11,
      tags: [["a", addressOf(signed)]],
      content: "",
    });
    setup.transport.events.push(signed, deletion);
    const sync = new NostrbaseSync(setup.host, { tables: ["todos"] });
    const result = await sync.pull();
    expect(result.error).toBeNull();
    expect(result.meta?.sync[0]).toMatchObject({
      strategy: "query",
      fallbackReason: "Relay does not support NIP-77",
    });
    expect(result.data?.some((value) => value.id === deletion.id)).toBe(true);
    expect(setup.store.hasEvent(signed.id)).toBe(false);
    expect(setup.transport.requests[0]).toEqual([
      { kinds: [30078], "#t": [scopeTag(namespace, "todos")] },
    ]);
    sync.close();
  });
  it("rejects forged and out-of-scope events from an ID fetch", async () => {
    const setup = syncHost();
    const signed = await event();
    const foreign = await alice.signEvent({
      kind: 1,
      created_at: 10,
      tags: [],
      content: "out of scope",
    });
    setup.transport.request = vi.fn(async () => ({
      events: [{ ...signed, content: "forged" }, foreign],
      relays: [{ url: relayUrl, ok: true }],
    }));
    setup.negentropy.mockImplementation(async (_local, _filter, reconcile) => {
      await reconcile([], [signed.id]);
      return true;
    });
    const sync = new NostrbaseSync(setup.host);
    const result = await sync.pull({ kinds: [30078] });
    expect(result.data).toEqual([]);
    expect(setup.store.hasEvent(foreign.id)).toBe(false);
    expect(setup.store.hasEvent(signed.id)).toBe(false);
    sync.close();
  });
  it("cancels timed out reconciliation and recovers with a query", async () => {
    const setup = syncHost();
    let negSignal: AbortSignal | undefined;
    setup.negentropy.mockImplementation((_local, _filter, _reconcile, options) => {
      negSignal = options.signal;
      return new Promise<boolean>(() => {});
    });
    setup.transport.events.push(await event());
    const sync = new NostrbaseSync(setup.host, { timeout: 5 });
    const result = await sync.pull({ kinds: [30078] });
    expect(negSignal?.aborted).toBe(true);
    expect(result.error).toBeNull();
    expect(result.meta?.sync[0]?.strategy).toBe("query");
    sync.close();
  });
  it("does not start fallback work after user cancellation", async () => {
    const setup = syncHost();
    const controller = new AbortController();
    setup.negentropy.mockImplementation(async () => {
      controller.abort();
      return false;
    });
    const sync = new NostrbaseSync(setup.host);
    const result = await sync.pull({ kinds: [30078] }, { signal: controller.signal });
    expect(result.error?.code).toBe("ABORTED");
    expect(setup.transport.requests).toEqual([]);
    sync.close();
  });
  it("runs initial and reconnect recovery only when enabled and releases connection observers", async () => {
    const setup = syncHost();
    const sync = new NostrbaseSync(setup.host, {
      tables: ["todos"],
      initial: true,
      reconnect: true,
    });
    const pull = vi.spyOn(sync, "pull");
    sync.start();
    await vi.waitFor(() => expect(pull).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(setup.transport.requests).toHaveLength(2));
    setup.connected.next(true);
    setup.connected.next(false);
    setup.connected.next(true);
    await vi.waitFor(() => expect(pull).toHaveBeenCalledTimes(2));
    sync.close();
    expect(setup.connected.observed).toBe(false);
  });
});

describe("NIP-77 over a real local WebSocket", () => {
  async function wireRelay(events: NostrEvent[], ignoreNegentropy = false) {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const verbs: string[] = [];
    server.on("connection", (socket) => {
      const sessions = new Map<string, Negentropy>();
      socket.on("message", (data) => {
        void (async () => {
          const message = JSON.parse(data.toString());
          const [verb, id] = message as [string, string];
          verbs.push(verb);
          if (verb === "NEG-OPEN") {
            if (ignoreNegentropy) return;
            const filter = message[2] as Filter;
            const storage = buildStorageVector(
              events.filter((value) => matchFilter(filter, value)),
            );
            const negotiation = new Negentropy(storage);
            sessions.set(id, negotiation);
            const [reply] = await negotiation.reconcile<string>(message[3]);
            if (reply) socket.send(JSON.stringify(["NEG-MSG", id, reply]));
          } else if (verb === "NEG-MSG") {
            const session = sessions.get(id);
            if (!session) throw new Error("Unknown negotiation");
            const [reply] = await session.reconcile<string>(message[2]);
            if (reply) socket.send(JSON.stringify(["NEG-MSG", id, reply]));
          } else if (verb === "NEG-CLOSE") sessions.delete(id);
          else if (verb === "REQ") {
            const filters = message.slice(2) as Filter[];
            for (const value of events)
              if (filters.some((filter) => matchFilter(filter, value)))
                socket.send(JSON.stringify(["EVENT", id, value]));
            socket.send(JSON.stringify(["EOSE", id]));
          }
        })().catch(() => socket.close());
      });
    });
    const pool = new RelayPool({
      WebSocket: WebSocket as unknown as NonNullable<
        ConstructorParameters<typeof RelayPool>[0]
      >["WebSocket"],
      keepAlive: 0,
    });
    // This fixture has no HTTP NIP-11 endpoint. Only capability discovery is stubbed.
    vi.spyOn(pool.relay(url), "getSupported").mockResolvedValue([77]);
    const store = new EventStore();
    const controller = new AbortController();
    const host = {
      namespace,
      relays: [url],
      pool,
      eventStore: store,
      transport: new ApplesauceTransport(pool),
      timeout: 1000,
      ready: async () => {},
      assertOpen: () => {},
      signal: (signal?: AbortSignal) =>
        signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      ingest: (value: NostrEvent) => store.add(value) !== null,
    };
    disposals.push(async () => {
      controller.abort();
      pool.close();
      store.dispose();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    return { host, verbs, store };
  }
  it("exchanges NEG-OPEN/NEG-MSG, requests missing events by ID, and closes the negotiation", async () => {
    const signed = await event("wire");
    const node = await wireRelay([signed]);
    const sync = new NostrbaseSync(node.host);
    const result = await sync.pull({ kinds: [30078], "#t": [scopeTag(namespace, "todos")] });
    expect(result.error).toBeNull();
    expect(result.meta?.sync[0]?.strategy).toBe("negentropy");
    expect(node.store.hasEvent(signed.id)).toBe(true);
    await vi.waitFor(() => expect(node.verbs).toContain("NEG-CLOSE"));
    expect(node.verbs).toContain("NEG-OPEN");
    expect(node.verbs).toContain("REQ");
    expect(node.verbs).not.toContain("EVENT");
    sync.close();
  });
  it("sends NEG-CLOSE on timeout and falls back to NIP-01 queries", async () => {
    const signed = await event("timeout-wire");
    const node = await wireRelay([signed], true);
    const sync = new NostrbaseSync(node.host, { timeout: 100 });
    const result = await sync.pull({ kinds: [30078] });
    expect(result.error).toBeNull();
    expect(result.meta?.sync[0]?.strategy).toBe("query");
    expect(node.store.hasEvent(signed.id)).toBe(true);
    await vi.waitFor(() => expect(node.verbs).toContain("NEG-CLOSE"));
    sync.close();
  });
});
