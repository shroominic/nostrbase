# Verification

Date: 4 October 2026, Asia/Bangkok.

Version 0.2.0 and the current test expansion were checked locally. Public service checks use a generated development identity. Hosted GitHub workflows and npm publication have not been run.

## Environment integration expansion

Eight separate local projects add **68 check executions**. The aggregate `npm run test-extended` passes on Node 26.3.0. Every infrastructure project also passes on Node 22.12.0. Browser and extension project results below use Node 26.3.0.

| Project | Actual environment | Result |
| --- | --- | --- |
| `relay-service` | Digest-pinned nostr-rs-relay 0.10.0 and strfry 1.1.3 | 14 passed |
| `blossom-service` | Unmodified hzrd149/blossom-server 6.4.0, pinned commit, Deno 2.9.6, plus Chromium CORS | 8 passed |
| `remote-signer` | Applesauce NostrConnectProvider 6.2.3 in a separate process over nostr-rs-relay | 4 passed |
| `network-faults` | Controlled WebSocket/HTTP proxies to strfry and upstream Blossom | 6 passed |
| `crash-recovery` | Real Chromium SIGKILL, persistent profile, real IndexedDB | 4 passed |
| `load` | Real strfry sockets, 20-second sustained workload and 64-record batch | 2 passed |
| Browser | Real Chromium, Firefox, and WebKit IndexedDB; Chromium quota rejection | 25 passed: 9 + 8 + 8 |
| Extension | Actual nos2x 2.5.2 in persistent Chromium; real options and permission windows | 5 passed |

`npm run prepare:integrations` passes. It downloads and verifies the pinned service sources/images, browser engines, and isolated locked extension build. Missing prerequisites fail explicitly. The [environment guide](../integration/README.md) links each project's contracts, setup, provenance, artifacts, and limits.

The load project checks exact notifications, request/socket cleanup, channel timers, cache exclusion for ephemeral traffic, bounded diagnostics, replay identities, and cursor completeness. Metrics are retained under `output/environment/load/`. Queue insertion repeatedly verifies earlier entries, which causes quadratic cryptographic work. The measured 64-record batch takes about 11 seconds on this host. This cost is documented; no claim of efficient large queues or production throughput is made.

The NIP-46 tests also record the current private-read contract: decryption permission denial causes unreadable records to be omitted. Direct provider denial is verified, and no plaintext is returned. The SDK does not distinguish that denial from other unreadable ciphertext in a private query result.

No new SDK source change was needed for these environment projects. Test harness corrections included actual service configuration, timer ownership, result shapes, deterministic timestamp ties, and extension prompt sequencing.

The new GitHub integration workflow defines ten isolated jobs: six infrastructure projects, three browser engines, and one extension job. Static validation with actionlint 1.7.12 passes. Actions use pinned commits and collect failure artifacts. There is no Git remote, so hosted execution remains unverified.

## Public deployment checks

The separate `live-services` project has six checks. All six pass against local strfry and Blossom in both read-only and write modes. Missing endpoint configuration fails explicitly. Public reads and writes below were authorized by the user and used generated test identities and unique test namespaces.

| Deployment | Observed result on 4 October 2026 |
| --- | --- |
| `wss://search.nos.today`, searchnos `v0.1.0-841b8f6` | Real NIP-50 search completed and returned signed events. Ordinary reads require a search filter. Publications and signed cleanup were rejected with `blocked: writes disabled`; seeded indexing was not verified. |
| `wss://relay.damus.io`, strfry `1.1.0-158-gb705403ddf49` | Ordinary reads, record publication/readback, and signed deletion succeeded. Fresh-client query recovery succeeded in one complete run; a later bounded recovery request did not complete. Legacy `negentropy: 1` is advertised, but the server answered direct negotiation with `ERROR: bad msg: negentropy disabled`. The strict capability check correctly fails. |
| `https://blossom.band` | Signed list and browser preflight checks succeeded. A unique 158-byte PNG upload returned the correct hash, and signed deletion succeeded. SDK download rejects the service's redirect under the existing storage policy. A separate unauthenticated diagnostic followed the descriptor's 307 redirect to `image.nostr.build`, received 200, and verified the exact bytes and hash. |

