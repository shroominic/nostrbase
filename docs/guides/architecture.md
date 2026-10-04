# How it works

Familiar table calls become signed events. Relays store and deliver them.

## Write path

1. Serialize a JSON record into a NIP-78 kind `30078` event.
2. Tag it with the namespace, table, and record ID.
3. Ask the active Applesauce signer for a signature.
4. Publish it through Applesauce RelayPool.
5. Return per-relay acknowledgements and a signed-event receipt.

Record identity is **namespace + table + author + ID**. Two authors can use the same ID.

## Read path

1. Request records and deletion events from the configured relays.
2. Verify signatures and the record envelope.
3. Resolve each address to its latest valid version.
4. Apply field filters, sorting, and selection in the client.
5. Return rows with `id` and `_nostr` metadata.

Namespace, author, and ID narrow relay requests. A relay can limit results or prune history. End of stored events (EOSE) does not prove a complete global table.

## Updates and deletes

An update signs a new event at the same address. The highest `created_at` wins; a timestamp tie uses the lowest event ID. Writes in one client are serialized. Separate devices can overwrite each other.

A delete signs a NIP-09 kind `5` request. The SDK uses tombstones to hide old versions. Relays decide whether to remove their stored copies. A newer event can recreate the record.

## What runs where

| Component | Responsibility |
| --- | --- |
| Your app | UI, trusted-author rules, field queries, validation |
| nostrbase | Record encoding, ownership, version resolution, receipts |
| Applesauce | Signers, relay connections, EventStore, Negentropy |
| Nostr relay | Event storage, queries, delivery, relay policy |
| Blossom server, optional | HTTP file storage |
| IndexedDB, optional | Device cache and signed write queue |

A **client-side query** runs in the app and can fetch relay data. A **cache-only query** uses `.local()` and sends no relay request.

## Access and consistency

A signature proves origin. It does not prove truth, app approval, or permission to join a collection. Namespaces label data; they do not restrict access.

Public tables are public. [Personal private tables](/docs/private-tables/) encrypt bodies to the author. Transactions, global uniqueness, shared private groups, and trusted server functions require more protocols or services.

Use [native events](/docs/native-events/) when interoperability calls for an existing Nostr kind. Use tables for application records. [Wire format](/docs/protocol/).
