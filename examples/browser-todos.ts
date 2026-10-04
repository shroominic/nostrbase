import { createClient } from "../src";
import type { ChangePayload, Row } from "../src";

type Database = { todos: { title: string; done: boolean } };

/** Bind these functions to your UI. signIn() must run from a user action. */
export function createTodoApp(
  relays: string[],
  onChange: (change: ChangePayload<Database["todos"]>) => void,
) {
  const db = createClient<Database>({ namespace: "com.example.nostrbase.todos", relays });
  let pubkey: string | undefined;

  return {
    async signIn() {
      const result = await db.auth.signInWithExtension();
      if (result.error) throw result.error;
      if (!result.data) throw new Error("Sign-in did not return a session.");
      pubkey = result.data.user.pubkey;
      await db.removeAllChannels();
      db.channel("my-todos")
        .on("nostr_changes", { table: "todos", author: pubkey }, onChange)
        .subscribe();
      return result.data.user;
    },
    async list(): Promise<Row<Database["todos"]>[]> {
      if (!pubkey) throw new Error("Sign in first.");
      const result = await db.from("todos").author(pubkey).order("title").throwOnError();
      return result.data ?? [];
    },
    async add(title: string) {
      return db.from("todos").insert({ title, done: false }).select().single().throwOnError();
    },
    async complete(id: string) {
      return db.from("todos").update({ done: true }).eq("id", id).throwOnError();
    },
    async remove(id: string) {
      return db.from("todos").delete().eq("id", id).throwOnError();
    },
    async signOut() {
      pubkey = undefined;
      await db.removeAllChannels();
      await db.auth.signOut();
    },
    close() {
      db.close();
    },
  };
}
