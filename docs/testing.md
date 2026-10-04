# Testing

## Purpose

Protect the SDK contracts that apps depend on: signed data, author ownership, convergent records, precise partial results, durable writes, and released resources.

The fast suite has **430 tests in 33 files**. Separate environment projects add browser and external service checks. Tests are selected by risk and behavior. There is no line coverage target. Each test name states its contract or the failure it prevents. A passing suite establishes the stated behaviors within the tested environment.

## Run the suite

Use Node 22.12+ and install the locked dependencies with `npm ci`.

| Command | Purpose |
| --- | --- |
| `npm run test-unit` | Functions, signer races, SDK behavior, cache isolation, durable commit faults, private group state, and type contracts |
| `npm run test-integration` | Relay messages, realtime, recovery, persistence, private group membership, real HTTP storage, and the built package |
| `npm test` | Both Vitest projects |
| `npm run test-mutations` | Check that eight named contract tests detect deliberate faults |
| `npm run check` | Formatting, lint, TypeScript, both test projects, and ESM/declaration build |
| `npm run prepare:integrations` | Download pinned independent services, browsers, and extension inputs |
| `npm run test-environments` | Independent relay, Blossom, NIP-46, network fault, crash, and bounded load projects |
| `npm run test-browser` | Real IndexedDB and browser lifecycle checks in Chromium, Firefox, and WebKit |
| `npm run test-extension` | Actual NIP-07 extension permission and signing checks |
| `npm run test-extended` | All local environment and browser projects |
| `npm run test-live-services` | Explicitly configured deployment checks; excluded from the local aggregate |

Select one failure contract while working:

```sh
npm run test-unit -- -t "a failed durable enqueue"
npx vitest run --project integration tests/network.integration.test.ts
```

`npm run typecheck` is required for type tests. Vitest transpiles TypeScript; it does not replace the compiler's checks of `expectTypeOf` and `@ts-expect-error` contracts. The package test also invokes TypeScript in a separate consumer directory.

The integration project includes existing mixed suites. Their simulated transport tests remain there with the related WebSocket and persistence tests.

## Separate environment projects

See the [environment guide](../integration/README.md) for prerequisites, software provenance, commands, artifacts, and each project's purpose. The named Vitest projects are defined in `vitest.environment.config.ts`. Browser and extension checks have separate Playwright configurations. They are excluded from `npm test` so the fast gate remains available without Docker or downloaded browsers.

Each environment project must run its actual boundary. Independent relay and Blossom checks use pinned upstream software. Real browser checks use browser IndexedDB. Remote signing uses an Applesauce NIP-46 provider in another process. Extension signing uses a loaded upstream extension. Network faults use controlled proxies, and crash checks terminate test processes abruptly. A missing prerequisite fails with setup instructions. Tests are not silently skipped.

Live-service checks require explicit endpoints. They default to read-only operations. Writes require a separate operator flag and a test identity. There are no default public relay or Blossom URLs.

## Contract and risk map

