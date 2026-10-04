import {
  createClient,
  type InferDatabase,
  IndexedDBPersistenceAdapter,
  type NostrbaseChannel,
  type Result,
  type Row,
  reference,
  scopeTag,
  zodTable,
} from "nostrbase";
import { z } from "zod";

const projectReference = z.object({
  table: z.literal("projects"),
  id: z.string(),
  author: z.string().regex(/^[0-9a-f]{64}$/),
});
export const schema = {
  projects: zodTable(
    z.object({ title: z.string().min(1).max(100), description: z.string().max(500) }),
  ),
  tasks: zodTable(
    z.object({
      title: z.string().min(1).max(160),
      status: z.enum(["planned", "active", "done"]),
      priority: z.enum(["normal", "high"]),
      project: projectReference,
      attachment: z.object({ sha256: z.string(), name: z.string(), server: z.string() }).nullable(),
      revision: z.number().int().min(1),
    }),
  ),
  notes: zodTable(
    z.object({ title: z.string().min(1).max(100), body: z.string().min(1).max(4000) }),
  ),
};
export type Database = InferDatabase<typeof schema>;
export type Task = Row<Database["tasks"]>;
export type Project = Row<Database["projects"]>;
export type Note = Row<Database["notes"]>;
export interface Configuration {
  relay: string;
  blossom: string;
  namespace: string;
}
export interface Operation {
  label: string;
  time: string;
  error: string | null;
  meta: unknown;
}

/** Application policy lives here. All protocol operations use the installed SDK. */
export class Workspace {
  readonly db;
  room?: NostrbaseChannel<Database>;
  operations: Operation[] = [];
  lastFailure?: Result<unknown>;
  private cleanups: (() => void)[] = [];
  private identityCleanups: (() => void)[] = [];
  constructor(
    readonly config: Configuration,
    private notify: () => void,
  ) {
    this.db = createClient<Database>({
      namespace: config.namespace,
      relays: [config.relay],
      schema,
      timeout: 5000,
      persistence: {
        adapter: new IndexedDBPersistenceAdapter(`fieldwork:${config.namespace}`),
        onError: (error) => this.record("Persistence", { data: null, error }),
      },
      sync: { tables: ["projects", "tasks"], reconnect: true, timeout: 3000 },
      diagnostics: { enabled: true },
    });
  }
  record<R extends Result<unknown>>(label: string, result: R): R {
    if (result.error) this.lastFailure = result;
    this.operations.unshift({
      label,
      time: new Date().toLocaleTimeString(),
      error: result.error ? `${result.error.code}: ${result.error.message}` : null,
      meta: result.meta ?? null,
    });
    this.operations = this.operations.slice(0, 40);
    this.notify();
    return result;
  }
  require<T>(label: string, result: Result<T>): T {
    this.record(label, result);
    // Keep partial data and receipts in the operation log; do not report partial writes as success.
    if (result.error) throw result.error;
    if (result.data === null) throw new Error(`${label} returned no data`);
    return result.data;
  }
  async connect(
    onChange: () => void,
    onPresence: (count: number) => void,
    onSignal: (text: string) => void,
  ) {
    await this.db.ready();
    this.room = this.db
      .channel("workspace", { broadcast: { self: true } })
      .on("nostr_changes", { table: "tasks", event: "*" }, onChange)
      .on("nostr_changes", { table: "projects", event: "*" }, onChange)
      .on("broadcast", { event: "message" }, ({ payload }) => {
        if (typeof payload === "string") onSignal(payload);
      })
      .on("presence", { event: "sync" }, () => {
        onPresence(
          Object.values(this.room?.presenceState() ?? {}).reduce(
            (sum, entries) => sum + entries.length,
            0,
          ),
        );
      })
      .subscribe((_status, error) => {
        if (error) this.record("Live channel", { data: null, error });
      });
    const filter = { kinds: [1], "#t": [scopeTag(this.config.namespace, "events")] };
    this.cleanups.push(
      this.db.events.subscribe(filter, (event) => onSignal(event.content)).unsubscribe,
    );
  }
  async signedIn(name: string, onNote: () => void) {
    for (const cleanup of this.identityCleanups.splice(0)) cleanup();
    const subscription = await this.db.private.subscribe("notes", onNote, (error) =>
      this.record("Private live changes", { data: null, error }),
    );
    this.identityCleanups.push(subscription.unsubscribe);
    this.record("Presence", (await this.room?.track({ name })) ?? { data: null, error: null });
  }
  async signOut() {
    if (this.room) this.record("Leave presence", await this.room.untrack());
    for (const cleanup of this.identityCleanups.splice(0)) cleanup();
    this.record("Sign out", await this.db.auth.signOut());
  }
  async tasks(project: Project, search: string, local: boolean, cursor?: string, size = 6) {
    let query = this.db
      .from("tasks")
      .contains("project", reference("projects", project.id, project._nostr.pubkey));
    if (search) query = query.textSearch("title", search);
    if (local) query = query.local();
    return this.record("Read tasks", await query.page(size, { cursor }));
  }
  async addTask(project: Project, title: string, priority: "normal" | "high", queue: boolean) {
    let query = this.db
      .from("tasks")
      .insert({
        title,
        status: "planned",
        priority,
        project: reference("projects", project.id, project._nostr.pubkey),
        attachment: null,
        revision: 1,
      })
      .select()
      .single();
    if (queue) query = query.queue();
    return this.require(queue ? "Queue task" : "Create task", await query);
  }
  async updateTask(task: Task, patch: Partial<Database["tasks"]>, queue: boolean) {
    let query = this.db
      .from("tasks")
      .update(patch)
      .author(task._nostr.pubkey)
      .eq("id", task.id)
      .select()
      .single();
    if (queue) query = query.queue();
    return this.require("Update task", await query);
  }
  async deleteTask(task: Task, queue: boolean) {
    let query = this.db.from("tasks").delete().author(task._nostr.pubkey).eq("id", task.id);
    if (queue) query = query.queue();
    const result = this.record("Delete task", await query);
    if (result.error) throw result.error;
  }
  async close() {
    for (const cleanup of this.identityCleanups.splice(0)) cleanup();
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    await this.db.closeAsync();
  }
}
