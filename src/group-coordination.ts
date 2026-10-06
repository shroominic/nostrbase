import { NostrbaseError } from "./errors";

type LockCallback<T> = () => Promise<T>;

const localQueues = new Map<string, Promise<void>>();

function randomToken(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random()}`;
  }
}

/**
 * Serializes group writes across tabs when Web Locks is available. IndexedDB
 * leases cover browsers without Web Locks; the in-memory queue is the final
 * fallback for server runtimes with no browser coordination primitive.
 */
export class GroupCoordinator {
  private closed = false;
  private database?: Promise<IDBDatabase>;
  private readonly databaseName: string;
  constructor(namespace: string) {
    this.databaseName = `nostrbase-coordination:${namespace}`;
  }

  async run<T>(name: string, callback: LockCallback<T>, signal?: AbortSignal): Promise<T> {
    if (this.closed) throw new NostrbaseError("CLIENT_CLOSED", "Group coordination is closed.");
    if (signal?.aborted) throw new NostrbaseError("ABORTED", "Group operation was aborted.");
    const locks = globalThis.navigator?.locks;
    if (locks) {
      return locks.request(name, { mode: "exclusive", signal }, callback);
    }
    if (globalThis.indexedDB) return this.runLease(name, callback, signal);
    return this.runLocal(name, callback);
  }

  private async runLocal<T>(name: string, callback: LockCallback<T>): Promise<T> {
    const previous = localQueues.get(name) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    localQueues.set(
      name,
      previous.then(() => current),
    );
    await previous;
    try {
      return await callback();
    } finally {
      release();
      if (localQueues.get(name) === current) localQueues.delete(name);
    }
  }

  private async openDatabase(): Promise<IDBDatabase> {
    this.database ??= new Promise((resolve, reject) => {
      const request = globalThis.indexedDB.open(this.databaseName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("leases"))
          request.result.createObjectStore("leases", { keyPath: "name" });
      };
      request.onerror = () => reject(request.error ?? new Error("Coordination database failed."));
      request.onsuccess = () => resolve(request.result);
    });
    return this.database;
  }

  private async leaseRequest<T>(
    _name: string,
    action: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const database = await this.openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction("leases", "readwrite");
      const request = action(transaction.objectStore("leases"));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error ?? request.error);
      transaction.onabort = () => reject(transaction.error ?? request.error);
    });
  }

  private async runLease<T>(
    name: string,
    callback: LockCallback<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const token = randomToken();
    const leaseMs = 5000;
    while (true) {
      if (signal?.aborted) throw new NostrbaseError("ABORTED", "Group operation was aborted.");
      const now = Date.now();
      const acquired = await this.leaseRequest(name, (store) => {
        const request = store.get(name);
        const result = { name, token, expires: now + leaseMs };
        const original = request.onsuccess;
        request.onsuccess = (event) => {
          original?.call(request, event);
          const current = request.result as { expires?: number } | undefined;
          if (!current || (current.expires ?? 0) <= now) store.put(result);
        };
        return request as IDBRequest<boolean>;
      }).catch(() => false);
      if (acquired) break;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 25);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new NostrbaseError("ABORTED", "Group operation was aborted."));
          },
          { once: true },
        );
      });
    }
    const renew = setInterval(
      () => {
        void this.leaseRequest(name, (store) => {
          const request = store.get(name);
          const original = request.onsuccess;
          request.onsuccess = (event) => {
            original?.call(request, event);
            if (request.result?.token === token)
              store.put({ name, token, expires: Date.now() + leaseMs });
          };
          return request as IDBRequest<unknown>;
        }).catch(() => {});
      },
      Math.floor(leaseMs / 3),
    );
    try {
      return await callback();
    } finally {
      clearInterval(renew);
      await this.leaseRequest(name, (store) => {
        const request = store.get(name);
        const original = request.onsuccess;
        request.onsuccess = (event) => {
          original?.call(request, event);
          if (request.result?.token === token) store.delete(name);
        };
        return request as IDBRequest<unknown>;
      }).catch(() => {});
    }
  }

  close(): void {
    this.closed = true;
    void this.database?.then((database) => database.close());
  }
}
