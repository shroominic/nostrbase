# Configure the client

Select relays, define tables, and control write acceptance.

## Required options

```ts
const db = createClient<Database>({
  namespace: "com.example.todos",
  relays: ["wss://relay-one.example", "wss://relay-two.example"],
  timeout: 10_000,
  minWriteAcks: 1,
});
```

| Option | Default | Rule |
| --- | --- | --- |
| `namespace` | Required | Stable string, 1–256 characters |
| `relays` | Required | At least one `ws:` or `wss:` URL; duplicates removed |
| `timeout` | `10000` | Positive integer; milliseconds per relay request/publish round |
| `minWriteAcks` | `1` | Integer from 1 to the number of configured relays |
| `signer` | None | Applesauce signer; public reads work without one |
| `schema` | None | Runtime definitions for every table used |

Use `wss:` in a browser served over HTTPS. Signer prompts have their own lifetime; relay timeouts do not dismiss them.

## Optional services

| Option | Guide |
| --- | --- |
| `persistence` | [Signed cache and IndexedDB](/docs/persistence/) |
| `offline` | [Queue adapter and entry limit](/docs/offline-writes/) |
| `sync` | [Initial/reconnect recovery](/docs/synchronization/) |
| `storage` | [Blossom fetch and timeout](/docs/storage/) |
| `diagnostics` | [Local log capacity and callbacks](/docs/diagnostics/) |

## Use existing Applesauce instances

```ts
import { EventStore, RelayPool, createClient } from "nostrbase";

const pool = new RelayPool();
const eventStore = new EventStore();
const db = createClient({
  namespace: "my-app",
  relays,
  pool,
  eventStore,
});
```

You own injected pools, stores, and signers. Client cleanup leaves these resources to your app. `relayOptions` configures a pool created by the SDK. `transport` supplies an alternative implementation of the [Transport interface](/docs/reference/types/#transport).

## Lifecycle

```ts
await db.ready();
// Use the client.
await db.closeAsync();
```

`ready()` waits for cache and queue hydration. It does not wait for relay readiness or background synchronization. `close()` cancels work and starts cleanup. `closeAsync()` also waits for queue shutdown and pending persistence writes. A closed client cannot be reused.
