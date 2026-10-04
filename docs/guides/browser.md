# Browser quickstart

Bind a typed client to your UI with a NIP-07 signer.

## Setup

Install the [local package](/docs/quickstart/#install-the-local-package). Use a bundler that supports ESM and a browser with a NIP-07 extension.

```ts
import { createClient } from "nostrbase";

type Database = { todos: { title: string; done: boolean } };
const db = createClient<Database>({
  namespace: "com.example.todos",
  relays: ["wss://your-relay.example"],
});
```

## Sign in from a user action

```ts
const button = document.querySelector<HTMLButtonElement>("#sign-in");
if (!button) throw new Error("Sign-in button is missing.");

button.addEventListener("click", async () => {
  const result = await db.auth.signInWithExtension();
  if (result.error) {
    console.error(result.error);
    return;
  }
  if (!result.data) return;
  const pubkey = result.data.user.pubkey;
  const rows = await db.from("todos").author(pubkey);
  console.log(rows.data);
});
```

Render user values with `textContent` or your framework's escaped bindings. Rebuild author-scoped queries and channels when the account changes.

## Keep data after restart

Configure [IndexedDB persistence](/docs/persistence/) and wait for `db.ready()` before a cache-only read. The SDK does not save the signer session.

On app teardown, remove listeners and call `await db.closeAsync()`. Browser shutdown can interrupt asynchronous writes; flush at deliberate checkpoints.
