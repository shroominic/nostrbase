# Query filters and result windows

Nostrbase uses the same query builder for public tables, personal encrypted tables, and shared private groups. The client verifies signed records, then applies these filters to the records it has read. These operations do not add SQL to a relay.

```ts
const result = await db.from("tasks")
  .contains("details", { owner: { name: "Ada" } })
  .or('and(labels.ov.{red},rank.gte.2),title.ilike."%review%"')
  .order("rank", { ascending: false, nullsFirst: false })
  .select("id,title", { count: "exact" })
  .range(0, 9);

if (result.error) throw result.error;
console.log(result.data, result.count);
```

Use `db.private.from("tasks")` for personal records, or add `.inGroup(groupId)` for shared private records. These use the same matching rules. Group lookup errors cannot route a query to a public table.

## Filter methods

Chained methods use AND. `.or(expression)` adds one group of alternatives to that AND.

| Method | Meaning |
| --- | --- |
| `eq(field, value)` / `neq(field, value)` | Deep equality / its inverse; no type coercion |
| `in(field, values)` | Equal to at least one array entry |
| `gt`, `gte`, `lt`, `lte` | Compare two numbers or two strings |
| `is(field, null)` / `is(field, boolean)` | Exact null or boolean |
| `like(field, pattern)` | Case sensitive string pattern |
| `ilike(field, pattern)` | Case insensitive string pattern |
| `contains(field, subset)` | Recursive JSON or array containment |
| `containedBy(field, superset)` | Containment in the other direction |
| `overlaps(field, array)` | Arrays have at least one deeply equal entry |
| `textSearch(field, query)` | Local text search; normalizes accents and matches all words |
| `match(object)` | AND of equality filters |
| `filter(field, operator, value)` | Typed form with an explicit operator |
| `not(field, operator, value)` | Negate one filter |
| `or(expression)` | Parse a PostgREST-style logical expression |

`filter` and `not` take native JavaScript values or Supabase raw value strings. Prefer native arrays and objects for typed code: `.not("id", "in", ["a", "b"])`. Raw forms such as `.not("id", "in", "(a,b)")`, `.not("labels", "cs", "{red}")`, and `.filter("rank", "is", "null")` are also supported. They accept the method names above, plus `cs` for `contains`, `cd` for `containedBy`, and `ov` for `overlaps`. Unknown operators return `INVALID_QUERY` before execution.

Raw string values use the same literal rules as logical expressions: unquoted `2`, `true`, and `null` become a number, boolean, and null. Quote a string that looks like one of these literals: `.filter("title", "eq", '\"2\"')` compares the text `2`. Ordinary text such as `Ada` can remain unquoted. Quote strings with reserved delimiters. Pattern operators accept an ordinary pattern string without converting numeric or boolean-looking text. Every raw value must produce exactly one leaf; it cannot inject another OR branch. The raw string form is an escape hatch for value types, while field names remain constrained. `.eq()` and `.in()` retain native strict types.

Filters retain strict TypeScript types for known fields. JSON paths can use only an object or array root. Known nested values retain their types; a path inside a dynamic JSON object can produce `unknown`.

### Patterns

`%` matches zero or more characters. `_` matches one Unicode character. Backslash makes the next character literal. To write a backslash in a JavaScript string, escape it:

```ts
// Matches a title that starts with the literal text "10%_done".
await db.from("tasks").like("title", "10\\%\\_done%");
```

Patterns match the complete string. Use `%review%` for a substring. `ilike` uses Unicode lowercasing; it does not remove accents. Neither method converts numbers or objects to strings. Patterns are limited to 4096 characters. A final, incomplete backslash escape is invalid.

### JSON and array containment

Object containment matches each supplied property recursively. It does not require equality of the whole nested object:

```ts
// Also matches { owner: { name: "Ada", role: "editor" }, extra: true }.
await db.from("tasks").contains("details", { owner: { name: "Ada" } });
```

Array containment requires each supplied entry to have a matching entry. Entry objects can be subsets. Array order and duplicate multiplicity do not affect containment. `eq` still compares complete arrays, in order. `overlaps` uses deep equality for entries. Missing values do not satisfy containment.

### JSON paths

`->` reads a JSON property or array index. A final `->>` converts a non-null JSON value to text:

```ts
await db.from("tasks").eq("details->owner->name", "Ada");
await db.from("tasks").gte("details->scores->0", 3);
await db.from("tasks").eq("details->owner->>active", "true");
```

