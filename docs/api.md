# API and setup guide

A Supabase-style TypeScript SDK for Nostr apps, built on **Applesauce**.

Build a static website or an app with one client and one or more relays. Use familiar table queries, signer auth, CRUD, and change subscriptions. Each record is a signed Nostr event.

**Version 0.2.0.** This package is local and has not been published to npm. It supports modern browsers and Node 22.12+ as an ESM package.

## Start

From this project:

```sh
npm ci
npm run check
npm pack
```

From your app, install the local package:

```sh
npm install /Users/fungus/dev/nostrbase/nostrbase-0.2.0.tgz
```

```ts
import { createClient } from "nostrbase";

type Database = {
  todos: { title: string; done: boolean };
};

const db = createClient<Database>({
  namespace: "com.example.todos",
  relays: ["wss://your-relay.example"], // Use a relay that accepts kinds 30078 and 5.
});

// Call this from the sign-in button in a browser with a NIP-07 extension.
const login = await db.auth.signInWithExtension();
if (login.error) throw login.error;

const inserted = await db
  .from("todos")
  .insert({ title: "Build a Nostr app", done: false })
  .select()
  .single();
if (inserted.error) throw inserted.error;

const { data, error } = await db
  .from("todos")
  .select("id, title, done")
  .author(login.data!.user.pubkey)
  .eq("done", false)
  .order("title")
  .limit(20);
```

No API key, project server, or database migration is needed. The namespace must stay the same across your app's clients.

## Familiar API

| Operation | API |
| --- | --- |
| Create a client | `createClient<Database>({ namespace, relays })` |
| Read | `db.from("todos").select().eq("done", false)` |
| Create | `db.from("todos").insert({ title: "Hello", done: false }).select()` |
| Replace or create | `db.from("todos").upsert({ id, title: "Hello", done: true })` |
| Update | `db.from("todos").update({ done: true }).eq("id", id)` |
| Delete | `db.from("todos").delete().eq("id", id)` |
| Sign in | `db.auth.signInWithExtension()` or `signInWithSigner(signer)` |
| Live changes | `db.channel(name).on("nostr_changes", filter, callback).subscribe()` |
| Standard Nostr events | `db.events.query(filter)`, `publish(template)`, `subscribe(...)` |
| Broadcast and Presence | `channel.send(...)`, `track(...)`, `presenceState()` |
| Private personal records | `db.private.from("todos")` |
| Files | `db.storage.from(serverOrigin)` |
| Cached reads and queued writes | `.local()`, `.queue()`, `db.offline.flush()` |
| Recovery | `db.sync.table("todos")` |
| Developer tools | `db.backup`, `db.relations`, `db.migrations`, `db.dashboard`, `db.diagnostics` |
| Release resources | `await db.closeAsync()` |

This is a familiar API for Nostr. It is not a complete Supabase replacement or a SQL database.

## Records and ownership

A row contains your data, an `id`, and `_nostr` metadata:

```ts
const row = {
  id: "task-42",
  title: "Build a Nostr app",
  done: false,
  _nostr: {
    pubkey: "...",       // Author's public key.
    eventId: "...",      // Current signed event ID.
    createdAt: 1700000000,
    updatedAt: 1700000001,
  },
};
```

`id` and `_nostr` are reserved fields. Other fields must be JSON values. You can supply an id or let the SDK create a UUID.

Record identity is **namespace + table + author + id**. Two authors can use the same id. Use `.author(pubkey)` when you need one user's records. Reads include all authors by default. Updates and deletes select only the active signer's records. An explicit attempt to write another author's records returns `PERMISSION_DENIED`.

Updates create a new signed version. Upsert replaces the full data object. Delete sends a NIP-09 deletion request.

## Queries

```ts
const base = db.from("todos").author(pubkey);
const pending = await base.eq("done", false);
const one = await base.eq("id", id).single();
const optional = await base.eq("id", id).maybeSingle();

await db.from("todos").update({ done: true }).eq("id", id);
await db.from("todos").delete().eq("id", id);
```

