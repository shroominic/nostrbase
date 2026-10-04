# Independent Blossom integration

This project runs the unmodified [hzrd149/blossom-server](https://github.com/hzrd149/blossom-server) as a separate native process. It uses version **6.4.0**, Git commit **32567afb15255c171817a78ed2861cd9e57bf4de**, and **Deno 2.9.6**. It does not use the test HTTP fixture.

## Run

```sh
npm ci
node integration/blossom/setup.mjs
npx playwright install chromium
npm run test-blossom-service
```

Setup requires Git and network access to GitHub, JSR and npm. It fetches the exact source commit, verifies the checkout and caches dependencies with the upstream lock file frozen. The server uses `--cached-only` during tests. A missing checkout, wrong Deno version or missing browser causes a clear failure. There are no capability skips.

The default Deno binary is `node_modules/.bin/deno`. Set `BLOSSOM_DENO_BIN` to an explicit Deno **2.9.6** binary when necessary. These checks use a native server, so Docker is not required.

## Contracts checked

- SDK upload, list, authenticated download and delete against the real server, including SHA-256, size and byte identity.
- Persistence after a real server process restart with the same SQLite database and blob directory.
- Owner permissions, including denial of a foreign deletion and foreign list.
- Content deduplication across two owners. A successful delete removes that owner's claim; bytes remain until the last owner deletes them.
- Rejection of absent, forged, expired, wrong-action, wrong-server and wrong-hash authorization.
- Explicit upload rejection at the configured server size limit.
- CORS preflight for the SDK's upload and deletion headers.
- An actual Chromium SDK round trip across two HTTP origins. Browser fetch enforces CORS.

Each run uses loopback addresses, temporary files and databases, generated development identities, a readiness probe and process cleanup. The 64 KiB limit and private list policy are explicit test server settings. Temporary storage is removed on completion. Server logs remain in `output/environment/blossom/`; they contain request methods, paths and status codes, not uploaded bytes or authorization headers. The pinned source remains in the ignored `output/integration-cache/` directory.

These checks establish compatibility with this server version and configuration. They do not test S3, TLS proxies, production retention policies or arbitrary public Blossom servers.
