# Filters and ordering

Filter canonical rows after version resolution.

## Supported predicates

Predicates combine with AND. Array and object equality compares values deeply.

| Method | Matches |
| --- | --- |
| `eq(field, value)` | Equal value |
| `neq(field, value)` | Unequal value |
| `in(field, values)` | Any value in the supplied list |
| `gt`, `gte`, `lt`, `lte` | Number or string comparison, with matching types |
| `is(field, null \| boolean)` | Null or boolean equality |
| `contains(field, value)` | All supplied array entries or object properties |
| `match(object)` | Equality for each supplied field |
| `textSearch(field, text)` | Every normalized word occurs in a string |
| `author(pubkey \| pubkeys)` | One or more full lowercase hex public keys |

```ts
const result = await db.from("todos")
  .author(pubkey)
  .match({ done: false })
  .textSearch("title", "nostr app")
  .order("title", { ascending: true })
  .limit(20);
```

Field predicates run after the latest versions are selected. Index tags do not push field filtering to the relay in this release. There is no OR, nested JSON-path predicate, SQL expression, or server join.

## Selection and cardinality

```ts
await db.from("todos").select();
await db.from("todos").select("id, title");
await db.from("todos").author(pubkey).eq("id", id).maybeSingle();
```

Select `*` or comma-separated top-level fields. Literal selections infer TypeScript projections. Dynamic selections return partial types. A projection does not change filter evaluation.

## Order and offsets

```ts
await db.from("todos")
  .order("done")
  .order("title", { ascending: false })
  .range(0, 19);
```

Order clauses apply in sequence. Ties use newest update, then lowest event ID. `range()` uses inclusive, nonnegative offsets; `limit()` caps the selected result. They operate over returned relay data, so they are not a global table page.

For feeds, use [cursor pages](/docs/pagination/). For no network request, add `.local()`.

## Builder execution

Builders are immutable and execute once when awaited. Derive queries safely from a shared base:

```ts
const mine = db.from("todos").author(pubkey);
const pending = await mine.eq("done", false);
const completed = await mine.eq("done", true);
```

Awaiting the same builder again returns its existing result. Create a new builder to refresh. `.abortSignal(signal)` cancels relay waits. `.throwOnError()` rejects instead of returning an error; use result mode when you need partial-write receipts.

## More filters

See [richer queries](../queries.md) for OR/NOT expressions, raw filter forms, LIKE patterns, nested JSON, collection containment, explicit null order, and count/head queries.
