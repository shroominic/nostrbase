import { asError, NostrbaseError } from "./errors";
import { verify } from "./protocol";
import type { NostrEvent, RelayResult } from "./types";

/** Only signed wire events are persisted. Decrypted records are never written here. */
export interface QueuedEvent {
  event: NostrEvent;
  queuedAt: number;
  attempts: number;
  relays: RelayResult[];
}
export interface PersistenceAdapter {
  loadEvents(namespace?: string): Promise<NostrEvent[]>;
  putEvents(events: readonly NostrEvent[], namespace?: string): Promise<void>;
  loadQueue(namespace?: string): Promise<QueuedEvent[]>;
  putQueue(entry: QueuedEvent, namespace?: string): Promise<void>;
  removeQueue(eventId: string, namespace?: string): Promise<void>;
  close(): void | Promise<void>;
}
export interface PersistenceOptions {
  adapter: PersistenceAdapter;
  flushInterval?: number;
  batchSize?: number;
  onError?: (error: NostrbaseError) => void;
}

/** Useful for tests, temporary caches, and explicit in-memory offline queues. */
export class MemoryPersistenceAdapter implements PersistenceAdapter {
  private events = new Map<string, { namespace: string; event: NostrEvent }>();
  private queue = new Map<string, { namespace: string; entry: QueuedEvent }>();
  async loadEvents(namespace = ""): Promise<NostrEvent[]> {
    return structuredClone(
      [...this.events.values()]
        .filter((item) => item.namespace === namespace)
        .map((item) => item.event),
    );
  }
  async putEvents(events: readonly NostrEvent[], namespace = ""): Promise<void> {
    for (const event of events)
      this.events.set(`${namespace}:${event.id}`, { namespace, event: structuredClone(event) });
  }
  async loadQueue(namespace = ""): Promise<QueuedEvent[]> {
    return structuredClone(
      [...this.queue.values()]
        .filter((item) => item.namespace === namespace)
        .map((item) => item.entry),
    );
  }
  async putQueue(entry: QueuedEvent, namespace = ""): Promise<void> {
    this.queue.set(`${namespace}:${entry.event.id}`, { namespace, entry: structuredClone(entry) });
  }
  async removeQueue(eventId: string, namespace = ""): Promise<void> {
    this.queue.delete(`${namespace}:${eventId}`);
  }
  close(): void {}
}

/** Use a distinct name per namespace/profile. The supplied factory also permits worker/test use. */
export class IndexedDBPersistenceAdapter implements PersistenceAdapter {
  private database: Promise<IDBDatabase>;
  private closed = false;
  constructor(name = "nostrbase", factory: IDBFactory | undefined = globalThis.indexedDB) {
    if (!factory) throw new NostrbaseError("INVALID_CONFIG", "IndexedDB is unavailable.");
    this.database = new Promise((resolve, reject) => {
      const request = factory.open(name, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const name of ["events", "queue"]) {
          if (!db.objectStoreNames.contains(name)) {
            const store = db.createObjectStore(name, { keyPath: ["namespace", "id"] });
            store.createIndex("namespace", "namespace");
          }
        }
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed."));
      request.onblocked = () => reject(new Error("IndexedDB upgrade is blocked by another tab."));
    });
    // Keep opening failures handled until the client starts hydration.
    void this.database.catch(() => {});
  }
  private async transaction<T>(
    store: "events" | "queue",
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T> | undefined,
  ): Promise<T | undefined> {
    if (this.closed) throw new NostrbaseError("CLIENT_CLOSED", "Persistence adapter is closed.");
    const db = await this.database;
    if (this.closed) throw new NostrbaseError("CLIENT_CLOSED", "Persistence adapter is closed.");
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      let request: IDBRequest<T> | undefined;
      try {
        request = run(tx.objectStore(store));
      } catch (error) {
        tx.abort();
        reject(error);
      }
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed."));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted."));
    });
  }
  async loadEvents(namespace = ""): Promise<NostrEvent[]> {
    const items =
      (await this.transaction<{ event: NostrEvent }[]>("events", "readonly", (store) =>
        store.index("namespace").getAll(namespace),
      )) ?? [];
    return items.map((item) => item.event);
  }
  async putEvents(events: readonly NostrEvent[], namespace = ""): Promise<void> {
    await this.transaction("events", "readwrite", (store) => {
      for (const event of events)
        store.put({ namespace, id: event.id, event: structuredClone(event) });
      return undefined;
    });
  }
  async loadQueue(namespace = ""): Promise<QueuedEvent[]> {
    const items =
      (await this.transaction<{ entry: QueuedEvent }[]>("queue", "readonly", (store) =>
        store.index("namespace").getAll(namespace),
      )) ?? [];
    return items.map((item) => item.entry);
  }
  async putQueue(entry: QueuedEvent, namespace = ""): Promise<void> {
    await this.transaction("queue", "readwrite", (store) =>
      store.put({ namespace, id: entry.event.id, entry: structuredClone(entry) }),
    );
  }
  async removeQueue(eventId: string, namespace = ""): Promise<void> {
    await this.transaction("queue", "readwrite", (store) => store.delete([namespace, eventId]));
  }
  async close(): Promise<void> {
    this.closed = true;
    (await this.database).close();
  }
}