Public compatibility checks did **not** all pass. These results describe the selected deployments at the time of the requests. The SDK's redirect rejection remains unchanged; the independent CDN diagnostic does not establish SDK download compatibility. Small text/JSON fixtures also encountered the public Blossom service's MIME policies.

One initial Damus run accepted a synthetic record, but its cleanup failed and that run discarded its generated key. **That record may remain on the relay.** The retained report identifies the public key and namespace; the [live project guide](../integration/live/README.md) records the available cleanup evidence. The public driver now retains a dedicated key outside CI artifact paths when cleanup is unconfirmed. Later accepted deletion requests do not prove removal from every remote copy.

Evidence remains in `output/environment/live/`, including `compatibility-1791104500826-73172.json` for the initial cleanup failure, `negentropy-probe-1791105066603.json` for the server notice, and `compatibility-1791105422565-253.json` for PNG upload, CDN byte verification, and deletion. The [live project guide](../integration/live/README.md) documents configuration and repeatable commands.

## Test expansion

The current suite has **224 tests across 18 files**, split into 174 unit/component tests and 50 integration tests. Both projects pass locally on Node 22.12.0 and 26.3.0. The [testing guide](testing.md) maps tests to contracts and explains fixtures, commands, and limits.

| Current check | Result |
| --- | --- |
| `npm run check` on Node 26.3.0 | Passed: formatting, lint without warnings, types, 224 tests, ESM and declarations |
| Full suite on Node 22.12.0 | Passed: 224 tests, including the archive consumer and browser bundle |
| Deliberate-fault checks on Node 22.12.0 and 26.3.0 | Passed: 8/8 faults detected on each version |

Eight deliberate faults were each detected by their corresponding assertion in a disposable copy. The checked behaviors include cache isolation, cancellation, signed publication snapshots, observer isolation, stale deletion handling, durable enqueue order, record namespace checks, and write ownership.

New real loopback HTTP tests verify Blossom authorization, binary integrity, redirects, partial deletion, and cancellation while reading the response body. New WebSocket tests verify private changes across clients, shared relay-pool ownership, incomplete reads, unrelated acknowledgements, CLOSED messages, and a complete IndexedDB restart/queue/recovery/deletion workflow.

The package test now builds and unpacks a fresh archive automatically. It compiles a separate consumer against packaged declarations, runs public/private queued CRUD, checks all 35 runtime exports, and bundles the packaged SDK for a browser. Dependency directories are linked from the local locked installation; this does not replace a fresh registry install.

The regressions found during this expansion were fixed: cancelled public cache reads, mutable signed native publications, shared event references in the verified cache, public/private/native observer payload mutation, and false deletion changes for old versions. No record encoding or public API signature changed.

## Fieldwork application

The [Fieldwork example](../examples/fieldwork/README.md) consumes a newly packed SDK archive in its own npm project, with no source aliases. Its independent TypeScript build and browser bundle pass.

| Check on 4 October 2026 | Result |
| --- | --- |
| `npm run check` on Node 26.3.0 after adding the app | Passed: formatting, lint, types, 224 SDK tests, ESM and declarations |
| `npm run example:test` | Passed: 11 app flows × Chromium, Firefox, and WebKit = 33 checks |
| `npm run example:test:fallback` | Passed: missed-record recovery uses REQ and reports the NIP-77 fallback reason |
| Independent relay and Blossom | `nak 0.20.7`, separately spawned; browser CORS and file-byte verification pass |
| NIP-46 app auth | Separate Applesauce provider process; app public signing and private encryption pass in all three engines |
| Package setup | Fresh packed SDK installed through npm; unchanged archive can be reinstalled with `npm ci` |

