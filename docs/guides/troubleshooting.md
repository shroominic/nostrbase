# Troubleshooting

Find the cause without discarding accepted writes.

## No rows appear

Check the namespace, table, relay URL, author, and schema. Reads are public by default; private reads require the author and a NIP-44 signer. Create a new builder to refresh an already-awaited query.

Inspect `meta.relays` and [diagnostics](/docs/diagnostics/). A relay can accept a connection while refusing a kind or capping results. A fresh empty client can distinguish relay state from optimistic cached state.

## A write fails but a row exists

Some relays accepted it, the acknowledgement threshold failed, or a response was lost. Inspect `meta.receipts`. Reread with the same author and ID before retrying. A batch can leave earlier records committed.

## Sign-in or private decryption fails

Call extension sign-in from a user action. Check extension availability and requested approval. Check NIP-44 support for private tables. Remote signer connections and NIP-42 relay authentication have separate lifecycles.

## Deleted records return

Keep tombstones when persisting or importing records. Check whether the relay supplies NIP-09 deletion requests or removes targeted records. A newer signed version can intentionally recreate the address.

## Queue entries remain

Sign in as the original author and call `db.offline.flush()` explicitly. Check relay receipts and `minWriteAcks`. To enable replay after reconnect and bounded retries, set `offline.autoReplay`. Inspect `autoReplayStatus.lastResult` and callbacks for failures. Removing an entry does not roll back its optimistic cache state.

## Presence or Broadcast is missing

Check that the relay delivers kind `20078`. Self Broadcast is off by default. Presence is learned from heartbeats and expires after TTL; it is not an authoritative online roster. Negentropy cannot recover ephemeral messages.

## Cursor pages look incomplete

Keep the same author and field filters, and use the same public/private route. Relays can cap or prune results; concurrent edits can move records between pages. A cursor does not freeze a snapshot.

## Cache fails or grows

Inspect persistence `onError`; retry `flush()` for a failed batch. Browser storage can be cleared or quota-limited. History and tombstones have no automatic eviction. Keep tombstones with any retained records.

## File requests fail

Use the final HTTP(S) server origin with no path. Redirects are rejected. Check CORS, signer approval, server policy, and whether listing is supported. Upload/download hashes must match. Private tables do not encrypt file bytes.
