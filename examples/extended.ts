import { z } from "zod";
import {
  createClient,
  type InferDatabase,
  MemoryPersistenceAdapter,
  PrivateKeySigner,
  reference,
  zodTable,
} from "nostrbase";

const schema = {
  todos: zodTable(z.object({ title: z.string(), done: z.boolean() })),
};
type Database = InferDatabase<typeof schema>;

// Pass a relay that accepts kind 30078, kind 5, and ephemeral kind 20078.
// The temporary identity and memory cache last only for this process.
export async function runExtendedExample(relay: string): Promise<void> {
  const signer = new PrivateKeySigner();
  const db = createClient<Database>({
    namespace: "com.example.nostrbase.extended",
    relays: [relay],
    signer,
    schema,
    persistence: { adapter: new MemoryPersistenceAdapter() },
    sync: { tables: ["todos"], reconnect: true },
  });
  try {
    await db.ready();
    const author = await signer.getPublicKey();
    const queued = await db
      .from("todos")
      .insert({ id: "task-1", title: "Build a Nostr app", done: false })
      .queue()
      .select()
      .single();
    if (queued.error) throw queued.error;
    const flushed = await db.offline.flush();
    if (flushed.error) throw flushed.error;

    console.log(await db.from("todos").author(author).textSearch("title", "nostr").page(20));
    console.log(await db.relations.resolve(reference("todos", "task-1", author)));

    const privateWrite = await db.private.from("todos").insert({
      id: "note-1",
      title: "Personal encrypted note",
      done: false,
    });
    if (privateWrite.error) throw privateWrite.error;
    console.log(await db.private.from("todos").local());

    const room = db
      .channel("editor", { broadcast: { self: true } })
      .on("broadcast", { event: "cursor" }, ({ payload }) => console.log(payload))
      .on("presence", { event: "sync" }, () => console.log(room.presenceState()))
      .subscribe();
    await room.track({ displayName: "Example user" });
    await room.send({ type: "broadcast", event: "cursor", payload: { x: 1, y: 2 } });
    await room.untrack();
    room.unsubscribe();

    console.log(await db.sync.table("todos"));
    console.log(
      await db.migrations.run(
        "todos",
        (data) => ({
          ...data,
          title: data.title.trim(),
        }),
        { dryRun: true },
      ),
    );
    // Private records remain ciphertext in the archive and hidden in the inspector.
    console.log(await db.backup.export());
    console.log(await db.dashboard.snapshot());
    console.log(db.diagnostics.list());
  } finally {
    await db.closeAsync();
  }
}