The app checks public live CRUD across authors, references, private notes and same-author live tabs, offline queue recovery through a page reload, explicit replay, file upload/list/download/removal, presence, Broadcast, native activity/profile events, pagination/search, migration preview/application, backup validation, inspector privacy, and mobile layout. The private-note flow also checks that the real IndexedDB store contains ciphertext and excludes note plaintext in all three engines.

NIP-77 recovery must retrieve an event missed while the app's live channel was paused. The normal run requires `strategy: negentropy`; the fallback run disables NIP-77 in the independent relay and requires `strategy: query` with a reason. NIP-50 is not supported by this relay; its UI is disabled and no search success is claimed.

The app suite does not test a real NIP-07 extension or third-party wallet approval UI. Its relay storage is in memory. Its offline test restores HTTP access before page reload and does not force a browser process crash. Physical devices, production retention, sustained production traffic, and hosted execution of `fieldwork.yml` remain outside this evidence. The [developer experience report](../examples/fieldwork/DEVELOPER-EXPERIENCE.md) separates app defects, API observations, and follow-up proposals.

## Previous release checks

The results below describe the earlier 107-test release check. They are retained as historical evidence; they do not imply that every check was rerun after the test expansion.

| Check | Result |
| --- | --- |
| `npm run check` | Passed: formatting, lint without warnings, TypeScript, 107 tests, ESM and declaration build |
| `npm ci` and `npm run check` in a separate copy without node_modules or dist | Passed |
| Full test suite and build on Node 22.12.0 | Passed |
| Full test suite and build on Node 26.3.0 | Passed |
| `npm audit` | Zero reported advisories |
| `npm pack` with prepack gates | Passed: local 0.2.0 archive |
| Archive installed in a separate consumer project | Passed: package JavaScript matches the SDK build |
| Consumer ESM exports, auth, queries, and cleanup | Passed: all 35 runtime exports load; closeAsync leaves zero subscriptions |
| Consumer TypeScript schema inference, projections, and invalid query checks | Passed |
| Consumer encrypted offline CRUD and extended APIs | Passed with simulated transport |
| Browser target bundle through esbuild | Passed: no unresolved imports |

The 107 tests cover seven suites: SDK behavior, type contracts, relay integration, realtime, private records/storage, offline/sync, and developer tools. Real local WebSocket tests cover public CRUD, live changes, Broadcast, Presence, NIP-77 NEG-OPEN/NEG-MSG/NEG-CLOSE exchange, query fallback, relay rejection, timeouts, acknowledgement thresholds, and cancellation.

Persistence tests use fake-indexeddb, including namespace isolation and restart recovery. Storage tests use a simulated Blossom HTTP service, including authorization scope, hashes, errors, and aborts. Tool tests cover Zod, cursor ties and stale version recovery, references, legacy migrations, backups, tombstones, diagnostics, and safe dashboard rendering. Regression tests reject signature verification cache bypasses, account changes during signing/publication, stale private subscription events, duplicate relay echoes, and queued deletion omissions.

Three subagents implemented realtime, private/storage, and offline/sync. One subagent also reviewed the integration and installed the packed SDK into a separate consumer project. Consumer checks cover schema inference, public CRUD, encrypted queued CRUD, references, text search, Broadcast/Presence, backups, dashboard privacy, migration previews, sync fallback, and cleanup.

At this earlier release check, the NIP-07 test used a simulated window.nostr signer. Real browser, extension, signer and service checks were added later as described above. Public retention, deployment availability and hosted CI remain specific to the selected environment. Node 24 is in the CI matrix but was not run locally. The earlier 107-test suite and build passed on Node 22.12.0 and 26.3.0.

The browser bundle check verifies module compatibility. Dashboard tests verify generated HTML and snapshot privacy; they do not establish live browser UI behavior. These checks do not measure performance or validate a deployed application. Relay acknowledgements do not establish global completeness, permanent retention, or deletion from every copy.
