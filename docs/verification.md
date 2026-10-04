# Verification

Date: 4 October 2026, Asia/Bangkok.

Version 0.2.0 and the current test expansion were checked locally. Public service checks use a generated development identity. Hosted GitHub workflows and npm publication have not been run.

## Marmot private collections

This change adds experimental shared private collections with a pinned Marmot engine. It starts from clean `main` commit `ca9ca52` in a managed worktree on `feature/marmot-private-collections`. The API, encrypted wire format, example, and dependency provenance are documented together. See [groups](groups.md) and [vendor provenance](../vendor/README.md).

Acceptance covers authenticated group admission, author-owned CRUD, canonical MLS projection, encrypted device storage, offline intents, exact-envelope retries, preserved partial receipts, and recovery after publication or receive persistence failure. Independent subagent review covered transport trust, publication journals, received record admission, Welcome recovery, and account/device isolation. This is implementation review, not a cryptographic audit.

The new tests use real signed events, the pinned MLS engine, actual loopback WebSockets through Applesauce, controlled storage failures, and simulated IndexedDB. They cover invite/join, signed history snapshots, live CRUD, three-member removal, schema and author checks, same-batch removal admission, restart/auth isolation, repeated Welcome failures, exact rejected-envelope replay, partial acknowledgements, and queued write composition.

| Check on 4 October 2026 | Result |
| --- | --- |
| Frozen SDK and site installs | Passed with strict installer policy; zero reported dependency advisories |
| `CI=true npm run check-ci` on Node 26.3.0, npm 11.16.0 | Passed: formatting, lint, types, 292 SDK tests in 26 files, ESM/declarations, docs, source secrets, four workflows, six baseline tests, and 8/8 deliberate faults |
| Documentation compiler/link check | Passed: 78 content pages, 80 generated pages, 4889 local links/assets, 100 local and 8 external exports; zero compiler errors or warnings |
| All new group tests on Node 22.12.0 | Passed: 68 tests in eight files |
| Engine convergence scheduling and group lifecycle | Passed: 27 upstream tests; independent review approved the timer correction |
| Fresh npm-installed archive consumer | Passed on Node 22.12.0 and 26.3.0: group types, CRUD, queue/flush, restart, installed patch, and browser module bundle |

The first frozen SDK run found a lost convergence timer wake. An early host callback could leave an invitation waiting after the real deadline. The engine patch rounds delays up and schedules another check after an early wake, while retaining the original convergence and lifecycle gates. The same-batch removal test forces that boundary: it failed against the old runtime and passes against the rebuilt archive. Source is unchanged by the test runner. Full results are retained in `output/marmot-check-ci.log` and `output/marmot-node22.log` in the managed worktree.

A separate empty npm app installs the SDK archive with registry dependencies, without source links. Its TypeScript consumer checks group types, CRUD, queue/flush, stored-state restart, ciphertext-only wire data, and the installed engine patch. The same app runs on Node 22.12.0 and 26.3.0 and bundles for a browser. Node 22.12 emits its experimental Ed25519/X25519 Web Crypto warnings. The all-exports browser bundle is about 2.2 MB before minification; this is a module-resolution check, not a browser performance result.

The engine archive is precompiled. Its upstream `prepare` entry remains in package metadata, so the consumer's strict npm policy reports that script as unapproved. The recorded install does not require that script to run. The local feature commit uses the existing unsigned fallback after the baseline's recorded 1Password signing failures; Git signing settings remain unchanged.

Group tests do not establish released White Noise interoperability, a production cryptographic audit, real-browser group storage behavior, multi-writer device coordination, or permanent relay retention. Group recovery uses ordinary Nostr requests; Negentropy remains available for public/personal record synchronization. The engine snapshot remains experimental and unpublished by this project.

## Engineering baseline completion

The baseline keeps npm, Biome, TypeScript, Vitest, Playwright, and the existing SDK/test architecture. Independent static review found and resolved deletion-only hook handling and source-symlink snapshot boundaries. The [engineering guide](engineering.md) records the inventory, command contract, worktree policy, ownership, controls, and external setup limits.

| Check on 4 October 2026 | Result |
| --- | --- |
| Fresh isolated worktree from `18afd4d942e5b9bc80dc253ddc87c644fb9564ed`, final code at `0443664d3994c37cadf94566f5ed62cc6a0bb3a9` | Frozen SDK/site/extension installs pass with strict version-specific installer approvals |
| `CI=true npm run check-ci` on Node 26.3.0, npm 11.16.0 | Passed: formatting, lint without warnings, types, 224 SDK tests, ESM/declarations, documentation build, source secrets, four workflows, six baseline tests, and 8/8 deliberate faults |
| Documentation compiler/link check | Passed: 76 pages, 4511 local links/assets in the final build; 58 guide snippets and four complete quickstarts checked |
| Hook/scanner regressions | Passed: partial staging, hidden format errors, hidden keys with redaction, untracked keys, deletion-only types, and direct/parent directory symlink boundaries |
| Gitleaks source, staged snapshot, and all local history | Passed with no suppressions; two source commits scanned in the history check |
| Four npm lockfile audits | Zero reported advisories; reports remain visible rather than imposing an unowned severity policy |
| Strict npm negative check | An unreviewed local fixture installer is rejected before execution |
| Fieldwork bootstrap and frozen reinstall | Fresh SDK archive, independent app TypeScript/browser build, and strict-policy `npm ci --prefix examples/fieldwork` pass |

The control checkout is `/Users/fungus/dev/nostrbase` on `main`. The isolated verification checkout is `/Users/fungus/dev/_worktrees/nostrbase/chore/baseline-verification` on `chore/baseline-verification`. Local hooks use `.githooks`; fresh clones must enable them explicitly. The inventory script now completes against the recorded Git base.

The configured 1Password signer failed twice with `failed to fill whole buffer`. Follow-up local baseline commits use a per-command unsigned fallback; Git signing settings were not changed. No remote, branch protection, named CODEOWNERS accounts, vulnerability reporting destination, or npm publication account is configured. Those controls remain external owner decisions. Hosted Actions execution is unverified.

The full fresh-check log is `output/baseline-check-ci.log` in the verification worktree. Baseline tests do not require public services or add a coverage target.

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

## Previous test expansion

Before Marmot groups, the suite had **224 tests across 18 files**, split into 174 unit/component tests and 50 integration tests. Both projects passed locally on Node 22.12.0 and 26.3.0. The [testing guide](testing.md) maps the current tests to contracts and explains fixtures, commands, and limits.

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
