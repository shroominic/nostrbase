# Errors and write receipts

Keep completed work when a relay, signer, or batch fails.

## Result shape

```ts
const result = await db.from("todos").insert(todo).select();
if (result.error) console.error(result.error.code, result.error.message);
console.log(result.data, result.meta?.receipts);
```

`Result<T>` contains `data`, `error`, optional `count`, and optional `meta`. An error can coexist with completed writes. Do not discard receipts just because `error` is set.

| Metadata | Meaning |
| --- | --- |
| `relays` | Relay URL, acknowledgement status, optional message |
| `partial` | Some relay operations failed; cannot detect undisclosed result limits |
| `receipts` | Record ID, signed event ID, and per-relay results |
| `nextCursor` | Token for a possible next cursor page |
| `cached` | Cache-only result |
| `queued` | Saved for later replay |

`count` describes returned or committed rows. It is not a global count.

## Acknowledgement threshold

The default `minWriteAcks` is `1`. Increase it in client options to require more relay acknowledgements. A failed threshold can still leave a record accepted by a relay. Acceptance does not prove permanent storage or delivery to all clients.

A batch is not atomic. It stops on the first failed record. In result mode, completed rows and receipts remain available. In throw mode, do not expect the same partial-result workflow.

## Error codes

| Code | Action |
| --- | --- |
| `INVALID_CONFIG` | Check namespace, relay URLs, timeouts, and option ranges |
| `INVALID_RECORD` | Check JSON data, schema, signature, or file descriptor |
| `INVALID_QUERY` | Check filters, authors, cursor, selection, and write scope |
| `AUTH_REQUIRED` | Connect a signer before this operation |
| `AUTH_FAILED` | Check signer connection, approval, and encryption support |
| `PERMISSION_DENIED` | Use the active author's records and queued events |
| `CONFLICT` | Inspect an existing record before replacing it |
| `RELAY_ERROR` | Inspect relay results and connection/policy |
| `PUBLISH_FAILED` | Inspect receipts; the acknowledgement threshold was not met |
| `NOT_FOUND` | Handle a missing row or reference |
| `MULTIPLE_ROWS` | Filter by author and ID before requesting one row |
| `ABORTED` | Check cancellation; a publish can already have reached a relay |
| `CLIENT_CLOSED` | Create a new client |

Invalid constructor options can throw immediately. Most SDK operations return `Result`. `ready()` and persistence `flush()` can reject. See each [API signature](/docs/reference/client/) for its return type.

## Retry safely

Use stable record IDs. After a timeout or cancellation, inspect receipts and reread the record before issuing a new mutation. The [offline queue](/docs/offline-writes/) replays exactly the original signed event, which handles a lost acknowledgement without creating a new event ID.
