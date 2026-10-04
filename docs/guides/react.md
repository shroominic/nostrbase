# React and Next.js

Keep signer calls in the browser and release each client on unmount.

## Client component

Install the [local package](/docs/quickstart/#install-the-local-package). In Next.js, put this in a client component. In a browser React app, the same component works without the directive.

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { createClient, type NostrbaseClient, type Row } from "nostrbase";

type Database = { todos: { title: string; done: boolean } };

export default function Todos() {
  const client = useRef<NostrbaseClient<Database> | null>(null);
  const [rows, setRows] = useState<Row<Database["todos"]>[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    const db = createClient<Database>({
      namespace: "com.example.todos",
      relays: ["wss://your-relay.example"],
    });
    client.current = db;
    return () => {
      client.current = null;
      void db.closeAsync();
    };
  }, []);

  async function signIn() {
    const db = client.current;
    if (!db) return;
    const login = await db.auth.signInWithExtension();
    if (client.current !== db) return;
    if (login.error) return setError(login.error.message);
    if (!login.data) return;
    const result = await db.from("todos").author(login.data.user.pubkey);
    if (client.current !== db) return;
    if (result.error) return setError(result.error.message);
    setError("");
    setRows(result.data ?? []);
  }

  return (
    <section>
      <button onClick={signIn}>Sign in and load todos</button>
      {error && <p role="alert">{error}</p>}
      <ul>{rows.map(row => <li key={row.id}>{row.title}</li>)}</ul>
    </section>
  );
}
```

Creating the client inside the effect handles React development remounts. Do not reconnect a closed client. The identity guard avoids applying a response after unmount.

## Live state

After sign-in, create an author-scoped [change channel](/docs/live-changes/). Key rows by author + ID if you show multiple authors. Upsert `new` rows for `INSERT`/`UPDATE`; remove `old` rows for `DELETE`. A filtered update can leave a view even when its event type is `UPDATE`, so check the new row against your view filter.

Remove the previous channel on account change. Clean it up with the client on unmount.

## Server boundaries

NIP-07 and IndexedDB need a browser. Do not put extension sign-in in a server component. Public reads can use a separate Node client with explicit cleanup. A server signer signs as the server's key, not the browser user's key.
