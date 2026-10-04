# Search and developer tools

These tools run in the client. They operate on verified relay results or the local cache.

## Typed runtime schemas

```ts
import { z } from "zod";
import { createClient, zodTable, type InferDatabase } from "nostrbase";

const schema = {
  todos: zodTable(z.object({ title: z.string(), done: z.boolean() }), {
    indexes: ["done"],
  }),
};
type Database = InferDatabase<typeof schema>;
const db = createClient<Database>({ namespace: "my-app", relays, schema });
```

`zodTable()` validates public and private writes and decoded records. It uses `safeParse()` as a check; Zod transforms, defaults, and coercions do not change stored data. Validate the exact JSON object you intend to store. `defineTable()` and `defineSchema()` are type helpers for custom validators. A supplied schema registry must list every table you use.

Invalid incoming records are excluded from table results. The signed event can remain in the cache for inspection or migration. Schemas do not enforce relay policy or stop another client from publishing invalid data.

## Search

```ts
const matches = await db.from("todos").textSearch("title", "nostr app");
const cached = await db.from("todos").textSearch("title", "nostr").local();
const notes = await db.events.search("nostr", { kinds: [1], limit: 20 });
```

Table text search checks a string field after version resolution. It ignores case and accents and requires each space-separated word to occur as a substring. It does not provide stemming, ranking, phrase syntax, or a full-text index. Private table search runs after decryption.

`events.search()` sends the NIP-50 `search` filter to relays. Results are signed raw Nostr events, not table rows. Each relay controls support and matching rules. A relay can ignore the filter, return no matches, or reject it. The SDK cannot guarantee relevance across relays. Raw search can return old record versions; use table queries for canonical state.

## Cursor pages

```ts
const first = await db.from("todos").author(pubkey).page(20);
if (first.meta?.nextCursor) {
  const second = await db.from("todos").author(pubkey).page(20, {
    cursor: first.meta.nextCursor,
  });
}
```

Rows sort by newest update timestamp, then lowest event ID. Tokens include the namespace, table, timestamp, and event ID. Tokens from another namespace or table are rejected. Keep the same author and field filters across pages; the token does not bind those filters or freeze a snapshot. Keep public and private cursors separate.

Pages cannot use custom `order()` or `range()`. The SDK narrows requests with `until`, refreshes candidate addresses without that bound, and applies the cursor after latest-version resolution. Private pages do the same on ciphertext. `.local()` pages read the cache only.

Relays can cap results, omit records, or prune history. A full page can produce a cursor even when the next page is empty. Concurrent edits can move rows between pages. Requests and deletion checks can require multiple bounded relay rounds. This does not provide global pagination or SQL snapshots.

## Record references

```ts
import { reference } from "nostrbase";

const target = reference("todos", "task-1", pubkey);
const record = await db.relations.resolve(target);
const related = await db.relations.resolveMany([target]);
```

A reference contains the table, record ID, and full author public key. Store it as JSON in another record. Resolution reads public tables through the normal query API. `resolve()` returns `NOT_FOUND` for a missing record; `resolveMany()` places `null` at each missing position and marks the result partial. Other failures remain errors. There is no server join, foreign key constraint, or automatic cascade delete.

## Data migrations

```ts
const transform = (data: Database["todos"]) => ({ ...data, title: data.title.trim() });
const preview = await db.migrations.run("todos", transform, { dryRun: true });
const applied = await db.migrations.run("todos", transform);

// Specify the old type when it differs from the destination schema.
await db.migrations.run<"todos", { text: string; done?: boolean }>(
  "todos",
  old => ({ title: old.text, done: old.done ?? false }),
  { dryRun: true },
);
```

Migrations read the active author's public records, including legacy data that fails the destination schema. All transformed records are validated before the first write. Return `null` to skip a record. Applying a migration upserts the full object, removes obsolete fields, preserves IDs and original creation times, and requests a signature for each changed record. The initial author remains fixed if the active account changes.

Options include `signal` and `queue`. A queued migration uses local records and saves signed writes for explicit replay. Migrations are not atomic. `data.rows`, `data.receipts`, and `meta.receipts` preserve completed work after partial failure. There is no relay-wide schema change or multi-author migration authority.

## Backups

```ts
const exported = await db.backup.export();
if (exported.error) throw exported.error;
const json = JSON.stringify(exported.data);
const restored = await db.backup.import(json);
```

An archive contains namespace-scoped, signed cached events, record history, and deletion tombstones. Private events remain ciphertext. Ephemeral messages and unscoped native events are excluded. Queue delivery state is separate and is not included.

Import checks the whole archive's format, namespace, and signatures before changing the cache. It applies tombstones first and does not republish anything. An archive reflects data known to this client; pull from relays first to update that view. It is not a complete relay or global backup. Keep tombstones with records to prevent deleted versions from returning.

## Diagnostics

```ts
const db = createClient({
  namespace: "my-app",
  relays,
  diagnostics: { capacity: 200, onEntry: entry => console.log(entry) },
});
const entries = db.diagnostics.list();
const listener = db.diagnostics.events$.subscribe(entry => console.log(entry));
db.diagnostics.clear();
listener.unsubscribe();
```

The buffer keeps up to `capacity` entries, from 1 to 10,000. Set `enabled: false` to disable it. SDK entries contain request counts, event IDs/kinds, acknowledgement counts, error codes, and passive connection state. They exclude record bodies, decrypted private data, secret keys, and auth tokens. Your callbacks must decide what they save. This is local diagnostics, not hosted logs.

## Local dashboard

```ts
const snapshot = await db.dashboard.snapshot();
const html = await db.dashboard.render();
const element = document.getElementById("inspector");
if (!element) throw new Error("Inspector element is missing.");
const view = db.dashboard.mount(element, { interval: 2000 });
await view.refresh();
view.destroy();
```

`snapshot()` returns public cached rows, private ciphertext counts/author metadata, passive relay state, queue metadata, and diagnostics. `render()` returns standalone HTML with tabs. Save it as an HTML file to inspect it. `mount()` adds a live read-only view and refreshes it at an interval of at least 100 ms. Client close also destroys mounted views.

The dashboard never decrypts private records. Public record content is visible; choose where to display or share it. It does not administer relays or establish complete data. Local signed history and deletion tombstones currently have no automatic eviction.
