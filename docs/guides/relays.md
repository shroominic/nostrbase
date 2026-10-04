# Choose relays

Match relay capabilities and retention to your app.

## Required capabilities

| Feature | Relay requirement |
| --- | --- |
| Tables | Kind `30078`, address replacement, scope tags |
| Deletes | Kind `5`, deletion pointers or removal of targeted records |
| Live changes | Persistent subscriptions |
| Broadcast / Presence | Delivery of ephemeral kind `20078` and channel tags |
| Negentropy | NIP-77; ordinary query fallback is available |
| Raw search | NIP-50; matching rules vary |

The SDK does not select relays, discover an outbox, or guarantee public relay compatibility. Configure explicit endpoints. Test event acceptance, retention, result limits, and reconnect behavior on the relays you intend to use.

## Authenticate to a relay

Some relays require NIP-42 authentication. Authenticate through Applesauce before requesting data:

```ts
await db.pool.relay(url).authenticate(signer);
```

App signer sign-in and relay authentication are separate. Relay authentication is not automatic.

## Plan for incomplete results

Multiple relays can improve availability, but each can retain a different set of events. Nostr replacement resolves known versions; it does not establish a global snapshot.

Use author filters, smaller collections, and [recovery](/docs/synchronization/). A successful query or Negentropy exchange describes configured relay data. It cannot recover records already pruned everywhere.

## Deploy the app

A browser app can use static hosting. Use HTTPS and `wss:` endpoints; extension sign-in runs in a browser user action. Keep the app namespace stable between builds. Keep private keys out of a public bundle.

Files need a separate [Blossom server](/docs/storage/) with browser CORS support. Hosting the UI does not supply relay storage, file retention, or trusted background jobs.
