# Remote signer integration project

```sh
node integration/relay/prepare.mjs
npm run test-remote-signer
```

Docker must be running. A missing Docker image or service fails the project.
No public relay is used. No account key is sent to the SDK process.

The tests run the installed **applesauce-signers 6.2.3**
`NostrConnectProvider` in a separate Node process. The lockfile fixes its package
and dependencies. `provider.mjs` supplies permission decisions through IPC and
starts the upstream provider. It does not implement NIP-46 or replace provider
methods. All requests and replies pass through Applesauce RelayPool and an
independent, digest-pinned nostr-rs-relay over local WebSockets.

Each test has a distinct purpose:

- Check rejected connection, signing, and NIP-44 encryption permissions. Rejected
  writes must produce no committed data or receipts.
- Verify public signatures and private create, read, update, and delete operations.
  A fresh SDK instance reads encrypted bytes from the relay and requests NIP-44
  decryption from the remote process. A live subscription verifies signed,
  encrypted NIP-46 replies. Kind 24133 is ephemeral and is not a relay archive.
  A direct denied decryption request must reject. The current SDK private-read
  contract omits unreadable ciphertext and returns empty rows when permission is
  denied; the test records that behavior.
- Hold an actual permission request, sign out of the SDK, then approve it. The
  late valid signature must not be published under the ended session.
- Stop provider and signer subscriptions, start them again, reconnect, and write
  under the original account. Cleanup confirms the provider stopped, its relay
  pool is empty, and its child process exited successfully.

Provider output is bounded to 1 MB per test and saved under
`output/environment/signer/`. Child startup, control, and shutdown have explicit
15-second deadlines. Test signing keys are temporary and generated inside the
provider process.

These tests verify SDK interoperability with the Applesauce provider. They do
not prove compatibility with every third-party bunker, mobile approval UI,
remote authentication page, or production permission policy.
