# Node.js quickstart

Use an Applesauce signer and close the client when work ends.

## Requirements

Use Node 22.12+ and ESM. Install the [local package](/docs/quickstart/#install-the-local-package). Save this as `app.mjs`:

```js
import { createClient, PrivateKeySigner } from "nostrbase";

const signer = process.env.NOSTR_PRIVATE_KEY
  ? PrivateKeySigner.fromKey(process.env.NOSTR_PRIVATE_KEY)
  : new PrivateKeySigner();

const db = createClient({
  namespace: "com.example.todos",
  relays: [process.env.NOSTR_RELAY ?? "ws://127.0.0.1:7777"],
  signer,
});

try {
  const pubkey = await signer.getPublicKey();
  const created = await db.from("todos")
    .insert({ title: "Hello from Node", done: false })
    .select().single();
  if (created.error) throw created.error;
  console.log(created.data);

  const rows = await db.from("todos").author(pubkey);
  if (rows.error) throw rows.error;
  console.log(rows.data);
} finally {
  await db.closeAsync();
}
```

## Run

```sh
NOSTR_RELAY=ws://127.0.0.1:7777 node app.mjs
```

Start a suitable local relay or replace the URL. Without `NOSTR_PRIVATE_KEY`, each run creates a temporary identity. Use an existing key or remote signer for a stable identity.

The default memory cache and queue do not survive process exit. Use the [PersistenceAdapter interface](/docs/reference/persistence/#persistenceadapter) for a custom Node storage adapter.
