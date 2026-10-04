# Real NIP-07 extension integration

This project builds and loads the actual [nos2x](https://github.com/fiatjaf/nos2x) Chromium extension. It runs unmodified upstream version **2.5.2**, Git commit **014493f9602d0a3826ef3eab2bdd4901ee315cce**. Its real Manifest V3 service worker, content script, provider, options page and permission windows perform each operation. The tests never replace or inject `window.nostr`.

## Run

```sh
npm ci
node integration/extension/setup.mjs
npx playwright install chromium
npx playwright test --config playwright.extension.config.ts
```

Setup requires Git and network access to GitHub and npm. It fetches the exact upstream commit and verifies that tracked source files are unchanged. Upstream provides no dependency lock. This directory supplies exact build dependencies and a committed npm lock. Setup runs `npm ci --ignore-scripts` in this directory, then runs the unchanged upstream `build.js prod`. The esbuild version is pinned to the SDK's version, **0.28.2**. Runtime/UI packages use versions within upstream's declared ranges. Build dependencies remain separate from the SDK's dependencies.

Setup records the source revision, the dependency lock hash and SHA-256 hashes of every extension file. Tests verify this provenance before loading it. A missing setup, changed source/build or missing Chromium causes an explicit failure.

## Contracts checked

- Sign-in rejection returns `AUTH_FAILED` and leaves the SDK signed out.
- Approved sign-in uses the extension's development identity. Approved record signing produces a valid signature owned by that identity and publishes it over the SDK's Applesauce transport.
- Signing rejection publishes no event and creates no cached row. A write with `.select()` returns an empty partial result, as specified by the SDK.
- Dismissing a permission window rejects the operation. A later approved retry succeeds.
- Private record creation and reading use real NIP-44 encryption/decryption permission windows. Published signed content contains ciphertext, and the SDK recovers the original record.

The harness uses a local WebSocket relay fixture. The independent relay project checks server compatibility separately. Each test creates a new temporary persistent Chromium profile, enters a fixed **development-only key through the extension options UI**, and answers only the expected permission prompts. It removes the profile after the browser closes. The fixture uses Playwright's full Chromium channel because the headless shell does not load extensions. It works headless and does not need a desktop display.

HTML reports are in `output/playwright/extension-report/`. A failed test retains a trace. Those artifacts can contain the fixed development key, synthetic records and signed events from this test. They contain no user accounts or production data.

These checks cover this pinned extension and Chromium version. They do not establish compatibility with all NIP-07 extensions, Firefox extensions, hardware signers or extension-store installation/update flows.
