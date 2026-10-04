# Hosted integration projects

[The integration workflow](../../.github/workflows/integration.yml) defines ten isolated jobs. Six run the infrastructure projects, three run individual browser engines, and one runs the real extension. It runs on pushes, pull requests, manual dispatch, and a weekly schedule. Public/live service tests are excluded.

## Job boundaries

| Job | Required preparation | Test command |
| --- | --- | --- |
| `relay-service` | Pinned nostr-rs-relay and strfry Docker images | `npm run test-relay-service` |
| `blossom-service` | Pinned Blossom source and Deno dependencies; Chromium | `npm run test-blossom-service` |
| `remote-signer` | Pinned independent relay images | `npm run test-remote-signer` |
| `network-faults` | Pinned independent relay images and Blossom source | `npm run test-network-faults` |
| `crash-recovery` | Chromium | `npm run test-crash-recovery` |
| `load` | Pinned strfry image, downloaded by relay preparation | `npm run test-load` |
| `browser chromium` | Chromium and Linux browser libraries | `npm run test-browser -- --project=chromium` |
| `browser firefox` | Firefox and Linux browser libraries | `npm run test-browser -- --project=firefox` |
| `browser webkit` | WebKit and Linux browser libraries | `npm run test-browser -- --project=webkit` |
| `extension` | Pinned nos2x source and isolated locked build dependencies; full Chromium | `npm run test-extension` |

Each job uses **Ubuntu 24.04**, **Node 22.12.0** and **npm 11.16.0**. This checks the SDK's minimum supported Node version. The existing `check.yml` workflow separately runs the fast checks on Node 22.12.0 and Node 24.

The workflow pins Checkout, Setup Node and Upload Artifact actions to full Git commit hashes. `npm ci` restores the dependency lock. Browser binaries follow the pinned Playwright version. Relay images use immutable OCI digests. Blossom and nos2x setup use exact source revisions and locked dependency inputs.

## Execution rules

Each matrix job receives a separate hosted runner. Test helpers start their own loopback services with temporary databases or browser profiles and development identities. Service preparation checks Docker when required. Missing services, source checkouts, binaries or capabilities fail the relevant project; they do not silently skip it.

CI rejects focused tests. Vitest receives `--allowOnly=false --retry=0`. Playwright receives `--forbid-only --retries=0`. Matrix failure does not cancel the other projects. A newer run on the same branch can cancel an older run. Each job has a 20-minute outer timeout; test and service helpers have shorter timeouts.

The workload helper starts its own child Node process with `--expose-gc`; CI needs no extra Node flags. Its default sustained window is 20 seconds. The workload checks SDK resource limits and delivery invariants. It is not a production capacity benchmark.

The workflow needs no production keys, external service credentials or GitHub write permissions. It downloads pinned software and operates only the local test services. It does not run `test-live-services` or write to public relays and file servers.

## Failure evidence

Artifact upload uses `always()`, so existing evidence is collected after preparation or test failures. Service jobs retain `output/environment/**`, `output/integration/**` and `output/playwright/**`. Browser and extension jobs retain their reports and traces. Workload metrics are saved under `output/environment/load/`. Artifacts use unique project names and a seven-day retention period.

Downloaded source caches, databases and browser profiles are excluded from the artifact paths. When a failure occurs before any artifact is produced, upload reports a warning; the failed preparation step remains visible in the job log. Test artifacts can contain synthetic records, signed events and the fixed development extension key. They contain no production credentials.

## Verify before publication

```sh
actionlint .github/workflows/integration.yml
npm ci
npm run prepare:integrations
npm run test-extended
```

On Linux, install system libraries with `npx playwright install --with-deps chromium firefox webkit`. CI installs only the engine that each job needs.

Workflow syntax and local project execution are separate evidence. **No hosted GitHub Actions run is confirmed.** This workspace has no Git remote. After the repository is pushed to GitHub, inspect the first workflow run and its artifacts before claiming hosted CI verification.
