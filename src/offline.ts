import type { AutoReplayHost, AutoReplayOptions, AutoReplayStatus } from "./auto-replay";
import { NostrbaseAutoReplay } from "./auto-replay";
import { asError, NostrbaseError } from "./errors";
import type { PersistenceAdapter, QueuedEvent } from "./persistence";
import { MemoryPersistenceAdapter } from "./persistence";
import { verify } from "./protocol";
import type { NostrEvent, Result, Session, WriteReceipt } from "./types";

export interface OfflineOptions {
  adapter?: PersistenceAdapter;
  maxEntries?: number;
  autoReplay?: boolean | AutoReplayOptions;
}
export interface QueuedWriteReceipt extends WriteReceipt {
  queued: true;
  persisted: true;
}
interface OfflineHost {
  namespace: string;
  minWriteAcks: number;
  auth: {
    readonly revision?: number;
    readonly revisionSignal?: AbortSignal;
    getSession(): Promise<Result<Session>>;
  };
  ready(): Promise<void>;
  assertOpen(): void;
  signal(signal?: AbortSignal): AbortSignal;
  ingest(event: NostrEvent): boolean;
  publish(event: NostrEvent, signal?: AbortSignal): Promise<WriteReceipt>;
}
function validEntry(entry: QueuedEvent): boolean {
  return Boolean(
    entry &&
      typeof entry === "object" &&
      verify(entry.event) &&
      !(entry.event.kind >= 20000 && entry.event.kind < 30000) &&
      Number.isSafeInteger(entry.queuedAt) &&
      entry.queuedAt >= 0 &&
      Number.isSafeInteger(entry.attempts) &&
      entry.attempts >= 0 &&
      Array.isArray(entry.relays),
  );
}
/** Explicit queue of already signed events. Replay never asks a signer to create new events. */
export class NostrbaseOffline {
  readonly adapter: PersistenceAdapter;
  private maximum: number;
  private lock: Promise<void> = Promise.resolve();
  private owned: boolean;
  private closed = false;
  private hydration?: Promise<void>;
  private replay?: NostrbaseAutoReplay;
  constructor(
    private host: OfflineHost,
    options: OfflineOptions = {},
    shared?: PersistenceAdapter,
  ) {
    this.adapter = options.adapter ?? shared ?? new MemoryPersistenceAdapter();
    this.owned = this.adapter !== shared;
    this.maximum = options.maxEntries ?? 1000;
    if (!Number.isSafeInteger(this.maximum) || this.maximum < 1)
      throw new NostrbaseError("INVALID_CONFIG", "offline.maxEntries must be a positive integer.");
  }
  /** Installed by the client after all queue hosts exist. */
  attachAutoReplay(host: AutoReplayHost, options?: boolean | AutoReplayOptions): void {
    this.replay = new NostrbaseAutoReplay(host);
    if (options) this.replay.start(options === true ? {} : options);
  }
  startAutoReplay(options: AutoReplayOptions = {}): void {
    this.host.assertOpen();
    if (!this.replay)
      throw new NostrbaseError("INVALID_CONFIG", "Automatic replay needs a client host.");
    this.replay.start(options);
  }
  stopAutoReplay(): void {
    this.replay?.stop();
  }
  get autoReplayStatus(): AutoReplayStatus {
    return (
      this.replay?.status ?? { running: false, inFlight: false, failures: 0, nextRetryAt: null }
    );
  }
  /** Wake only after a durable queue/publication obligation is committed. */
  notifyReplayWork(): void {
    this.replay?.wake();
  }
  async hasPending(pubkey: string): Promise<boolean> {
    return (await this.list()).some((entry) => entry.event.pubkey === pubkey);
  }
  /** Restore optimistic signed writes from the durable queue after cache hydration. */
  ready(): Promise<void> {
    this.hydration ??= Promise.resolve().then(async () => {
      await this.host.ready();
      const queue = await this.adapter.loadQueue(this.host.namespace);
      if (this.closed) return;
      const valid = queue
        .filter(validEntry)
        .sort(
          (a, b) =>
            Number(b.event.kind === 5) - Number(a.event.kind === 5) ||
            a.queuedAt - b.queuedAt ||
            a.event.id.localeCompare(b.event.id),
        );
      for (const entry of valid) this.host.ingest(entry.event);
    });
    return this.hydration;
  }
  private async serialized<T>(run: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release = () => {};
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      this.host.assertOpen();
      if (this.closed) throw new NostrbaseError("CLIENT_CLOSED", "Offline queue is closed.");
      await this.ready();
      return await run();
    } finally {
      release();
    }
  }
  private async owner(): Promise<string> {
    const session = await this.host.auth.getSession();
    if (session.error) throw session.error;
    if (!session.data)
      throw new NostrbaseError("AUTH_REQUIRED", "Sign in before queueing or replaying writes.");
    return session.data.user.pubkey;
  }
  async enqueueSigned(event: NostrEvent): Promise<Result<QueuedWriteReceipt>> {
    try {
      // Clone before asynchronous work so a caller cannot change the queued event.
      const signed = structuredClone(event);
      return await this.serialized(async () => {
        if (!verify(signed))
          throw new NostrbaseError("INVALID_RECORD", "Queued event signature is invalid.");
        if (signed.pubkey !== (await this.owner()))
          throw new NostrbaseError(
            "PERMISSION_DENIED",
            "You can only queue your own signed events.",
          );
        if (signed.kind >= 20000 && signed.kind < 30000)
          throw new NostrbaseError(
            "INVALID_RECORD",
            "Ephemeral events cannot be queued for later delivery.",
          );
        const queue = await this.adapter.loadQueue(this.host.namespace);
        const previous = queue.find((entry) => validEntry(entry) && entry.event.id === signed.id);
        if (!previous && queue.length >= this.maximum)
          throw new NostrbaseError("CONFLICT", "Offline queue is full. Flush or remove entries.");
        const queuedAt = Math.max(
          Date.now(),
          ...queue.filter(validEntry).map((entry) => entry.queuedAt + 1),
        );
        const entry = previous ?? { event: signed, queuedAt, attempts: 0, relays: [] };
        await this.adapter.putQueue(entry, this.host.namespace);
        this.notifyReplayWork();
        // Only expose optimistic state after the queue write commits.
        this.host.ingest(signed);
        return {
          data: {
            id: signed.id,
            eventId: signed.id,
            relays: entry.relays,
            queued: true,
            persisted: true,
          },
          error: null,
        };
      });
    } catch (error) {
      return { data: null, error: asError(error) };
    }
  }
  list(): Promise<QueuedEvent[]> {
    return this.serialized(async () => {
      const queue = await this.adapter.loadQueue(this.host.namespace);
      return queue
        .filter(validEntry)
        .sort((a, b) => a.queuedAt - b.queuedAt || a.event.id.localeCompare(b.event.id));
    });
  }
  /** Cancel future delivery only. The optimistic cached event remains; no rollback or deletion is sent. */
  remove(eventId: string): Promise<boolean> {
    return this.serialized(async () => {
      const queue = await this.adapter.loadQueue(this.host.namespace);
      const entry = queue.find(
        (item) => item && typeof item === "object" && item.event?.id === eventId,
      );
      if (!entry) return false;
      if (entry.event.pubkey !== (await this.owner()))
        throw new NostrbaseError(
          "PERMISSION_DENIED",
          "You can only remove your own queued writes.",
        );
      await this.adapter.removeQueue(eventId, this.host.namespace);
      return true;
    });
  }
  async flush(options: { signal?: AbortSignal } = {}): Promise<Result<WriteReceipt[]>> {
    const receipts: WriteReceipt[] = [];
    try {
      return await this.serialized(async () => {
        const revision = this.host.auth.revision;
        const revisionSignal = this.host.auth.revisionSignal;
        const signal = this.host.signal(
          revisionSignal
            ? AbortSignal.any([revisionSignal, ...(options.signal ? [options.signal] : [])])
            : options.signal,
        );
        const guard = async () => {
          if (signal.aborted) throw new NostrbaseError("ABORTED", "Queue replay was aborted.");
          if (this.host.auth.revision !== revision || (await this.owner()) !== pubkey)
            throw new NostrbaseError(
              "AUTH_FAILED",
              "The active account changed during queue replay.",
            );
        };
        if (signal.aborted) throw new NostrbaseError("ABORTED", "Queue replay was aborted.");
        const pubkey = await this.owner();
        const rawQueue = await this.adapter.loadQueue(this.host.namespace);
        const invalid = rawQueue.some((entry) => !validEntry(entry));
        const queue = rawQueue
          .filter(validEntry)
          .sort((a, b) => a.queuedAt - b.queuedAt || a.event.id.localeCompare(b.event.id));
        let failure: NostrbaseError | null = invalid
          ? new NostrbaseError("INVALID_RECORD", "A persisted queued event is invalid.")
          : null;
        for (const entry of queue) {
          if (signal.aborted) throw new NostrbaseError("ABORTED", "Queue replay was aborted.");
          if (!validEntry(entry)) {
            failure = new NostrbaseError(
              "INVALID_RECORD",
              "A persisted queued event has an invalid signature.",
            );
            continue;
          }
          if (entry.event.pubkey !== pubkey) continue;
          await guard();
          // Record the attempt first. A crash can cause an identical event to be replayed safely.
          entry.attempts++;
          await this.adapter.putQueue(entry, this.host.namespace);
          await guard();
          if (signal.aborted) throw new NostrbaseError("ABORTED", "Queue replay was aborted.");
          const receipt = await this.host.publish(structuredClone(entry.event), signal);
          receipts.push(receipt);
          entry.relays = receipt.relays;
          if (signal.aborted) {
            await this.adapter.putQueue(entry, this.host.namespace);
            throw new NostrbaseError("ABORTED", "Queue replay was aborted.");
          }
          if (receipt.relays.filter((relay) => relay.ok).length >= this.host.minWriteAcks)
            await this.adapter.removeQueue(entry.event.id, this.host.namespace);
          else {
            await this.adapter.putQueue(entry, this.host.namespace);
            failure = new NostrbaseError(
              "PUBLISH_FAILED",
              "Queued write did not meet minWriteAcks.",
              receipt,
            );
          }
        }
        return {
          data: receipts,
          error: failure,
          count: receipts.length,
          meta: {
            relays: receipts.flatMap((receipt) => receipt.relays),
            partial: failure !== null,
            receipts,
          },
        };
      });
    } catch (error) {
      return {
        data: receipts,
        error: asError(error),
        count: receipts.length,
        meta: { relays: receipts.flatMap((receipt) => receipt.relays), partial: true, receipts },
      };
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    this.stopAutoReplay();
    await this.replay?.idle();
    await this.lock;
    await this.hydration?.catch(() => {});
    if (this.owned) await this.adapter.close();
  }
}