| Area | Failure prevented | Evidence |
| --- | --- | --- |
| Record encoding | Ambiguous addresses, changed JSON types, omitted false/zero indexes, unsupported versions, incorrect scope, invalid creation times | `protocol.unit.test.ts`, `sdk.test.ts` |
| Signature verification | Forged fields, malformed wire objects, and reused verification symbols expose unsigned data | `protocol.unit.test.ts`, `tooling.test.ts`, `network.integration.test.ts` |
| Auth and signing | An older sign-in overwrites a newer one; sign-out or signer mutation permits a delayed write; observer errors change auth state | `auth-transport.unit.test.ts`, `sdk.test.ts`, `tooling.test.ts` |
| Key backup | Wrong passwords replace a session; malformed envelopes run an unbounded KDF; cancellation exposes key data; backup errors contain secrets | `key-backup.unit.test.ts`, browser `recovery.spec.ts` |
| Rich queries | Logical branches discard candidates; JSON paths read inherited values; mutated filter input changes queries; count changes with page size | `query.unit.test.ts`, `rich-query-types.unit.test.ts`, `rich-queries.integration.test.ts` |
| Automatic replay | Duplicate concurrent loops, old callbacks change a new loop, auth transitions send stale work, rejected queues disappear, group recovery returns stale state | `auto-replay.unit.test.ts`, `auto-replay.integration.test.ts`, browser `recovery.spec.ts` |
| Image processing | Transform pixels or orientation are wrong; padding flattens alpha; oversized cover intermediates fail; upload hashes identify original bytes; download transforms unverified bytes | `image-processing.integration.test.ts`, browser `images.spec.ts` |
| Query semantics | Coerced comparisons, incorrect subsets, missing/null confusion, wrong sort/range order, widened empty ID filters, invalid queries reaching a relay | `query.unit.test.ts`, `sdk.test.ts` |
| Cursor pages | Equal timestamps duplicate boundaries, a foreign cursor crosses scope, or an old version reappears because newer versions were outside a cursor bound | `tooling.test.ts`, `private-storage.test.ts` |
| Record convergence | Arrival order, duplicate echoes, unauthorized tombstones, or deletion/recreation change the final record | `state.unit.test.ts`, `sdk.test.ts` |
| Mutation results | Cancellation or a middle batch failure loses committed data, attempted receipts, or the write lock | `state.unit.test.ts`, `sdk.test.ts`, `private-storage.test.ts` |
| Cache ownership | A transport, native query result, or callback changes verified data without a new signature | `cache-isolation.unit.test.ts`, `state.unit.test.ts` |
| Channels | False deletes, changed observer payloads, duplicate changes, filter transition errors, or leaked subscriptions | `state.unit.test.ts`, `sdk.test.ts`, `relay.test.ts` |
| Broadcast and Presence | Expired or out-of-scope traffic is accepted; stale heartbeats restore a departed session; queued ephemeral traffic or signer changes leak state | `realtime.test.ts` |
| Personal encryption | Plaintext enters wire/cache/backups; another author reads data; slow decrypt/publish crosses an account change; old versions emit changes | `private-storage.test.ts`, `cache-isolation.unit.test.ts`, `state.unit.test.ts`, `network.integration.test.ts` |
| Group trust and membership | Forged or foreign proofs enter private records; removed authors gain new writes; noncanonical branches stay visible; peer relay metadata selects unauthorized destinations | `group-records.unit.test.ts`, `group-network.unit.test.ts`, `groups.integration.test.ts`, `groups-failures.integration.test.ts` |
| Group query scope | Invalid or missing groups fall back to public data; concurrent lookups lose writes; cancellation exposes stale handles or drops accepted receipts | `query.unit.test.ts`, `groups-api.integration.test.ts`, `groups-failures.integration.test.ts`, `groups-restart.integration.test.ts`, `types.test.ts` |
| Group durability | Consumed MLS state loses received records; retries create fresh ciphertext; partial acknowledgements lose receipts; restart loses pending Welcomes; device or account state crosses scopes | `group-store.unit.test.ts`, `group-recovery.unit.test.ts`, `group-ingress.unit.test.ts`, `groups-restart.integration.test.ts`, `groups-failures.integration.test.ts` |
| Blossom | Wrong bytes/hashes, invalid descriptors, broad authorization, hidden partial delete failure, redirect credential forwarding, or uncancelled body reads | `private-storage.test.ts`, `storage.integration.test.ts` |
| Persistence | Namespace crossover, reference mutation, partially committed IndexedDB batches, overlapping cache writes, missing tombstones, or lost writes at close | `durability.unit.test.ts`, `offline-sync.test.ts`, `network.integration.test.ts` |
| Offline delivery | Failed disk writes expose optimistic success; capacity races overfill the queue; retry re-signs an event; simultaneous flushes duplicate delivery; account changes publish another queue | `durability.unit.test.ts`, `offline-sync.test.ts`, `tooling.test.ts` |
| Reconciliation | Missing IDs are silently lost, requests exceed the batch bound, cancelled responses enter the cache, partial data disappears, or cached third-party events are published | `sync-boundaries.unit.test.ts`, `offline-sync.test.ts`, `network.integration.test.ts` |
| Migrations | A late invalid transform causes early writes; account changes rewrite another author's data; skipped rows write; obsolete fields persist; partial progress is lost | `tooling-boundaries.unit.test.ts`, `tooling.test.ts` |
| Backups | A late invalid event partially imports; foreign e-only deletes gain authority; stale copies revive deleted rows; imported/exported objects corrupt the cache | `tooling-boundaries.unit.test.ts`, `tooling.test.ts`, `private-storage.test.ts` |
| References | Two authors with the same ID resolve to the wrong record, or missing batch records lose their positions | `tooling.test.ts` |
| Dashboard and diagnostics | Private plaintext appears in inspection/logs, HTML contains executable record data, or diagnostic buffers grow without a bound | `tooling.test.ts` |
| Transport lifetime | Values reset an absolute timeout, synchronous completion misses teardown, cancellation leaves subscriptions, or relay CLOSED is ignored | `auth-transport.unit.test.ts`, `relay.test.ts`, `network.integration.test.ts` |
| Shared resources | Closing one client closes another client's injected store or pool | `sdk.test.ts`, `network.integration.test.ts` |
| Distribution and types | Source-only tests pass while the archive lacks exports, usable declarations, working encrypted APIs, or browser module compatibility | `types.test.ts`, `package.integration.test.ts` |

