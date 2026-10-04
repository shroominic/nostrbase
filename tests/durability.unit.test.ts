import { IDBFactory } from "fake-indexeddb";
import { describe, expect, vi } from "vitest";
import type { QueuedEvent } from "../src/persistence";
import {
  IndexedDBPersistenceAdapter,
  MemoryPersistenceAdapter,
  NostrbasePersistence,
} from "../src/persistence";
import { encodeRecord } from "../src/protocol";
import { alice } from "./helpers";
import { deferred, required, test } from "./support/lifecycle";

class FaultAdapter extends MemoryPersistenceAdapter {
  beforeQueueWrite?: (entry: QueuedEvent) => void | Promise<void>;
  beforeRemove?: () => void | Promise<void>;
  override async putQueue(entry: QueuedEvent, namespace?: string) {
    await this.beforeQueueWrite?.(entry);
    await super.putQueue(entry, namespace);
  }
  override async removeQueue(id: string, namespace?: string) {
    await this.beforeRemove?.();
    await super.removeQueue(id, namespace);
  }
}
const record = async (id: string) =>
  alice.signEvent(encodeRecord("test-app", "todos", id, { title: id, done: false }, 10, 10));

describe("offline commit boundaries", () => {
  test("a failed durable enqueue cannot expose optimistic state or a success receipt", async ({
    scope,
  }) => {
    const adapter = new FaultAdapter();
    adapter.beforeQueueWrite = () => {
      throw new Error("disk full");
    };
    const { client, transport } = scope.client({ offline: { adapter } });
    const result = await client
      .from("todos")
      .insert({ id: "x", title: "x", done: false })
      .queue()
      .select();
    expect(result.error).not.toBeNull();
    expect(result.count).toBe(0);
    expect(result.meta?.receipts).toEqual([]);
    expect((await client.from("todos").local()).data).toEqual([]);
    expect(await client.offline.list()).toEqual([]);
    expect(transport.published).toEqual([]);
  });

  test("serializes concurrent enqueues at capacity and still permits duplicate delivery requests", async ({
    scope,
  }) => {
    const { client } = scope.client({ offline: { maxEntries: 1 } });
    const [a, b] = await Promise.all([record("a"), record("b")]);
    const results = await Promise.all([
      client.offline.enqueueSigned(a),
      client.offline.enqueueSigned(b),
    ]);
    expect(results.map((result) => result.error?.code ?? "OK")).toEqual(["OK", "CONFLICT"]);
    expect((await client.offline.enqueueSigned(a)).error).toBeNull();
    expect((await client.offline.list()).map((entry) => entry.event.id)).toEqual([a.id]);
    expect((await client.from("todos").local()).data?.map((row) => row.id)).toEqual(["a"]);
  });

  test("a failed attempt commit stops delivery and releases the queue lock for retry", async ({
    scope,
  }) => {
    const adapter = new FaultAdapter();
    const { client, transport } = scope.client({ offline: { adapter } });
    const event = await record("x");
    await client.offline.enqueueSigned(event);
    adapter.beforeQueueWrite = (entry) => {
      if (entry.attempts) throw new Error("commit failed");
    };
    expect((await client.offline.flush()).error).not.toBeNull();
    expect(transport.published).toEqual([]);
    expect((await client.offline.list())[0]?.attempts).toBe(0);
    adapter.beforeQueueWrite = undefined;
    expect((await client.offline.flush()).error).toBeNull();
    expect(transport.published.map((value) => structuredClone(value))).toEqual([
      structuredClone(event),
    ]);
  });

  test("replays the identical event after an acknowledgement succeeds but queue removal fails", async ({
    scope,
  }) => {
    const adapter = new FaultAdapter();
    const { client, transport } = scope.client({ offline: { adapter } });
    const event = await record("x");
    await client.offline.enqueueSigned(event);
    adapter.beforeRemove = () => {
      throw new Error("crash after relay OK");
    };
    const failed = await client.offline.flush();
    expect(failed.error).not.toBeNull();
    expect(failed.data?.[0]?.eventId).toBe(event.id);
    expect(failed.meta?.partial).toBe(true);
    expect((await client.offline.list())[0]).toMatchObject({ event, attempts: 1 });
    adapter.beforeRemove = undefined;
    expect((await client.offline.flush()).error).toBeNull();
    expect(transport.published.map((value) => structuredClone(value))).toEqual([
      structuredClone(event),
      structuredClone(event),
    ]);
    expect(await client.offline.list()).toEqual([]);
    expect((await client.from("todos").local()).data).toHaveLength(1);
  });

  test("removing a queued write stops delivery without rolling back cached state", async ({
    scope,
  }) => {
    const { client, transport } = scope.client();
    const event = await record("x");
    await client.offline.enqueueSigned(event);
    expect(await client.offline.remove(event.id)).toBe(true);
    expect(await client.offline.remove(event.id)).toBe(false);
    expect((await client.offline.flush()).data).toEqual([]);
    expect(transport.published).toEqual([]);
    expect((await client.from("todos").local()).data?.[0]?.id).toBe("x");
  });

  test("concurrent flushes cannot deliver the same entry twice", async ({ scope }) => {
    const { client, transport } = scope.client();
    const event = await record("x");
    await client.offline.enqueueSigned(event);
    const results = await Promise.all([client.offline.flush(), client.offline.flush()]);
    expect(results.map((result) => result.count)).toEqual([1, 0]);
    expect(transport.published.map((value) => structuredClone(value))).toEqual([
      structuredClone(event),
    ]);
  });

  test("closeAsync waits for an active durable enqueue and closes a shared adapter once", async ({
    scope,
  }) => {
    const adapter = new FaultAdapter();
    const started = deferred();
    const release = deferred();
    const close = vi.spyOn(adapter, "close");
    const { client } = scope.client({ persistence: { adapter } });
    scope.defer(() => release.resolve());
    await client.ready();
    adapter.beforeQueueWrite = async () => {
      started.resolve();
      await release.promise;
    };
    const enqueue = client.offline.enqueueSigned(await record("x"));
    await started.promise;
    let closed = false;
    const closing = client.closeAsync().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release.resolve();
    expect((await enqueue).error).toBeNull();
    await closing;
    await client.closeAsync();
    expect(close).toHaveBeenCalledTimes(1);
    expect(await adapter.loadQueue("test-app")).toHaveLength(1);
    expect(await adapter.loadEvents("test-app")).toHaveLength(1);
  });
});