Supported filters: `eq`, `neq`, `in`, `gt`, `gte`, `lt`, `lte`, `is`, `contains`, `match`, and `textSearch`. Use `order`, `limit`, and inclusive `range(from, to)` for the returned rows. `select` supports `*` and comma-separated field names, with inferred TypeScript projections. Use `.page(size, { cursor })` for newest-first cursor pages. See [search and tooling](tooling.md) for cursor rules and examples.

Builders are immutable. A builder executes once when awaited. Create a new builder to refresh a query. Writes return `data: null` by default; add `.select()` to get rows. `.single()` and `.maybeSingle()` also enable returned rows.

Updates and deletes require a filter. Use `.all()` to permit a write to all of your records:

```ts
await db.from("todos").update({ done: true }).all();
```

Fields are filtered **after** the SDK resolves the latest versions. Namespace, author, and id filters run on the relay. Cursor pages add a time bound, then refresh candidate addresses without that bound to resolve newer versions. Field filters, sorting, and final row selection run on the client. Relays can cap or prune results, so `count` is the number of returned/committed rows, not a global database count. `meta.partial` reports relay failures; it cannot detect undisclosed relay limits.

## Auth

```ts
import { PrivateKeySigner, NostrConnectSigner } from "nostrbase";

// Use a secret supplied by the user or generate a temporary development identity.
await db.auth.signInWithPrivateKey(privateKey); // Uint8Array, hex, or nsec.
await db.auth.signInWithSigner(new PrivateKeySigner());

// Use an Applesauce NIP-46 remote signer.
const signer = await NostrConnectSigner.fromBunkerURI(bunkerUri, { pool: db.pool });
await db.auth.signInWithSigner(signer);

const { data: session } = await db.auth.getSession();
const { data: user } = await db.auth.getUser();
const { data: { subscription } } = db.auth.onAuthStateChange((event, session) => {
  console.log(event, session?.user.pubkey);
});
subscription.unsubscribe();
await db.auth.signOut();
```

A session holds a public key. Signing is handled by Applesauce. There is no JWT or server session. The SDK does not persist keys or sessions. Sign-out clears the SDK session; the app owns the signer and must close a remote signer when needed. A generated private key is temporary unless your app saves it.

Auth proves control of a key. Your app must decide which authors it trusts. If a relay requires NIP-42 auth, use `db.pool.relay(url).authenticate(signer)` before the operation; relay authentication is not automatic.

## Live changes

```ts
const channel = db
  .channel("pending-todos")
  .on("nostr_changes", {
    table: "todos",
    event: "*",
    author: pubkey,
    filter: "done=eq.false",
  }, ({ eventType, new: next, old: previous }) => {
    console.log(eventType, next, previous);
  })
  .subscribe((status, error) => {
    if (error) console.error(status, error);
  });

await db.removeChannel(channel);
```

`postgres_changes` is an alias for the same event type. Payloads contain `INSERT`, `UPDATE`, or `DELETE`, the new and old rows, and the signed event. Initial cached or relay records arrive as `INSERT`. Duplicate and stale versions are ignored. For filtered updates, a callback runs when either the old or new row matches. This lets an app remove a row that leaves its filter.

`SUBSCRIBED` means local handlers are installed. It is not a relay readiness or replay-completion signal. Reconnects use Applesauce's retry policy. A terminal relay error emits `CHANNEL_ERROR`; call `.subscribe()` again to retry. Channels read kind-5 deletion events to accept deletion requests from other Nostr clients. For large deployments, use author filters and a relay with suitable retention and limits.

## Errors and relay acknowledgements

```ts
const result = await db.from("todos").insert(todo).select();
if (result.error) {
  console.error(result.error.code, result.error.message);
}
console.log(result.meta?.receipts); // Record ids, signed event ids, and relay responses.
```

By default, one relay acknowledgement makes a write successful. Set `minWriteAcks` to require more. Each relay response is in `meta.relays`. Writes accepted by only some relays set `meta.partial`.

