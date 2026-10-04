import { createClient, IndexedDBPersistenceAdapter } from "nostrbase";

interface Database {
  tasks: { title: string; done: boolean };
}

/** Browser example. Supply the relay your app uses and call close during app cleanup. */
export async function automaticReplayExample(relay: string) {
  const db = createClient<Database>({
    namespace: "automatic-replay-example",
    relays: [relay],
    offline: {
      adapter: new IndexedDBPersistenceAdapter("automatic-replay-example-queue"),
      autoReplay: {
        retryDelay: 1000,
        maxRetryDelay: 30000,
        onResult: (result) => console.log("Replay receipts", result.meta?.receipts),
        onError: (error, result) => console.error(error.code, result.meta?.receipts),
      },
    },
  });
  try {
    const session = await db.auth.signInWithExtension();
    if (session.error) throw session.error;
    await db.ready();
    const queued = await db
      .from("tasks")
      .upsert({ id: "website", title: "Build the website", done: false })
      .queue();
    if (queued.error) throw queued.error;
    return {
      db,
      queued: queued.data,
      status: () => db.offline.autoReplayStatus,
      stop: () => db.offline.stopAutoReplay(),
      start: () => db.offline.startAutoReplay(),
      close: () => db.closeAsync(),
    };
  } catch (error) {
    await db.closeAsync();
    throw error;
  }
}