Native methods preserve literal own-property names, including hyphens, Unicode, dots, and brackets. For example, `.eq("meta.note", value)` reads the literal `meta.note` key; it does not traverse `meta`. Logical-expression field names use identifier syntax. Arrow paths start with an identifier root; their following keys use letters, digits, underscores, or hyphens. Array indexes are nonnegative integers. `->>` must be the final step. Paths are limited to 16 steps and 512 characters. Quoted arrow keys and negative indexes are unsupported. Dot and bracket traversal is unsupported; use arrow paths for nested JSON. `_nostr.pubkey`, `_nostr.eventId`, `_nostr.createdAt`, and `_nostr.updatedAt` are the existing metadata paths.

Every step reads an own property. A query cannot read an inherited property through a prototype. A missing key returns `undefined`. An explicit JSON null remains `null`, including with `->>`.

## Logical expressions

The `.or()` input is a comma-separated list. A leaf has `field.operator.value` form. Groups use `and(...)`, `or(...)`, and `not(...)`. `not.and(...)`, `not.or(...)`, and `field.not.operator.value` are also accepted.

```ts
await db.from("tasks").eq("done", false)
  .or('and(rank.gte.2,labels.ov.{red,blue}),title.eq."Review, phase (2)"');

await db.from("tasks").or('not.or(rank.eq.1,rank.eq.3)');
await db.from("tasks").or('id.in.("a,b",c),details.cs.{"owner":{"name":"Ada"}}');
```

Use JSON quotes for strings with commas, parentheses, braces, brackets, or quotes. JSON escape rules apply inside quoted strings. Quoted values stay strings. Unquoted `true`, `false`, and `null` become their corresponding values. Unquoted finite numeric literals become numbers. Other unquoted values are strings. `in` requires a parenthesized list. Array operators accept JSON arrays or PostgREST array literals such as `{red,"blue,green"}`. Use JSON object syntax for object containment.

The parser accepts at most 8192 characters, 256 terms, 256 list entries, and 16 nested groups. It rejects empty groups, unknown operators, malformed paths, unclosed groups, and trailing input before any query host or relay runs. Raw logical strings cannot get TypeScript field-name checking.

Logical groups do not become relay ID hints. This prevents an OR or NOT branch from discarding other possible matches. Mutation matching still occurs within the signed-in author's records. A valid logical filter cannot authorize changes to another author's records. Use `.all()` when you intentionally want an unfiltered owned-record mutation.

## Missing values, immutable inputs, and sorting

Missing and null are distinct. `.is("rank", null)` matches explicit null only. `.eq("rank", undefined)` matches a missing field. `.neq` and `not` use the inverse of the matching rule, so a missing field can satisfy a negated non-null equality. These are client JSON rules; they do not use SQL's three-valued null logic.

The builder copies filter values when you add them, including nested objects and arrays. Changing your original object later cannot change an existing query or its branches. Filter values must be finite JSON data, with `undefined` permitted for explicit missing-field comparisons. Cycles, accessors, non-JSON objects, values deeper than 32 levels, and values with more than 10000 visited entries are invalid.

```ts
const wanted = { owner: { name: "Ada" } };
const query = db.from("tasks").contains("details", wanted);
wanted.owner.name = "Grace";
// query still uses "Ada".
```

`order(field, { ascending, nullsFirst })` supports JSON paths. Explicit `nullsFirst` applies independently of direction. Without it, ascending order puts null and missing last; descending puts them first. Null and missing share the same sort bucket. Further sort keys and the timestamp/event ID tie-breaker produce stable ordering.

## Count, head, range, and cursor pages

`.select(columns, { count: "exact" })` counts matching verified records before `limit`, `range`, or a cursor window. It reports a count of the finite records available to this read. It is not a count of all records on every relay or a global SQL count. Filters, author scope, record replacement, and known deletion proofs still apply.

`.select("*", { count: "exact", head: true })` returns `data: []` with the count. The client still reads and verifies records; relays do not provide a SQL HEAD endpoint. A head query must be a select with ordinary many-row cardinality. Head mutations, `single()`, and `maybeSingle()` are invalid. Without `count: "exact"`, count retains the existing returned-row count.

Cursor pages use timestamp/event ID order, newest first. Apply rich filters before `.page(size, { cursor })`. An exact count includes matching rows outside that page. Explicit `order` and range offsets cannot be combined with cursor pages. A cursor belongs to its table and scope; reuse the same filters for each page.
