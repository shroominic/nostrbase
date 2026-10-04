# From Supabase

Map familiar APIs to the guarantees Nostr provides.

## Keep the interface, change the model

```ts
// Supabase
const supabase = createClient(projectUrl, anonKey);
await supabase.from("todos").select().eq("done", false);

// nostrbase
const db = createClient({ namespace: "my-app", relays });
await db.from("todos").select().author(pubkey).eq("done", false);
```

| Supabase concept | nostrbase equivalent |
| --- | --- |
| Project URL and API key | Namespace and relay URLs |
| User ID / JWT | Signer's public key; no JWT |
| SQL row | Latest signed event at an author-scoped address |
| Update in place | New signed version |
| Row Level Security (RLS) | Author write checks; public reads remain public |
| Private row policy | Personal NIP-44 encrypted body |
| Realtime | Verified table events; ephemeral Broadcast/Presence |
| Storage bucket / path | Blossom server / SHA-256 object |
| Foreign key | JSON reference resolved in the client |
| Database migration | Validated rewrites of your own records |
| Hosted logs and dashboard | Local diagnostics and cache inspector |

## Available features

Typed CRUD, upsert, filters, projections, sorting, pages, signer auth, live changes, Broadcast, Presence, personal private tables, Blossom storage, persistence, explicit queued writes, Negentropy recovery, search, schemas, references, migrations, backups, and local tooling are implemented.

## Partial equivalents

Pagination and counts cover known relay results. Search uses local string matching or relay-dependent NIP-50. References do not enforce foreign keys. Schema checks run in the client. Presence is approximate. Backups cover cached events.

## Features that need another layer

SQL, server joins, atomic transactions, global constraints, configurable relay-enforced access rules, shared encrypted collections, email/password/OAuth/MFA, Edge Functions/RPC, trusted jobs/webhooks, vector indexing, image transforms, and managed hosting are not supplied.

A modified client can bypass app rules. Put rules that must be enforced for every participant in a controlled relay or authoritative service. Strong transactions across independent relays require a coordination model.

## Migration checklist

1. Decide which data is public and which is personal encrypted data.
2. Include the author in record identity and references.
3. Replace server field queries with narrow relay scope and client predicates.
4. Handle partial writes, version conflicts, and deletion requests.
5. Select and test relays and optional file servers.

Start with a profile, feed, directory, todo app, or personal encrypted notebook. Evaluate extra infrastructure before porting shared private or transaction-dependent workflows.
