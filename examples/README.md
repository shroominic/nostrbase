# Examples

## Fieldwork: a complete application

[Fieldwork](fieldwork/README.md) is a responsive project board with shared tasks, private notes, Blossom attachments, live updates, offline replay, and SDK tools. It installs the packed SDK and tests real browser flows against independent local `nak` services.

```sh
npm run example:setup
npm run example:dev
```

Open http://127.0.0.1:4173. Run `npm run example:test` for Chromium, Firefox, and WebKit. See the [developer experience report](fieldwork/DEVELOPER-EXPERIENCE.md) for implementation findings and limits.

## Browser

`browser-todos.ts` exports a small todo-app adapter. It includes extension sign-in, reads, writes, an author-scoped channel, sign-out, and cleanup. Import it into your TypeScript app and connect its functions to your UI.

Use a modern browser with WebSocket, crypto, and AbortSignal.any. Install a NIP-07 signer extension. Configure a relay that accepts public kind-30078 application data and kind-5 deletion events.

## Node

Build the SDK, then run the example with Node 22.12+ and a local Nostr relay:

```sh
npm run build
NOSTR_RELAY=ws://127.0.0.1:7777 node --experimental-strip-types examples/node-todos.ts
```

The example uses Node's built-in WebSocket. Set `NOSTR_PRIVATE_KEY` to a hex or nsec secret if you need the same author between runs. Otherwise, each run creates a temporary identity in memory. The example prints only the public key and record data.

`NOSTR_NAMESPACE` can select an app namespace. Use the same namespace in both examples to read the same collection, and the same signer identity to edit the same records.

## Extended features

`extended.ts` exports `runExtendedExample(relay)`. It demonstrates Zod inference, queued public writes and replay, cursor/text search, author-scoped references, personal encrypted data, Broadcast, Presence, synchronization, migration previews, backups, and the inspector. It uses a temporary development identity and memory persistence. It performs writes to the relay you supply.

For browser persistence, replace the memory adapter with `new IndexedDBPersistenceAdapter("my-app-cache")`. For files, use `db.storage.from("https://your-blossom-server.example")`; see [private records and storage](../docs/private-storage.md). Keep a stable production identity supplied by the user.

The original SDK tests use local WebSocket relays on random ports, a simulated IndexedDB implementation, and a simulated Blossom HTTP service. They need no external service. The [verification record](../docs/verification.md) identifies the limits of those checks.
