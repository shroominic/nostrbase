# Realtime Broadcast and Presence

Table change handlers still use `.on("nostr_changes", ...)` or `.on("postgres_changes", ...)`.
Broadcast and Presence use signed, public Nostr events of kind `20078`. Each event has an app namespace, channel name, per-channel session ID, sequence number, and NIP-40 expiration tag. No server runs your app's channel logic.

## Broadcast

```ts
const room = db.channel("editor", { broadcast: { self: true } });

room
  .on("broadcast", { event: "cursor" }, ({ payload, pubkey, sessionId }) => {
    console.log(payload, pubkey, sessionId);
  })
  .subscribe();

const { data, error, meta } = await room.send({
  type: "broadcast",
  event: "cursor",
  payload: { x: 120, y: 80 },
});
```

- Use `{ event: "*" }` to receive all broadcast event names.
- Self delivery is off by default. Other sessions with the same signing key still receive messages.
- A channel can subscribe and send without receive handlers.
- A listener needs no signer. Sending requires an active signer.
- `data` contains a write receipt. `meta.relays` records relay acknowledgements. The client's `minWriteAcks` applies.
- Payloads must contain JSON values. Duplicate events are ignored during their lifetime.

## Presence

```ts
const room = db.channel("editor", {
  presence: { ttl: 30, heartbeatInterval: 10 },
});

room
  .on("presence", { event: "sync" }, () => {
    console.log(room.presenceState());
  })
  .on("presence", { event: "join" }, ({ key, newPresences }) => {
    console.log("joined", key, newPresences);
  })
  .on("presence", { event: "leave" }, ({ key, leftPresences }) => {
    console.log("left", key, leftPresences);
  })
  .subscribe();

await room.track({ displayName: "Alice", page: "document-1" });
await room.untrack();
room.unsubscribe();
```

Times are seconds. Default TTL is 30 seconds. Default heartbeat interval is 10 seconds, or one third of a shorter TTL. TTL must be an integer from 2 to 3600. The heartbeat interval must be positive and at most half the TTL.

`presenceState()` returns public keys mapped to session lists. Each entry contains `pubkey`, `sessionId`, `state`, and `expiresAt`. Each channel instance has its own session ID, so two tabs with one key remain separate sessions. The result is a copy.

`track()` publishes the initial state, then sends heartbeats. Calling it again updates state. `untrack()` stops heartbeats and publishes a leave message. An older heartbeat cannot override a newer leave message. A `sync` notification follows accepted state updates, joins, and leaves. Late subscribers learn existing sessions from later heartbeats.

Changing the signing key or signing out stops local tracking. `unsubscribe()` and `db.close()` stop timers and subscriptions. Other clients remove the session after its TTL. Use `await untrack()` before unsubscribing for an immediate leave attempt.

## Limits

- Broadcast payloads and Presence state are public. Signing proves the author; it does not limit access.
- Relays need not retain ephemeral events. The SDK does not put them in its event cache or offline write queue.
- Relay acknowledgement proves acceptance, not delivery to every subscriber.
- Presence is approximate. Disconnects, clock differences, dropped messages, or relay policies can delay joins and leaves.
- Relays must accept and deliver kind `20078` and the channel tags. This is a nostrbase wire format, not a general Presence standard.
- Negentropy recovers stored record events. It cannot recover ephemeral Broadcast or Presence history.
