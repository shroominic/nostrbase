# Private records and file storage

## Personal private tables

```ts
const { data, error } = await db.private
  .from("todos")
  .insert({ id: "personal", title: "Private note", done: false })
  .select();

const notes = await db.private.from("todos").eq("done", false);
await db.private.from("todos").update({ done: true }).eq("id", "personal");
await db.private.from("todos").delete().eq("id", "personal");
```

The active Nostr signer must support NIP-44 encryption. The SDK encrypts the complete record body to the signer's own public key, then signs and publishes the ciphertext as a kind `30078` event. Applesauce signers provide the encryption and signing methods.

Only ciphertext enters the event store, backups, and offline queue. Data field values never enter index tags. The author, app, table, record ID, event timestamps, and approximate payload size remain public. A private table uses a separate address from a public table with the same name and ID.

Queries decrypt the current author's records and apply filters, search, projections, ordering, and pagination locally. An explicit `.author()` must match the active author. Private records require a signed-in user for reads as well as writes. Group sharing and key rotation are outside this personal table API.

```ts
// Read verified local ciphertext; decrypt only for this result.
await db.private.from("todos").local().select();

// Explicitly save a signed, encrypted write to the configured durable queue.
await db.private.from("todos").insert({ title: "Offline note", done: false }).queue();

// Receive decrypted record changes. Callbacks include the signed ciphertext event.
const subscription = await db.private.subscribe("todos", (change) => {
  console.log(change.eventType, change.new);
});
subscription.unsubscribe();
```

The offline queue uses memory by default. Configure an IndexedDB persistence adapter to retain queued ciphertext across restarts.

Subscriptions stop on sign-out, account change, or client close. Plaintext held by your own app remains your app's responsibility. NIP-09 deletion requests hide the record in SDK reads; relays can retain ciphertext or ignore deletion requests. Encryption does not revoke copies already decrypted by an authorized key.

## Blossom file storage

Blossom is an HTTP file server protocol. It is a separate service alongside the Nostr relays. Select a server origin explicitly:

```ts
const files = db.storage.from("https://files.example.com");

const uploaded = await files.upload("images/avatar.png", imageBlob);
if (uploaded.error) throw uploaded.error;
const { sha256, url } = uploaded.data!;

const downloaded = await files.download(sha256);
const page = await files.list(undefined, { limit: 20 });
const removed = await files.remove([sha256]);
```

The name is display metadata. File objects use their SHA-256 hash as the key. File names do not create folders or affect addressing. Publish the returned descriptor or reference in a Nostr record to associate it with your app.

The implementation follows BUD-01 retrieval, BUD-02 upload, BUD-11 authorization, and BUD-12 management:

- Upload: `PUT /upload` with raw bytes, MIME type, and `X-SHA-256`.
- Download: `GET /<sha256>`, followed by a local hash check.
- Remove: separate `DELETE /<sha256>` requests with per-object success or error results.
- List: `GET /list/<pubkey>` with optional `cursor` and `limit`. Some servers do not implement list.
- Authorization: signed kind `24242` events, short expiry, server hostname scope, and hash scope for upload, download authorization, and deletion.

Uploads, deletion, and listing request the active signer's approval. Public downloads work without a signer. Use `download(hash, { authenticated: true })` for a server that requires a scoped `get` token.

Upload descriptors must match the uploaded hash and byte count. Downloads must match the requested hash. Requests always use the chosen server; the SDK does not send uploads or authorization tokens to descriptor URLs. HTTP redirects are rejected. Use the final file server origin when a provider uses redirects. Servers can return public CDN URLs in validated descriptors, which your app may use separately.

Cancellation and request timeout:

```ts
const controller = new AbortController();
await files.upload("notes.txt", blob, { signal: controller.signal, timeout: 15_000 });
```

Configure a custom fetch implementation and the default storage request timeout on the client:

```ts
const db = createClient({
  namespace: "my-app",
  relays: ["wss://relay.example.com"],
  signer,
  storage: { fetch: customFetch, timeout: 15_000 },
});
```

File bytes are public unless your app encrypts them before upload. Server storage limits, retention, payments, and upload permissions follow the selected server's policy. Private table encryption does not encrypt file bytes automatically.

## Image transforms

Upload/download `transform` options process raster images locally. Downloaded bytes are hash-verified before processing; transformed uploads receive their own hash and signed authorization. See [image processing](images.md) for browser and Node setup and limits.
