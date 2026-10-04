import { createClient, PrivateKeySigner } from "nostrbase";

type Database = { todos: { title: string; done: boolean } };

const signer = process.env.NOSTR_PRIVATE_KEY
  ? PrivateKeySigner.fromKey(process.env.NOSTR_PRIVATE_KEY)
  : new PrivateKeySigner();
const db = createClient<Database>({
  namespace: process.env.NOSTR_NAMESPACE ?? "com.example.nostrbase.todos",
  relays: [process.env.NOSTR_RELAY ?? "ws://127.0.0.1:7777"],
  signer,
});
try {
  const pubkey = await signer.getPublicKey();
  console.log("Author:", pubkey);
  const created = await db
    .from("todos")
    .insert({ title: "Hello from Node", done: false })
    .select()
    .single();
  if (created.error) throw created.error;
  console.log("Created:", created.data?.id);
  const result = await db.from("todos").author(pubkey).select("id, title, done");
  if (result.error) throw result.error;
  console.log(result.data);
} finally {
  await db.closeAsync();
}
