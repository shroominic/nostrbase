# Offline cache, write queue, and synchronization

These features use Applesauce for Nostr connections and NIP-77 reconciliation. They do not require an application server. A relay must support NIP-77 to use Negentropy; ordinary Nostr queries provide recovery when it does not.

## Persistent event cache

```ts
import { createClient, IndexedDBPersistenceAdapter } from "nostrbase";

const db = createClient({
  namespace: "my-app",
  relays: ["wss://relay.example"],
  persistence: {
    adapter: new IndexedDBPersistenceAdapter("my-app-cache"),
    batchSize: 100,
    flushInterval: 25,
    onError: (error) => console.error(error),
  },
  sync: { tables: ["todos"], initial: true, reconnect: true },
});

await db.ready();
const cached = await db.from("todos").select().local();
```

`ready()` restores verified signed events and queued writes. Deletion tombstones load before records. The cache preserves the original event content, including encrypted ciphertext. It never saves decrypted private record data. Ephemeral broadcast and presence events are excluded.

The memory adapter implements the same interface:

```ts
import { MemoryPersistenceAdapter } from "nostrbase";
const adapter = new MemoryPersistenceAdapter();
```

It keeps data only while that adapter exists. IndexedDB survives a browser restart, subject to the browser's storage policy and available space. Both adapters partition cache and queue entries by the client namespace. Use separate database names for profiles when you need separate device storage.

Writes use batches of at most `batchSize` events. `flushInterval` starts a short write delay; it does not guarantee a durable commit before a page closes. Call `await db.persistence?.flush()` at a checkpoint and `await db.closeAsync()` for an orderly close. Storage failures reject `ready()` or `flush()` and reach `onError` for background writes. A failed cache batch remains pending for explicit retry.

Cached history and tombstones have no automatic size eviction. Deleting tombstones can make deleted records reappear. Monitor browser storage usage for large collections.

## Explicit offline writes

Sign in while your signer is available. Queue a mutation with the normal query API:

```ts
await db.auth.signInWithExtension();

const result = await db
  .from("todos")
  .upsert({ id: "task-1", title: "Work offline", done: false })
  .queue()
  .select();

console.log(result.meta?.receipts); // Queued receipts, not relay acknowledgements.

// Later, with the same author signed in:
const replay = await db.offline.flush();
```

`queue()` checks the local cache and signs immediately. It cannot guarantee an insert is globally unique. The signed event enters the queue before it enters the optimistic cache. An IndexedDB-backed queue survives restart; the default queue is in memory unless a persistent adapter is supplied.

For protocol-specific events that you have already signed:

```ts
const queued = await db.offline.enqueueSigned(signedEvent);
const entries = await db.offline.list();
await db.offline.remove(signedEvent.id);
```

`enqueueSigned()` verifies the signature and requires the event's author to match the signed-in user. Ephemeral events cannot be queued. Queue receipts include `queued: true` and `persisted: true`, which means the selected adapter accepted the entry. The memory adapter is not durable storage.

Replay sends exactly the saved event. It never requests a new signature, changes timestamps, publishes other authors' cached events, or retries a different account's queue entries. Rejected writes stay queued with attempt counts and the latest relay receipts. A write leaves the queue once the current client's `minWriteAcks` requirement is met.

```ts
const controller = new AbortController();
const replay = db.offline.flush({ signal: controller.signal });
controller.abort();
await replay;
```

Cancellation stops further work. A relay can have accepted an event before cancellation or before an acknowledgement is lost. Replaying the same event ID handles that case. Removing an entry stops its future delivery. Its optimistic signed event remains in the cache, including a persistent cache. Removal does not roll back record state or send a Nostr deletion request. To inspect relay-confirmed state after removal, create a separate client with a fresh empty cache and pull from the relays. A same-cache restart retains the optimistic event.

Replay is manual by default. Set `offline.autoReplay: true` or call `db.offline.startAutoReplay()` to enable replay after sign-in, durable enqueue, browser online, and configured relay connection. See [automatic replay](automatic-replay.md) for retry options, receipts, cancellation, and private group recovery. Multiple tabs can retry an identical event; the SDK does not provide a distributed queue lock. Signed writes can lose to newer record versions published by another device.

## Pull missing events with Negentropy

```ts
const recovery = await db.sync.table("todos");
console.log(recovery.meta?.sync);
```

A table pull includes table records, scoped deletion events, and deletion recovery by event/address pointers. This also handles NIP-09 events from clients that omit this SDK's namespace tag. Private personal records use the same signed ciphertext events; register their wire scope as `private:todos` for automatic recovery.

You can supply explicit Nostr filters or use registered table scopes:

```ts
await db.sync.pull({ kinds: [1], authors: [pubkey] });
await db.sync.pull(); // sync.tables plus tables used through the client.
await db.sync.pull(undefined, { strategy: "query" });
```

An empty registered scope produces `INVALID_QUERY`, rather than an unbounded request for every event on every relay. Explicit filters are an escape hatch and can intentionally select data outside the namespace.

For each relay and filter, the SDK:

1. Gives Applesauce a filtered vector of locally stored event IDs and timestamps.
2. Uses Negentropy to find remote IDs absent locally.
3. Fetches missing events in batches of at most 100 IDs.
4. Verifies each signature and checks the original filter before ingestion.
5. Uses ordinary event queries if NIP-77 is unsupported, fails, or times out.

The SDK does not publish the local-only IDs reported by reconciliation. Use the explicit signed write queue to send your own events.

`meta.sync` reports each relay's strategy (`negentropy`, `query`, or `mixed`), received count, fallback reason, and completion status. Counts include valid received copies; the returned event array is deduplicated by ID. Partial success is reported if some relays fail.

```ts
await db.sync.pull(undefined, {
  signal: controller.signal,
  relays: [db.relays[0]!],
});
```

Only configured relays can be selected. Cancellation and `sync.timeout` terminate reconciliation. Late responses from a cancelled reconciliation do not enter the cache.

## Live subscriptions and recovery

Subscriptions receive new events. Negentropy recovers stored events missed during a disconnect. Use both:

```ts
const channel = db
  .channel("tasks")
  .on("nostr_changes", { table: "todos" }, (change) => console.log(change))
  .subscribe();
```

`sync.initial` runs a pull after cache hydration. `sync.reconnect` runs recovery after a previously connected relay disconnects and reconnects. Both are opt-in. Tables registered later through client queries also participate. `sync.onError` receives background recovery failures. Client close cancels sync and removes its relay connection observers.

Relays can limit ordinary queries or remove event history. Neither subscriptions nor Negentropy guarantee a complete global table, atomic changes, conflict-free writes, or delivery of ephemeral history. Each device still applies Nostr version and author rules.