interface PersistenceHost {
  namespace: string;
  ingest(event: NostrEvent): boolean;
}
/** Persist all verified ingested events, including deletion tombstones and ciphertext. */
export class NostrbasePersistence {
  readonly adapter: PersistenceAdapter;
  private pending = new Map<string, NostrEvent>();
  private timer?: ReturnType<typeof setTimeout>;
  private write: Promise<void> = Promise.resolve();
  private hydration: Promise<void>;
  private closed = false;
  private closing?: Promise<void>;
  private replaying = false;
  private options: Required<Pick<PersistenceOptions, "batchSize" | "flushInterval">> &
    PersistenceOptions;
  constructor(
    private host: PersistenceHost,
    options: PersistenceOptions,
  ) {
    this.adapter = options.adapter;
    this.options = { flushInterval: 25, batchSize: 100, ...options };
    if (
      !Number.isSafeInteger(this.options.batchSize) ||
      this.options.batchSize < 1 ||
      !Number.isSafeInteger(this.options.flushInterval) ||
      this.options.flushInterval < 0
    )
      throw new NostrbaseError("INVALID_CONFIG", "Check persistence batchSize and flushInterval.");
    this.hydration = this.hydrate();
    void this.hydration.catch((error) => this.report(error));
  }
  private report(error: unknown): void {
    try {
      this.options.onError?.(asError(error));
    } catch {
      /* Observer isolation. */
    }
  }
  private async hydrate(): Promise<void> {
    const events = (await this.adapter.loadEvents(this.host.namespace)).filter(
      (event) => verify(event) && !(event.kind >= 20000 && event.kind < 30000),
    );
    // Replay tombstones first so old records cannot briefly reappear on startup.
    events.sort((a, b) => Number(b.kind === 5) - Number(a.kind === 5));
    for (const event of events) {
      this.replaying = true;
      try {
        this.host.ingest(event);
      } finally {
        this.replaying = false;
      }
    }
  }
  ready(): Promise<void> {
    return this.hydration;
  }
  record(event: NostrEvent): void {
    if (
      this.closed ||
      this.replaying ||
      !verify(event) ||
      (event.kind >= 20000 && event.kind < 30000)
    )
      return;
    this.pending.set(event.id, structuredClone(event));
    if (this.pending.size >= this.options.batchSize) {
      void this.flush().catch((error) => this.report(error));
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush().catch((error) => this.report(error));
      }, this.options.flushInterval);
    }
  }
  async flush(): Promise<void> {
    await this.hydration;
    clearTimeout(this.timer);
    this.timer = undefined;
    const next = this.write
      .catch(() => {})
      .then(async () => {
        while (this.pending.size) {
          const batch = [...this.pending.values()].slice(0, this.options.batchSize);
          await this.adapter.putEvents(batch, this.host.namespace);
          for (const event of batch) this.pending.delete(event.id);
        }
      });
    this.write = next;
    return next;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    clearTimeout(this.timer);
    this.closing = this.flush().finally(() => this.adapter.close());
    return this.closing;
  }
}
