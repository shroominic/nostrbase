# Independent relay integration

This project runs upstream **nostr-rs-relay 0.10.0** and **strfry 1.1.3** in isolated Docker containers. It does not use the SDK's relay fixture. Immutable OCI digests are in `tests/environment/support/relay-service.ts` and `prepare.mjs`.

## Run

Start Docker. Install the project dependencies, then run:

```sh
node integration/relay/prepare.mjs
npx vitest run --config vitest.environment.config.ts --project relay-service
```

Set `NOSTRBASE_DOCKER` to the Docker executable if it is not on `PATH`. The tests require prepared images and fail if Docker or either image is missing. They never skip a missing prerequisite. nostr-rs-relay's upstream image uses amd64; Docker must support this platform on ARM machines. The strfry image supports both ARM and amd64.

## Contracts

| Check | Purpose |
| --- | --- |
| Replacement and old-event replay | Prevent stale versions from replacing current relay data |
| SIGKILL restart and deletion | Check actual SQLite/LMDB persistence across an abrupt server exit |
| Record notifications | Check cross-client signed change delivery through Applesauce |
| Future timestamp rejection | Check real policy errors and publish receipts |
| Invalid wire signature | Confirm upstream relay validation independently of SDK validation |
| Other-author deletion | Confirm a foreign signed deletion cannot delete the owner's record |
| NIP-77 | Require Negentropy on strfry; require explicit query recovery with a reason on nostr-rs-relay |
| NIP-50 absence | Check advertised capability absence and the explicit client text-filter alternative |
| Author allowlist | Preserve accepted record data and both relay receipts when a second relay rejects a write and the acknowledgement quorum fails |
| NIP-42 and NIP-70 | Check protected-event rejection, an actual authentication challenge, explicit Applesauce authentication, successful publication of the same signed event, and isolation between connections |

Each service has a random container name, an ephemeral loopback port, and a separate temporary database. Readiness requires WebSocket EOSE, not just an open HTTP port. Restart uses SIGKILL and the same disk and port. Cleanup captures server logs under `output/environment/relay/`, removes containers, and removes temporary databases even when assertions fail.

These pinned relays do not implement NIP-50. This project does not count a search filter ignored by a relay as a successful NIP-50 test. The SDK's raw `events.search()` method requires a capable relay and does not automatically apply this fallback. TLS, public server retention, and third-party hosted policy remain outside this local project.

The authentication check uses strfry's NIP-70 protected events (`["-"]` tag). Its real NIP-42 handshake uses `client.pool.relay(url).authenticate(signer)`. The SDK does not automatically sign relay authentication challenges. Generic table CRUD is not gated by authentication in these pinned configurations; passing this check does not imply a configurable SDK access policy.
