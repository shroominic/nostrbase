# Automatic queue replay

Automatic replay is opt-in. It sends saved public and personal events, and retries this device's private group work through the Applesauce transport. It does not require an application server.

## Enable replay

```ts
import { createClient, IndexedDBPersistenceAdapter } from "nostrbase";

const db = createClient({
  namespace: "my-app",
  relays: ["wss://your-relay.example"],
  offline: {
    adapter: new IndexedDBPersistenceAdapter("my-app-queue"),
    autoReplay: {
      retryDelay: 1000,
      maxRetryDelay: 30000,
      onResult: (result) => console.log(result.meta?.receipts),
      onError: (error, result) => console.error(error.code, result.meta?.receipts),
    },
  },
});
await db.auth.signInWithExtension();

const queued = await db.from("tasks").upsert({
  id: "task-1", title: "Work offline", done: false,
}).queue();
if (queued.error) throw queued.error;
```

`autoReplay: true` uses the default options. The queue is in memory unless you supply a persistent adapter. A queue receipt means the adapter accepted the write. It does not mean a relay accepted it.

| Option | Default | Purpose |
| --- | --- | --- |
| `initial` | `true` | Check saved work after initial hydration |
| `retryDelay` | `1000` | First retry delay in milliseconds |
| `maxRetryDelay` | `30000` | Maximum retry delay in milliseconds |
| `onResult` | — | Inspect completed attempts and their receipts |
| `onError` | — | Inspect failed attempts, including partial receipts |

Delays must be positive safe integers. The maximum must be at least the initial delay and no greater than `2147483647`. Failed work uses exponential delays up to the maximum. There is no retry count limit. Observer errors do not stop replay.

## What starts an attempt?

- Initial cache and queue hydration, when `initial` is enabled.
- A completed sign-in or signer replacement.
- A saved queue entry or private group publication obligation.
- A configured native relay connection becoming connected.
- A browser `online` event.
- A scheduled retry after failure.

The browser's online state is only a trigger. It does not prove that a relay is available. A custom transport can replay without a connected native relay pool. Only one automatic attempt runs per client. Manual queue flushes share the same queue lock.

```ts
db.offline.startAutoReplay({ retryDelay: 2000, maxRetryDelay: 60000 });
console.log(db.offline.autoReplayStatus);
db.offline.stopAutoReplay();
```

`startAutoReplay()` replaces the current options. `autoReplayStatus` contains `running`, `inFlight`, `failures`, `nextRetryAt`, and optional `lastResult`. Stopping aborts the active attempt and removes timers and listeners. Its `inFlight` field becomes false when the active attempt completes. `closeAsync()` waits for completion before closing queue storage.

## Account and cancellation rules

Replay sends only the active account's saved work in this namespace. Starting any sign-in attempt aborts the previous automatic attempt before the replacement signer finishes. Replay waits for that auth transition to finish. If replacement fails and the previous session remains valid, its queue can resume. Sign-out stops publication until a user signs in again.

Cancelled or superseded attempts do not enter `lastResult` or its observers. Saved queue entries still retain relay receipts returned before cancellation. A relay may accept a write before cancellation or before an ACK is lost. An exact event can therefore be sent more than once. Cancellation cannot undo relay acceptance.

Public and personal replay sends exactly the saved signed event. It does not change its ID, timestamp, or ciphertext, and does not ask the signer for a new signature. Public replay does not require NIP-44. A public queue does not initialize the private group engine when no group work exists.

An entry leaves the public or personal queue only when it meets `minWriteAcks`. ACKs show acceptance by the selected relays at that time. They do not prove permanent or global storage. Each tab has its own replay loop; there is no lock shared by separate tabs or devices.

## Private group replay

Group replay includes exact saved publication envelopes, pending Welcome delivery, and saved signed record intents. For an intent that has no envelope, Marmot uses the active group state to create one. It then saves the exact envelope before publication. Private group state remains encrypted in the configured group adapter.

Reuse the same account, random device ID, and group adapter across restarts. Do not share live MLS device state between devices. Private group replay requires the signer's NIP-44 support. See [shared private collections](groups.md) for setup and engine limits.

Recovery can replace loaded group handles. Open a fresh handle with `db.groups.get(groupId)` after recovery, or use `db.from("tasks").inGroup(groupId)` for each operation. SDK group mutations and recovery are serialized. Automatic replay does not re-create a failed high-level membership action; it retries saved obligations from that action.

Automatic replay does not pull remote records. Use [subscriptions and Negentropy recovery](offline-sync.md) for incoming changes. It does not queue file uploads, expired presence events, or ephemeral broadcasts.

See the [browser example](../examples/automatic-replay.ts).
