# Real browser integration

This project loads the actual SDK into Playwright Chromium, Firefox and WebKit. IndexedDB,
WebCrypto and browser WebSockets are real browser APIs. The relay is the local NIP-01 wire
fixture. Independent relay implementations run in a separate integration project.

## Run

```sh
npx playwright install chromium firefox webkit
npm run test-browser
```

Linux CI must install browser system dependencies with `npx playwright install --with-deps`.
To run one engine, use `npx playwright test --project=firefox`. The Chromium project also runs
an actual quota failure with CDP quota controls. Firefox and WebKit cannot use that control.
No capability check turns a missing browser binary into a passing test.

## Contract map

| Test | Failure it detects |
| --- | --- |
| Shared group query and reload | Encrypted group data crosses scopes, a foreign author can write, or a persisted group intent cannot recover after reload |
| Password-encrypted identity recovery | Page reload loses identity, wrong passwords replace a session, or restored identity cannot sign |
| Automatic durable replay | Rejected entries disappear, startup misses saved work, or retry changes signed events |
| Canvas pixels and Blossom | Resize/rotation changes the wrong pixels; upload hash differs from stored bytes; download skips original integrity |
| Canvas orientation and cancellation | EXIF orientation, padding, invalid options, or canceled work violate processing boundaries |
| Canvas alpha and JPEG background | Padding flattens source alpha, or JPEG treats its background as transparent |
| Reload restores signed public/private queues | Lost writes, changed signatures, plaintext persistence or incorrect replay |
| Page reopen retains newest versions and tombstones | Old versions or deleted records return after startup |
| Account change across reload | Another signer decrypts or delivers the previous signer's private queue |
| Two tabs share a database | Independent transactions overwrite queue entries |
| Namespace and profile isolation | Data crosses an application namespace or an explicit profile database |
| External version change | SDK connection prevents another tab from upgrading; an unsupported version silently opens |
| Blocked upgrade | The upgrade runs through a retained unmanaged connection or cannot recover after it closes |
| Abort and close | Browser socket subscriptions leak or cancellation fails on wire or cache-only reads |
| Actual origin quota failure | A failed durable commit exposes optimistic data or a receipt; the queue stays broken after quota release |

Fourteen portable contracts run on all three engines. One quota contract runs on Chromium:
43 executions. Tests observe requests, transaction completion and browser events. They do
not use fixed sleeps. Each test gets a separate browser context, temporary HTTP origin,
loopback relay and fixed development signing keys. Failure artifacts go to
`output/playwright/browser`; the report is in `output/playwright/browser-report`.

## Shared harness

`startBrowserHarness()` in `support/server.ts` returns `{ url, relay, close() }`. It bundles
`support/entry.ts` with esbuild and serves one local page. The page exposes:

- `window.nostrbase`: SDK exports.
- `window.nostrTools`: signature tools.
- `window.protocol`: internal event encoding helpers for fixture setup.
- `window.harnessReady`: module initialization is complete.
- `window.createHarnessClient({ name, database, namespace, relay, seed? })`: create and await
  a real IndexedDB-backed SDK client. The default seed is 1, for development use only.
- `window.clients` and `window.adapters`: maps keyed by client name.

`GET /relay-url` returns `{ relay }`. Tests can supply any relay URL to the browser client.
Close clients with `closeAsync()` to verify durable shutdown; `close()` releases the servers.

## Limits

WebKit is the Playwright WebKit build; it is not an installed Safari application. These checks
also do not cover mobile OS lifecycle rules, every browser storage quota policy or
simultaneous multi-tab queue replay exactly-once delivery. Nostr may replay the same signed
event; the SDK does not promise a global multi-tab lock. The adapter opens schema version 1.
After another application upgrades that database to version 2, creating a new adapter fails
with `VersionError`; there is no automatic migration from unknown schemas.
