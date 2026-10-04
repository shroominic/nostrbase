# Quickstart

Create a typed client, connect a signer, and publish your first record.

## Install the local package

nostrbase 0.2.0 is not published to npm. Build the archive from the SDK directory with Node 22.12+:

```sh
npm ci
npm run check
npm pack
```

In your app, install the archive. Replace the path with its location:

```sh
npm install /path/to/nostrbase/nostrbase-0.2.0.tgz
```

The package is ESM. Use a modern browser or Node 22.12+.

## Create a typed client

```ts
import { createClient } from "nostrbase";

type Database = {
  todos: { title: string; done: boolean };
};

const db = createClient<Database>({
  namespace: "com.example.todos",
  relays: ["wss://your-relay.example"],
});
```

Replace the relay URL with a relay that accepts kinds `30078` and `5`. Keep the namespace the same on every device that uses this app.

## Connect a signer

Call sign-in from a button in a browser with a NIP-07 extension:

```ts
const login = await db.auth.signInWithExtension();
if (login.error) throw login.error;
if (!login.data) throw new Error("No session returned.");
const pubkey = login.data.user.pubkey;
```

The public key is the user's identity. Public reads need no signer. [Other signer options](/docs/authentication/).

## Write and read

```ts
const created = await db.from("todos")
  .insert({ title: "Build a Nostr app", done: false })
  .select()
  .single();
if (created.error) throw created.error;

const pending = await db.from("todos")
  .select("id, title, done")
  .author(pubkey)
  .eq("done", false);
if (pending.error) throw pending.error;
console.log(pending.data);
```

Writes return no rows unless you add `.select()`, `.single()`, or `.maybeSingle()`. Receipts are in `meta.receipts`. A successful acknowledgement proves relay acceptance.

## Listen for changes

```ts
const channel = db.channel("my-todos")
  .on("nostr_changes", { table: "todos", author: pubkey }, change => {
    console.log(change.eventType, change.new, change.old);
  })
  .subscribe();
```

Initial records arrive as `INSERT`. Live updates can be duplicated by the network; the SDK suppresses duplicate and stale versions.

## Release resources

```ts
await db.removeChannel(channel);
await db.closeAsync();
```

Use `closeAsync()` when pending cache writes must finish. [Read the architecture](/docs/architecture/) before designing shared data.
