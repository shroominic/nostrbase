import type { NostrNetworkInterface, PublishResponse } from "@internet-privacy/marmot-ts/client";
import { matchFilters } from "nostr-tools";
import { Observable, Subscription } from "rxjs";
import { asError, NostrbaseError } from "./errors";
import type { EncryptedGroupStore } from "./group-store";
import { compareEvents, verify } from "./protocol";
import type { Filter, NostrEvent, RelayResult, Result, Transport, WriteReceipt } from "./types";

/** Exact signed envelopes with an explicit, account-scoped set of publication obligations. */
export interface GroupOutboxEntry {
  event: NostrEvent;
  targets: string[];
  relays: RelayResult[];
  createdAt: number;
}

export interface GroupNetworkHost {
  readonly transport: Transport;
  readonly relays: readonly string[];
  readonly timeout: number;
  readonly minWriteAcks: number;
  /** Check the captured account and auth revision, including same-key signer replacements. */
  guard(): void | Promise<void>;
  signal(signal?: AbortSignal): AbortSignal;
  /** Ephemeral caller cancellation for this exact publication; never stored in the outbox. */
  publicationSignal?(event: NostrEvent): AbortSignal | undefined;
  /** Save the owning group's encrypted ratchet/state before any envelope escapes. */
  beforePublish?(event: NostrEvent): Promise<void>;
  /** Persist the owning group's exact WAL response before Marmot sees the acknowledgements. */
  afterPublish?(event: NostrEvent, responses: Record<string, PublishResponse>): Promise<void>;
}
type OutboxStore = Pick<
  EncryptedGroupStore<GroupOutboxEntry>,
  "getItem" | "setItem" | "removeItem" | "keys"
>;

export class GroupNetworkPublicationError extends NostrbaseError {
  readonly context: { stage: "published" | "expired"; durable: boolean };
  constructor(
    message: string,
    readonly receipt: WriteReceipt,
    context: { stage: "published" | "expired"; durable: boolean; cause?: unknown },
  ) {
    super("PUBLISH_FAILED", message, { receipt, stage: context.stage, durable: context.durable });
    this.context = { stage: context.stage, durable: context.durable };
  }
}

function relayURL(value: string): string {
  try {
    const url = new URL(value);
    if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.hash)
      throw new Error();
    return url.toString();
  } catch {
    throw new NostrbaseError("INVALID_QUERY", "Group relay URLs must be valid WS(S) endpoints.");
  }
}
function snapshotEvent(event: NostrEvent): NostrEvent {
  let clone: NostrEvent;
  try {
    clone = structuredClone(event);
  } catch {
    throw new NostrbaseError("INVALID_RECORD", "Group envelope is not a signed Nostr event.");
  }
  if (!verify(clone))
    throw new NostrbaseError("INVALID_RECORD", "Group envelope signature is invalid.");
  return clone;
}
function expiration(event: NostrEvent): number | undefined {
  const tags = event.tags.filter((tag) => tag[0] === "expiration");
  if (!tags.length) return undefined;
  const value = Number(tags[0]?.[1]);
  if (tags.length !== 1 || !Number.isSafeInteger(value) || value < 0)
    throw new NostrbaseError("INVALID_RECORD", "Group envelope expiration is invalid.");
  return value;
}

