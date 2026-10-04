# Environment integration projects

These projects test the SDK with external software, browser storage, and process or network failures. Each project owns one environment boundary. The fast suite remains available with `npm test`.

## Setup

Use Node 22.12+, the locked npm dependencies, Git, and a running Docker engine.

```sh
npm ci
npm run prepare:integrations
npm run test-extended
```

Preparation downloads pinned relay images, the pinned Blossom source and its locked Deno dependencies, browser binaries, and the pinned NIP-07 extension. Tests use loopback ports, temporary storage, and development keys. Missing prerequisites cause an explicit failure.

On Linux, install browser system libraries with `npx playwright install --with-deps chromium firefox webkit`. This command can require administrator access. CI performs that step in its runner.

## Project commands

| Command | Boundary and purpose |
| --- | --- |
| `npm run test-relay-service` | [Independent nostr-rs-relay and strfry](relay/README.md): storage, deletion, signatures, policy receipts, authentication, and real Negentropy |
| `npm run test-browser` | [Chromium, Firefox, and WebKit](../tests/browser/README.md): real IndexedDB, page lifecycle, account isolation, cancellation, and Chromium quota failure |
| `npm run test-remote-signer` | [NIP-46 provider process](signer/README.md): encrypted requests, approval, denial, signer lifecycle, and private records |
| `npm run test-extension` | [Independent NIP-07 extension](extension/README.md): installation, user permissions, and verified SDK signatures |
| `npm run test-blossom-service` | [Independent Blossom server](blossom/README.md): signed storage operations, ownership, persistence, limits, and browser CORS |
| `npm run test-network-faults` | [Controlled local proxy](network/README.md): interrupted relay and storage operations, exact-event replay, and recovery |
| `npm run test-crash-recovery` | [Abrupt browser termination](crash/README.md): committed queue recovery, replay after acknowledgement, and transaction boundaries |
| `npm run test-load` | [Bounded workload](load/README.md): repeated subscriptions, presence, batched records, queue drain, and resource cleanup |
| `npm run test-live-services` | [Explicit deployment compatibility](live/README.md): configuration, read-only probes, and optional write round trips |

`test-environments` runs the six local Vitest infrastructure projects. `test-extended` adds browser and extension projects. Live deployments require explicit configuration and are excluded from both aggregates.

The eight local projects run 71 checks. The ninth project, `live-services`, runs six deployment checks. See the [verification report](../docs/verification.md) for local results and the public service findings.

## Evidence and limits

Logs, reports, browser traces, and workload metrics are saved under ignored `output/`. Failure artifacts can contain development test records. They do not contain production credentials.

The relay and Blossom service projects use unmodified independent implementations. The browser harness uses an observable local protocol fixture to control browser lifecycle failures. The signer project runs the actual Applesauce provider in a child process. Each scoped guide records its software version, checks, prerequisites, and limits.

The [integration CI workflow](ci/README.md) defines ten isolated jobs and keeps failure artifacts. The fast workflow continues to run `npm run check` and deliberate-fault checks.

These tests do not establish permanent relay retention, complete data across all relays, removal of all copies, production throughput, or compatibility with every deployment. Playwright WebKit is not the installed Apple Safari browser. Hosted CI execution remains unverified. Public compatibility depends on each deployment's policies and capabilities.
