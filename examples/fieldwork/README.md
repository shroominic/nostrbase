# Fieldwork

A working project board built with the **installed nostrbase SDK**. It has a responsive browser UI, shared projects and tasks, a personal notebook, attachments, and a developer console. The application server serves static files. Application data goes directly to Nostr and Blossom.

## Run it

From the repository root, with Node 22.12+:

```sh
npm ci
npm run example:setup
npm run example:dev
```

Open **http://127.0.0.1:4173**. Select **Connect identity → Use demo identity → Load sample project**.

Setup builds and packs the SDK, installs the archive into this separate application, checks its types, and bundles it for browsers. It uses the locked application dependencies. Archive names include their content hash, so an SDK change with the same version cannot reuse a stale installation.

The service runner starts **nak 0.20.7**, an independently maintained relay, with NIP-77 and its Blossom server. If a matching `nak` is not installed, setup downloads an official macOS/Linux release to `output/fieldwork` and verifies its pinned SHA-256 digest. Nothing is installed globally. Set `FIELDWORK_NAK` to select a binary.

Stop the runner with Ctrl-C. Each run uses a temporary service directory. Relay records and Blossom ownership lists are held in memory; the runner removes temporary files on exit. Browser ciphertext, signed events, and queued writes remain in IndexedDB. Use a new `?workspace=my-workspace` value for a separate workspace.

## Try the application

1. Open a task. Change its title or status. Attach a small text file and download it.
2. Open the same workspace in another browser profile. Connect a second demo identity. Tasks are shared, and foreign tasks are read-only. Each identity can add its own tasks to a shared project.
3. Send a room update. Check presence in the other window.
4. Save a private note. The other identity cannot read it. A duplicated tab with the same identity can receive private live changes.
5. Enable **Queue writes**, then add or edit a task. The local board changes, but the relay has not received that write. Open **Developer console → Replay queued writes** to deliver it.
6. Pause live updates. Add a task from the other profile. Use **Recover from relay** to pull the missed record through NIP-77. **Recover with REQ** uses normal queries.
7. Preview the revision-2 migration. Apply it and inspect a task. Only your records change.
8. Export a signed backup. Change an event's content and try to import it. Signature validation rejects the archive. Import an unchanged backup to restore the verified local cache.
9. Publish and read a native Nostr profile. Publish a public activity update to exercise native event subscriptions.
10. Inspect relay receipts, pending writes, and the local cache. Private note content stays out of the backup, inspector, and operation log.

## Feature map

| SDK feature | Application use | Browser check |
| --- | --- | --- |
| Typed schema and Zod validation | Project, task, and note definitions | Independent application TypeScript build; real writes/readback |
| Signer auth | Demo identity, NIP-07 extension, NIP-46 bunker | Demo sign-in/restore/sign-out; separate NIP-46 process |
| Public CRUD and author ownership | Shared board; each author edits their own cards | Two authors observe create/update/delete; foreign controls disabled |
| Filters and text search | Project references and task title search | Search after reading multiple pages |
| Cursor pagination | Six-card pages; load more | Nine distinct cards across page boundaries |
| References | Task → project, including project author | Task detail resolves the correct project |
| Live record changes | Shared tasks/projects | Two separate browser contexts |
| Broadcast and Presence | Live room updates and session count | Delivery and explicit leave; no ephemeral data in backups |
| Personal NIP-44 records | Private notebook | Cross-author isolation; same-author live tabs; ciphertext backup |
| Blossom | Attach, list, download, and remove files | Browser CORS and exact downloaded bytes against independent server |
| IndexedDB persistence | Verified cache and signed offline queue | Reload restores notes and queued tasks |
| Explicit offline replay | Queue writes; replay button | Actual offline browser; no delivery before replay |
| NIP-77 and query fallback | Recover after pausing live updates | Missing record recovery; separate run with NIP-77 disabled |
| Native Nostr events | Profile and public activity | Profile publish/query; public event subscription |
| NIP-50 search | Capability-gated developer control | Disabled when the relay does not advertise support |
| Migrations | Upgrade owned tasks to revision 2 | Preview does not write; apply preserves foreign records |
| Backups | Export, download, validate, and restore | Ciphertext export, invalid signature rejection, duplicate import |
| Inspector and diagnostics | Embedded dashboard and operation receipts | Private plaintext exclusion; visible sync strategies |

This demonstrates available SDK features. SQL joins, transactions, server functions, server-enforced application roles, and shared encrypted workspaces are outside the SDK's current feature set.

## Test it

```sh
npx playwright install chromium firefox webkit
npm run example:test
npm run example:test:fallback
```

The application suite runs **11 user flows in Chromium, Firefox, and WebKit**. Tests operate the UI and real browser APIs. They do not replace the SDK transport, signatures, IndexedDB, encryption, or file requests with mocks. Every run starts its own independent local services and uses unique namespaces and generated identities.

The fallback command disables NIP-77 in the relay and runs the recovery flow in Chromium. A fallback result cannot count as a successful NIP-77 result. NIP-50 is not supported by this relay and is not reported as tested successfully.

Reports and failed-run traces are under `output/fieldwork`. The separate `fieldwork.yml` workflow defines the same checks for hosted CI. Hosted execution must be verified separately.

## Application structure

| File | Responsibility |
| --- | --- |
| `src/workspace.ts` | Typed schema, client configuration, result policy, task operations, subscriptions, cleanup |
| `src/main.ts` | Screens, forms, auth controls, file downloads, recovery/migration/backup tools |
| `src/style.css` | Responsive layout, keyboard focus, reduced motion |
| `build.mjs` | Bundle the installed package without source aliases |
| `serve.mjs` | Loopback static file server; no application API |
| `e2e/workspace.spec.ts` | Named user-flow contracts |

The SDK import is always `from "nostrbase"`. The application's TypeScript configuration has **no path alias to SDK source**. The SDK package excludes the example app's dependencies and build output.

## Use your own services

Build the example, then serve its static files with `npm --prefix examples/fieldwork run dev`. Supply service origins in the URL:

```text
http://127.0.0.1:4173/?workspace=com.yourapp.board&relay=wss%3A%2F%2Frelay.example&blossom=https%3A%2F%2Ffiles.example
```

The relay must accept kinds 30078, 5, 20078, 0, and 1. NIP-77 is optional. The Blossom origin must permit browser CORS. A NIP-46 signer uses the relays specified in its bunker URI. Use a Nostr signer extension for a user-controlled identity; demo keys are for local tests.

## Limits of this example

- `nak serve` is development software with in-memory relay storage. Passing its tests does not establish production relay retention, limits, authentication, or availability.
- The NIP-46 test uses the real Applesauce provider in another OS process. It does not automate a third-party wallet's approval screen. The NIP-07 UI is implemented, but this app suite does not automate a real extension.
- Private notes are encrypted for the current identity. Files, tasks, profiles, presence, and broadcasts are public.
- Offline writes work after the app loads. There is no service worker. The offline test restores HTTP access before reloading the page; it proves durable queue recovery, not offline page installation or a forced process crash.
- A backup restores signed records to the local cache. It does not republish them, back up Blossom file bytes, or transfer ownership.
- Local text search filters records available to the client. NIP-50 support is a separate relay capability.
- Mobile checks resize real desktop engines. They do not test physical mobile devices.
- The example is a developer test application. It does not establish readiness for unattended production deployment.

See [developer experience](DEVELOPER-EXPERIENCE.md) for implementation findings.