/** Marmot's network interface over the SDK's existing Applesauce-backed transport. */
export class GroupNetwork implements NostrNetworkInterface {
  private readonly allowed: Set<string>;
  private readonly lifetime = new AbortController();
  private readonly subscriptions = new Set<Subscription>();
  private readonly receipts = new Map<string, WriteReceipt>();
  private readonly failures = new Map<string, GroupNetworkPublicationError>();
  private lock: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly host: GroupNetworkHost,
    private readonly outbox: OutboxStore,
  ) {
    this.allowed = new Set(host.relays.map(relayURL));
    if (!this.allowed.size || !Number.isSafeInteger(host.timeout) || host.timeout < 1)
      throw new NostrbaseError("INVALID_CONFIG", "Configure group relays and a positive timeout.");
  }

  private async guard(): Promise<void> {
    if (this.lifetime.signal.aborted)
      throw new NostrbaseError("CLIENT_CLOSED", "Group network is closed.");
    await this.host.guard();
    if (this.lifetime.signal.aborted)
      throw new NostrbaseError("CLIENT_CLOSED", "Group network is closed.");
  }
  private targets(input: readonly string[]): string[] {
    if (!Array.isArray(input) || !input.length)
      throw new NostrbaseError("INVALID_QUERY", "Choose at least one configured group relay.");
    const targets = [...new Set(input.map(relayURL))];
    if (targets.some((relay) => !this.allowed.has(relay)))
      throw new NostrbaseError(
        "PERMISSION_DENIED",
        "Group network access is limited to client-configured relay endpoints.",
      );
    return targets;
  }
  private filters(input: Filter | Filter[]): Filter[] {
    const filters = structuredClone(Array.isArray(input) ? input : [input]);
    if (
      !filters.length ||
      filters.some((filter) => !filter || typeof filter !== "object" || Array.isArray(filter))
    )
      throw new NostrbaseError("INVALID_QUERY", "Use at least one Nostr group filter.");
    return filters;
  }
  private signal(signal?: AbortSignal): AbortSignal {
    return AbortSignal.any([this.host.signal(signal), this.lifetime.signal]);
  }
  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lock.then(operation, operation);
    this.lock = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  private async bounded<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    signal = this.signal(),
    preserveAcks = false,
  ): Promise<T> {
    if (signal.aborted) throw new NostrbaseError("ABORTED", "Group network operation was aborted.");
    const deadline = new AbortController();
    const combined = AbortSignal.any([signal, deadline.signal]);
    let abort: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => {
        const error = new NostrbaseError(
          signal.aborted ? "ABORTED" : "RELAY_ERROR",
          signal.aborted
            ? "Group network operation was aborted."
            : "Group relay operation timed out.",
        );
        // Native transport aggregates completed acknowledgements on abort. Let its promises
        // settle before rejecting; otherwise a cancelled second relay can hide the first ack.
        if (preserveAcks) cancelTimer = setTimeout(() => reject(error), 0);
        else reject(error);
      };
      combined.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => deadline.abort(), this.host.timeout);
      if (combined.aborted) abort();
    });
    try {
      return await Promise.race([operation(combined), cancelled]);
    } finally {
      clearTimeout(timer);
      clearTimeout(cancelTimer);
      if (abort) combined.removeEventListener("abort", abort);
    }
  }
  private entry(input: GroupOutboxEntry, key: string): GroupOutboxEntry {
    const event = snapshotEvent(input?.event);
    if (
      event.id !== key ||
      !Number.isSafeInteger(input.createdAt) ||
      input.createdAt < 0 ||
      !Array.isArray(input.relays)
    )
      throw new NostrbaseError("INVALID_RECORD", "Persisted group outbox entry is invalid.");
    const targets = this.targets(input.targets);
    const relays: RelayResult[] = [];
    for (const relay of input.relays) {
      if (!relay || typeof relay.ok !== "boolean")
        throw new NostrbaseError("INVALID_RECORD", "Persisted group acknowledgement is invalid.");
      const url = relayURL(relay.url);
      if (!targets.includes(url) || relays.some((status) => status.url === url))
        throw new NostrbaseError(
          "INVALID_RECORD",
          "Persisted group acknowledgement has an invalid target.",
        );
      relays.push({
        url,
        ok: relay.ok,
        ...(typeof relay.message === "string" ? { message: relay.message } : {}),
      });
    }
    return { event, targets, relays, createdAt: input.createdAt };
  }
  private statuses(targets: string[], statuses: RelayResult[]): RelayResult[] {
    return targets.map((url) => {
      const matching = statuses.filter((status) => {
        try {
          return relayURL(status.url) === url;
        } catch {
          return false;
        }
      });
      if (matching.length !== 1 || typeof matching[0]?.ok !== "boolean")
        return { url, ok: false, message: "Relay did not return one valid acknowledgement." };
      return {
        url,
        ok: matching[0].ok,
        ...(typeof matching[0].message === "string" ? { message: matching[0].message } : {}),
      };
    });
  }
  private remember(eventId: string, statuses: RelayResult[]): WriteReceipt {
    const confirmed = new Map(
      this.receipts.get(eventId)?.relays.map((relay) => [relay.url, relay]) ?? [],
    );
    for (const relay of statuses) {
      if (!confirmed.get(relay.url)?.ok || relay.ok)
        confirmed.set(relay.url, structuredClone(relay));
    }
    const receipt = { id: eventId, eventId, relays: [...confirmed.values()] };
    this.receipts.set(eventId, receipt);
    return structuredClone(receipt);
  }
  receipt(eventId: string): WriteReceipt | undefined {
    const receipt = this.receipts.get(eventId);
    return receipt ? structuredClone(receipt) : undefined;
  }
  /** Preserve actual relay acks when a publication cannot complete its local durable work. */
  receiptResult(eventId: string): Result<WriteReceipt> {
    const data = this.receipt(eventId) ?? null;
    const failure = this.failures.get(eventId);
    const acknowledgements = data?.relays.filter((relay) => relay.ok).length ?? 0;
    return {
      data,
      error:
        failure ??
        (acknowledgements < this.host.minWriteAcks
          ? new NostrbaseError(
              "PUBLISH_FAILED",
              "Group publication did not meet minWriteAcks.",
              data,
            )
          : null),
      ...(data
        ? {
            meta: {
              relays: data.relays,
              partial: !!failure || data.relays.some((relay) => !relay.ok),
              receipts: [data],
            },
          }
        : {}),
    };
  }

  async publish(relays: string[], input: NostrEvent): Promise<Record<string, PublishResponse>> {
    const event = snapshotEvent(input);
    const targets = this.targets(relays);
    return this.serialized(async () => {
      await this.guard();
      const stored = await this.outbox.getItem(event.id);
      const previous = stored ? this.entry(stored, event.id) : null;
      await this.guard();
      const entry: GroupOutboxEntry = {
        event,
        targets: [...new Set([...(previous?.targets ?? []), ...targets])],
        relays: previous?.relays ?? [],
        createdAt: previous?.createdAt ?? Date.now(),
      };
      await this.outbox.setItem(event.id, structuredClone(entry));
      await this.guard();
      return this.publishEntry(entry, targets);
    });
  }
  private async publishEntry(
    entry: GroupOutboxEntry,
    targets: string[],
  ): Promise<Record<string, PublishResponse>> {
    this.checkExpiry(entry);
    await this.guard();
    await this.host.beforePublish?.(structuredClone(entry.event));
    await this.guard();
    this.checkExpiry(entry);
    let statuses: RelayResult[];
    let transportError: unknown;
    try {
      statuses = this.statuses(
        targets,
        await this.bounded(
          (signal) =>
            this.host.transport.publish(targets, structuredClone(entry.event), {
              timeout: this.host.timeout,
              signal,
            }),
          this.signal(this.host.publicationSignal?.(structuredClone(entry.event))),
          true,
        ),
      );
    } catch (error) {
      transportError = error;
      statuses = targets.map((url) => ({
        url,
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }));
    }
    const acknowledgements = new Map(entry.relays.map((relay) => [relay.url, relay]));
    for (const status of statuses) {
      const previous = acknowledgements.get(status.url);
      // An earlier successful ack remains evidence even if a replay encounters a rejection.
      if (!previous?.ok || status.ok) acknowledgements.set(status.url, status);
    }
    entry.relays = entry.targets.map(
      (url) =>
        acknowledgements.get(url) ?? {
          url,
          ok: false,
          message: "Publication has not been attempted.",
        },
    );
    const receipt = this.remember(entry.event.id, entry.relays);
    this.failures.delete(entry.event.id);
    const response: Record<string, PublishResponse> = Object.create(null);
    for (const status of statuses)
      response[status.url] = {
        from: status.url,
        ok: status.ok,
        ...(status.message ? { message: status.message } : {}),
      };
    let postError: unknown;
    try {
      await this.host.afterPublish?.(structuredClone(entry.event), structuredClone(response));
      await this.guard();
      await this.outbox.setItem(entry.event.id, structuredClone(entry));
      await this.guard();
      if (entry.relays.every((relay) => relay.ok)) {
        await this.outbox.removeItem(entry.event.id);
        await this.guard();
      }
    } catch (error) {
      postError = error;
    }
    if (postError) {
      const error = new GroupNetworkPublicationError(
        "Group envelope was sent, but its local durable publication state could not be completed.",
        receipt,
        { stage: "published", durable: false, cause: postError },
      );
      this.failures.set(entry.event.id, error);
      // Engine commit logic must see real accepted acks. SDK callers inspect receiptResult().
      if (!statuses.some((status) => status.ok)) throw error;
    }
    if (transportError && !statuses.some((status) => status.ok)) {
      const error = new GroupNetworkPublicationError(
        "Group envelope publication did not complete.",
        receipt,
        { stage: "published", durable: true, cause: transportError },
      );
      this.failures.set(entry.event.id, error);
      throw error;
    }
    return response;
  }
  private checkExpiry(entry: GroupOutboxEntry): void {
    const expiredAt = expiration(entry.event);
    if (expiredAt !== undefined && expiredAt <= Math.floor(Date.now() / 1000)) {
      const receipt = this.remember(
        entry.event.id,
        entry.targets.map(
          (url) =>
            entry.relays.find((relay) => relay.url === url && relay.ok) ?? {
              url,
              ok: false,
              message: "Signed envelope has expired; it was not published.",
            },
        ),
      );
      const error = new GroupNetworkPublicationError(
        "Signed group envelope has expired.",
        receipt,
        { stage: "expired", durable: true },
      );
      this.failures.set(entry.event.id, error);
      throw error;
    }
  }
  async listPending(): Promise<GroupOutboxEntry[]> {
    return this.serialized(async () => {
      await this.guard();
      const keys = await this.outbox.keys();
      await this.guard();
      const entries: GroupOutboxEntry[] = [];
      for (const key of keys) {
        const entry = await this.outbox.getItem(key);
        await this.guard();
        if (entry) {
          const restored = this.entry(entry, key);
          this.remember(restored.event.id, restored.relays);
          entries.push(restored);
        }
      }
      return entries.sort(
        (a, b) => a.createdAt - b.createdAt || a.event.id.localeCompare(b.event.id),
      );
    });
  }
  async flushPending(): Promise<Result<WriteReceipt[]>> {
    const receipts: WriteReceipt[] = [];
    try {
      const pending = await this.listPending();
      let failure: NostrbaseError | null = null;
      for (const entry of pending) {
        try {
          await this.serialized(async () => {
            await this.guard();
            const stored = await this.outbox.getItem(entry.event.id);
            await this.guard();
            if (!stored) return;
            const current = this.entry(stored, entry.event.id);
            const remaining = current.targets.filter(
              (target) => !current.relays.some((relay) => relay.url === target && relay.ok),
            );
            if (!remaining.length) {
              const receipt = this.remember(current.event.id, current.relays);
              try {
                await this.outbox.removeItem(current.event.id);
                await this.guard();
                this.failures.delete(current.event.id);
              } catch (cause) {
                const error = new GroupNetworkPublicationError(
                  "Acknowledged group envelope could not be removed from the outbox.",
                  receipt,
                  { stage: "published", durable: false, cause },
                );
                this.failures.set(current.event.id, error);
                throw error;
              }
              return;
            }
            const targets = this.targets(remaining);
            await this.publishEntry({ ...current, event: snapshotEvent(current.event) }, targets);
          });
          const result = this.receiptResult(entry.event.id);
          if (result.data) receipts.push(result.data);
          failure ??= result.error;
        } catch (error) {
          const receipt = this.receipt(entry.event.id);
          if (receipt) receipts.push(receipt);
          failure ??= asError(error);
          if (
            failure.code === "AUTH_FAILED" ||
            failure.code === "AUTH_REQUIRED" ||
            failure.code === "ABORTED" ||
            failure.code === "CLIENT_CLOSED"
          )
            break;
        }
      }
      return {
        data: receipts,
        error: failure,
        count: receipts.length,
        meta: {
          relays: receipts.flatMap((receipt) => receipt.relays),
          partial:
            !!failure || receipts.some((receipt) => receipt.relays.some((relay) => !relay.ok)),
          receipts,
        },
      };
    } catch (error) {
      return {
        data: receipts,
        error: asError(error),
        count: receipts.length,
        meta: { relays: receipts.flatMap((receipt) => receipt.relays), partial: true, receipts },
      };
    }
  }
  async request(
    relays: string[],
    input: Filter | Filter[],
    signal?: AbortSignal,
  ): Promise<NostrEvent[]> {
    const targets = this.targets(relays);
    const filters = this.filters(input);
    await this.guard();
    const combined = this.signal(signal);
    const response = await this.bounded(
      (signal) =>
        this.host.transport.request(targets, filters, { timeout: this.host.timeout, signal }),
      combined,
    );
    await this.guard();
    if (combined.aborted)
      throw new NostrbaseError("ABORTED", "Group network operation was aborted.");
    if (!this.statuses(targets, response.relays).some((relay) => relay.ok))
      throw new NostrbaseError(
        "RELAY_ERROR",
        "Every group relay failed to complete the read.",
        response.relays,
      );
    const events = new Map<string, NostrEvent>();
    for (const event of response.events) {
      try {
        const signed = snapshotEvent(event);
        if (matchFilters(filters, signed)) events.set(signed.id, signed);
      } catch {
        /* Reject invalid transport events without exposing them. */
      }
    }
    await this.guard();
    return [...events.values()];
  }
  subscription(relays: string[], input: Filter | Filter[]): Observable<NostrEvent> {
    const targets = this.targets(relays);
    const filters = this.filters(input);
    return new Observable((observer) => {
      const subscription = new Subscription();
      this.subscriptions.add(subscription);
      let serial: Promise<void> = Promise.resolve();
      const fail = (error: unknown) => {
        if (!subscription.closed) observer.error(asError(error));
        subscription.unsubscribe();
      };
      const abort = () => fail(new NostrbaseError("ABORTED", "Group subscription was aborted."));
      subscription.add(() => this.subscriptions.delete(subscription));
      void this.guard()
        .then(() => {
          if (subscription.closed) return;
          const signal = this.signal();
          if (signal.aborted) {
            abort();
            return;
          }
          signal.addEventListener("abort", abort, { once: true });
          subscription.add(() => signal.removeEventListener("abort", abort));
          subscription.add(
            this.host.transport.subscribe(targets, filters).subscribe({
              next: (event) => {
                let signed: NostrEvent;
                try {
                  signed = snapshotEvent(event);
                  if (!matchFilters(filters, signed)) return;
                } catch {
                  return;
                }
                serial = serial
                  .then(async () => {
                    if (subscription.closed) return;
                    await this.guard();
                    if (!subscription.closed) observer.next(signed);
                  })
                  .catch(fail);
              },
              error: fail,
              complete: () => {
                void serial.then(() => {
                  if (!subscription.closed) observer.complete();
                  subscription.unsubscribe();
                });
              },
            }),
          );
        })
        .catch(fail);
      return subscription;
    });
  }
  async getUserInboxRelays(pubkey: string): Promise<string[]> {
    if (typeof pubkey !== "string" || !/^[0-9a-f]{64}$/.test(pubkey))
      throw new NostrbaseError("INVALID_QUERY", "Inbox relay lookup needs a full hex public key.");
    const events = await this.request([...this.allowed], { kinds: [10050], authors: [pubkey] });
    const event = events.sort((a, b) => compareEvents(b, a))[0];
    if (!event) return [...this.allowed];
    const relays = event.tags.filter((tag) => tag[0] === "relay").map((tag) => tag[1]);
    if (relays.some((relay) => typeof relay !== "string"))
      throw new NostrbaseError("INVALID_RECORD", "Inbox relay event has an invalid relay tag.");
    return this.targets(relays as string[]);
  }
  close(): void {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort();
    for (const subscription of this.subscriptions) subscription.unsubscribe();
    this.subscriptions.clear();
  }
  dispose(): void {
    this.close();
  }
}
