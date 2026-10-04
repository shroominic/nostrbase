# Read and write records

Select rows, insert data, replace records, and edit your own records.

## Read rows

```ts
const rows = await db.from("todos")
  .select("id, title, done")
  .author(pubkey)
  .eq("done", false);

const one = await db.from("todos").author(pubkey).eq("id", id).single();
const optional = await db.from("todos").author(pubkey).eq("id", id).maybeSingle();
```

Reads include all authors unless filtered. `single()` requires one row. `maybeSingle()` permits zero or one. More than one returns `MULTIPLE_ROWS`.

## Insert

```ts
await db.from("todos")
  .insert({ id: "task-1", title: "Write docs", done: false })
  .select()
  .single();
```

Omit `id` to generate a UUID. Insert detects a known existing record for this author and returns `CONFLICT`. This is not a cross-device uniqueness lock.

## Upsert

```ts
await db.from("todos")
  .upsert({ id: "task-1", title: "Revised title", done: true });
```

Upsert creates or replaces the entire data object. Omitted fields are removed. Use a stable ID for retries.

## Update

```ts
await db.from("todos").update({ done: true }).eq("id", "task-1").select();
```

Update merges a patch into each matched record owned by the signer. The SDK signs one new event per record. An explicit other-author filter returns `PERMISSION_DENIED`.

## Delete

```ts
await db.from("todos").delete().eq("id", "task-1");
```

Delete publishes signed requests. Relays can retain copies. Keep deletion tombstones with cached records and backups.

## Bulk writes

```ts
await db.from("todos").insert([
  { id: "task-1", title: "First", done: false },
  { id: "task-2", title: "Second", done: false },
]).select();

await db.from("todos").update({ done: true }).all();
```

Updates and deletes need a filter or explicit `.all()`. Batches stop at the first failed record and can leave earlier writes committed. Inspect [partial results and receipts](/docs/errors/).

## Data rules

Fields must be JSON values: strings, finite numbers, booleans, null, arrays, or plain objects. `id` and `_nostr` are reserved. Dates, binary values, `undefined`, bigint, functions, and circular objects are rejected. Store a date as an ISO string and files as [Blossom descriptors](/docs/storage/).

A full row is `Row<T>`: your data plus `id` and `_nostr` with `pubkey`, `eventId`, `createdAt`, and `updatedAt`. Timestamps are Unix seconds.