A failed batch or acknowledgement threshold can still leave committed records. Returned data and `meta.receipts` show those writes. Batches stop at the first failed record and are not atomic. An aborted or timed-out publish may already have reached a relay. Read the record before a retry. Use a stable id for application retries.

Use `.throwOnError()` to reject the query promise. In result mode, a failed `.single()` preserves any write receipts. In throw mode, retain the original result workflow if you need batch receipts.

Use `.abortSignal(signal)` to cancel reads and relay waits. The `timeout` option, in milliseconds, bounds each relay request or publish. A query with deletion checks can use more than one request round. External signer prompts have their own lifetime.

## Native Nostr and Applesauce access

```ts
await db.events.publish({
  kind: 1,
  created_at: Math.floor(Date.now() / 1000),
  tags: [],
  content: "Hello Nostr",
});
const notes = await db.events.query({ kinds: [1], authors: [pubkey], limit: 20 });
const listener = db.events.subscribe({ kinds: [1] }, event => console.log(event));
listener.unsubscribe();

// db.pool and db.eventStore are the real Applesauce instances.
```

Use `publishSigned` for an event signed outside the SDK. Incoming and outgoing events are verified. Supply `pool`, `eventStore`, `relayOptions`, or a custom `transport` to integrate an existing Applesauce app. `close()` cancels subscriptions and starts resource cleanup. `await closeAsync()` also waits for queue shutdown and pending persistence writes; use it when durability matters. Injected pools/stores and external signers remain owned by the app.

## Optional runtime schema

```ts
const db = createClient<Database>({
  namespace: "com.example.todos",
  relays,
  schema: {
    todos: {
      indexes: ["done"],
      validate: (value): value is Database["todos"] =>
        typeof value === "object" && value !== null &&
        typeof (value as Database["todos"]).title === "string" &&
        typeof (value as Database["todos"]).done === "boolean",
    },
  },
});
```

A schema registry lists every table. Its validators check writes and incoming records. TypeScript types alone do not validate relay data. Indexes add interoperable tags; this version does not push field predicates to those tags, because a relay can return an old version from another relay. Private tables use the same validators but omit data index tags. Table names beginning with `private:` are reserved for encrypted routing.

Zod inference, migrations, references, backups, diagnostics, and the local dashboard are described in [search and developer tools](tooling.md).

## Extended features

- [Broadcast and Presence](realtime.md): signed public channel messages, session state, heartbeat, and expiry.
- [Offline and sync](offline-sync.md): IndexedDB cache, explicit signed write queue, and NIP-77 Negentropy recovery with query fallback.
- [Private records and files](private-storage.md): personal NIP-44 tables and Blossom storage.
- [Shared private collections](groups.md): experimental Marmot/MLS groups, invitations, encrypted CRUD, and device recovery.
- [Search and tools](tooling.md): local text search, NIP-50 raw search, cursor pages, Zod, references, migrations, backups, diagnostics, and dashboard.

## Nostr constraints

- Public table data and index tags are public. Personal private tables encrypt the body, but author and routing metadata remain public. Experimental shared collections use Marmot group membership; there is no configurable server-enforced RLS.
- Relays provide storage, delivery, and their own policy. Relay acceptance does not guarantee permanent retention, complete reads, or deletion from every copy.
- Versions use the latest timestamp, then the lowest event id for a tie. Concurrent edits on different devices can overwrite each other. There are no transactions, foreign keys, global uniqueness rules, or SQL joins.
- The SDK uses a monotonically increasing timestamp per known address. Many updates within one second can move timestamps into the future. A relay can reject those events; use an app write rate suited to its policy.
- The default cache and queue are in memory. Configure IndexedDB for durable browser storage. Opt-in startup/reconnect sync pulls missing stored events; replay of queued writes is explicit. Cached history and tombstones have no automatic eviction.
- Files need an external Blossom server. RPC functions and server-enforced business rules are outside this version; app logic runs on the client.

See [the protocol](protocol.md), [examples](../examples/README.md), and [contributor guide](../CONTRIBUTING.md).