describe("cache transaction integrity", () => {
  test("flush drains arrivals during a slow commit and never overlaps adapter writes", async ({
    scope,
  }) => {
    const adapter = new MemoryPersistenceAdapter();
    const started = deferred();
    const release = deferred();
    const original = adapter.putEvents.bind(adapter);
    let active = 0;
    let maximum = 0;
    const batches: string[][] = [];
    vi.spyOn(adapter, "putEvents").mockImplementation(async (events, namespace) => {
      active++;
      maximum = Math.max(maximum, active);
      batches.push(events.map((event) => event.id));
      if (batches.length === 1) {
        started.resolve();
        await release.promise;
      }
      await original(events, namespace);
      active--;
    });
    const persistence = new NostrbasePersistence(
      { namespace: "test-app", ingest: () => true },
      { adapter, batchSize: 2, flushInterval: 60000 },
    );
    scope.defer(() => persistence.close());
    scope.defer(() => release.resolve());
    const events = await Promise.all([record("a"), record("b"), record("c")]);
    persistence.record(required(events[0]));
    const first = persistence.flush();
    await started.promise;
    persistence.record(required(events[1]));
    persistence.record(required(events[2]));
    const second = persistence.flush();
    release.resolve();
    await Promise.all([first, second]);
    expect(maximum).toBe(1);
    expect(batches.flat()).toEqual(events.map((event) => event.id));
    expect((await adapter.loadEvents("test-app")).map((event) => event.id)).toEqual(
      events.map((event) => event.id),
    );
  });

  test("IndexedDB rolls back the whole batch if a later entry cannot be cloned", async ({
    scope,
  }) => {
    const adapter = new IndexedDBPersistenceAdapter("atomic-batch", new IDBFactory());
    scope.defer(() => adapter.close());
    const good = await record("good");
    const bad = { ...(await record("bad")), nonCloneable: () => {} };
    await expect(adapter.putEvents([good, bad], "test-app")).rejects.toThrow();
    expect(await adapter.loadEvents("test-app")).toEqual([]);
    await adapter.putEvents([good], "test-app");
    expect(await adapter.loadEvents("test-app")).toEqual([structuredClone(good)]);
  });

  test("both persistence adapters isolate caller mutations from committed events and queue entries", async ({
    scope,
  }) => {
    const adapters = [
      new MemoryPersistenceAdapter(),
      new IndexedDBPersistenceAdapter("clone-boundary", new IDBFactory()),
    ];
    for (const adapter of adapters) {
      scope.defer(() => adapter.close());
      const signed = await record("x");
      const expected = structuredClone(signed);
      const entry: QueuedEvent = { event: signed, queuedAt: 1, attempts: 0, relays: [] };
      await adapter.putEvents([signed], "app");
      await adapter.putQueue(entry, "app");
      signed.content = "mutated caller";
      entry.attempts = 99;
      const events = await adapter.loadEvents("app");
      const queue = await adapter.loadQueue("app");
      expect(events).toEqual([expected]);
      expect(queue[0]).toMatchObject({ event: expected, attempts: 0 });
      required(events[0]).tags.push(["t", "mutated reader"]);
      required(queue[0]).event.content = "mutated reader";
      expect(await adapter.loadEvents("app")).toEqual([expected]);
      expect((await adapter.loadQueue("app"))[0]?.event).toEqual(expected);
    }
  });
});
