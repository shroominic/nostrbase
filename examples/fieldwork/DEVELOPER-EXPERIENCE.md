# Building Fieldwork with nostrbase

## What this implementation tested

The example installs an actual SDK archive, uses its public TypeScript declarations, bundles it for browsers, and implements working user flows. No application code imports SDK source or implements relay wire messages. This tests whether the SDK can support an application from a consumer's point of view.

## What feels familiar

The public table API takes little application glue:

```ts
const result = await db
  .from("tasks")
  .update({ status: "done" })
  .author(task._nostr.pubkey)
  .eq("id", task.id)
  .select()
  .single();
```

Zod definitions infer the database shape. The installed declarations caught app integration mistakes during the independent build. Private tables use the same query builder. Files use a bucket-style API. Migration previews, signed backups, and dashboard mounting can be used without an application server.

An actual NIP-46 signer works through `db.auth.signInWithSigner`. It needs an Applesauce pool when created with `NostrConnectSigner.fromBunkerURI(uri, { pool: db.pool })`. The application must also close that signer's connection at sign-out and page exit.

## Decisions the application still has to make

| Decision | What Fieldwork does | Why it matters |
| --- | --- | --- |
| Record identity | Keep the author and row ID in task controls and references | Two authors can use the same row ID |
| Shared editing | Let users add their own tasks to a project; foreign tasks are read-only | The project owner's signature cannot be replaced by another user |
| Result handling | Check `error`, keep receipts, retain the last failed result | Some operations can return committed data and an error together |
| Offline writes | Choose `.queue()` explicitly and provide a replay control | A visible local record does not imply relay delivery |
| Cache use | Refresh the UI from `.local()` after live changes | A live event should not trigger another full network table read |
| Search and references | Filter records in the client; resolve references by author and ID | This is not server-side SQL or an enforced foreign key |
| Reconciliation | Show the actual sync strategy and fallback reason | `auto` can fall back to REQ when NIP-77 is absent |
| Personal data | Keep private notes separate from public cards and files | Personal encryption does not create shared access policies |
| Identity persistence | Demo key in tab session storage; ciphertext/events in IndexedDB | Cache persistence does not restore an extension or remote wallet session |
| Runtime lifetime | Dispose subscriptions and close the client and remote signer | Page exits and account changes must release resources |

## Problems found in the application build

1. **Actions during long operations.** An initial global busy flag discarded a second click while sample data was loading. User actions now run in order. The active action shows a busy state.
2. **Pagination and live refresh.** Refreshing the board at a fixed six-card limit collapsed an expanded page. Refreshes now preserve the loaded size and discard outdated asynchronous responses.
3. **New cards and event ordering.** A newly inserted task can sort below other recently rewritten tasks. The application keeps the newly created card visible after refreshing instead of assuming it must be the first result.
4. **Private subscription lifecycle.** Private table subscriptions need an async identity-bound lifecycle. Public native event subscriptions must remain active when a user signs out. The app now separates those cleanup scopes.
5. **Capability reporting.** A NIP-50 request cannot prove that a relay implemented search. The app reads NIP-11 and disables the control when NIP-50 is not advertised. NIP-77 tests require the reported strategy and an actual missed record.
6. **Package installation.** Replacing an archive without changing its version can leave a consumer using an old installation. Setup gives each packed archive an immutable content-based filename.
7. **Browser UI details.** Decorative navigation icons changed accessible names, and a later CSS rule overrode `hidden`. Icons are hidden from accessibility names, and hidden content stays hidden.

8. **Official service version strings.** The release binary reports `v0.20.7`; the system package reports `0.20.7`. The runner accepts both spellings of the pinned version. The downloaded release was checked against its SHA-256 digest.

These were application and tooling defects. This implementation has not established a new SDK defect. The SDK's existing regression tests remain separate evidence.

## Suggested SDK improvements

These are follow-up proposals, not implemented features:

- An application recipe for typed results that preserves partial data and receipts.
- A single documented pattern for public channels, private subscriptions, auth changes, and remote signer cleanup.
- A capability API that returns NIP-11 support and observed NIP-77 fallback status.
- Guidance for keeping paginated views stable while new versions arrive.
- Examples for scalar project indexes and bounded data reads as a workspace grows.

## Production assessment

The SDK supports this application with a static frontend, a relay, a Blossom server, and a signer. The familiar API is useful. The application still needs explicit decisions about authorship, cache freshness, partial delivery, and service capabilities.

The browser checks cover functional workflows. They do not measure production traffic, verify storage retention, establish shared editing permissions, or certify an external signer UI. The [example README](README.md) records the service and environment limits.