## Test design

- Use fixed development keys. No production keys or public relays are required.
- Use actual Schnorr signatures and NIP-44 encryption for data trust tests. Do not mock verification as successful.
- The new relay and Blossom fixtures verify wire behavior independently of SDK encoding and replacement helpers.
- Use loopback servers on operating-system assigned ports. Poll only for external socket state. Do not use fixed sleeps.
- Use deferred promises to stop at an exact async boundary. Use fake timers to inspect absolute deadlines and timer cleanup.
- Register cleanup before assertions. The shared scope closes resources in reverse order and reports cleanup errors. Release fault gates before closing their dependent resources.
- Inspect data, receipts, persisted state, and wire side effects. A rejected promise alone does not establish that a rejected write stayed out of the cache.
- Model arrival-order tests use 32 fixed seeds with replacement ties, author-scoped deletes, recreation, and duplicate echoes. Failure messages include the seed. Expected winners come from the protocol rule, independent of SDK comparison helpers.
- Use mixed valid/invalid batches to prove validation happens before the first write or import. Use a failure after relay acknowledgement to prove safe exact-event replay.
- The package test builds, packs without running prepack recursively, unpacks into a temporary consumer, compiles its types, runs its ESM code, and bundles its exports for a browser. Only installed dependency directories are linked. The SDK itself is loaded from the archive.

## Deliberate-fault checks

`npm run test-mutations` runs the relevant unchanged tests first. It then changes one behavior at a time **in a temporary copy**:

1. Retain a caller-owned event in the verified cache.
2. Ignore cancellation on a cache read.
3. Publish the caller's mutable signed event.
4. Share table change payloads between observers.
5. Emit a deletion of an older version while a newer one exists.
6. Expose optimistic state before the queue commit succeeds.
7. Accept record content with an incorrect namespace.
8. Remove write author checks.

Each fault must cause its named behavioral test to fail. Collection errors, compiler errors, missing reports, and runner timeouts do not count as detection. The script deletes the temporary copy and leaves workspace source unchanged. This is a small contract check, not an exhaustive mutation score.

GitHub CI is configured to run `npm run check` and these fault checks on Node 22.12 and 24. Separate jobs run the environment projects and retain failure logs and browser traces. A local pass does not prove that hosted CI has run.

## Limits

The fast suite uses fake-indexeddb and simulated signer/service fixtures where exact fault control is needed. The separate projects check real browsers, independent services, NIP-46, and extension permissions. Their scoped guides state the exact software and fault boundary tested. Local passes do not establish compatibility with a public deployment, a different extension, Safari, S3 storage, or production retention policies.

The suite does not claim PostgreSQL transactions, permanent relay storage, deletion from every copy, global query completeness, or a performance service level. The load project uses a bounded reproducible workload and records metrics. It checks SDK lifecycle contracts; it does not set a production throughput target.

## Full application checks

[Fieldwork](../examples/fieldwork/README.md) installs a freshly packed SDK into a separate application and runs named user flows in Chromium, Firefox, and WebKit against independent `nak 0.20.7` relay and Blossom services. The app tests use real IndexedDB, signatures, NIP-44, NIP-77, CORS, file downloads, and a separate NIP-46 signer process.

Run `npm run example:test`. Run `npm run example:test:fallback` to repeat recovery with NIP-77 disabled. Missing relay capability cannot count as feature success. These checks are separate from the fast default suite and from the other environment projects.

See the example's feature map, test contracts, developer experience, and stated limits. In particular, offline reload restores HTTP access first; this suite does not claim offline installation, forced browser crashes, or third-party wallet UI approval.
