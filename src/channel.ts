import { matchFilters } from "nostr-tools";
import { Subscription } from "rxjs";
import type { NostrbaseClient } from "./client";
import { asError, NostrbaseError } from "./errors";
import {
  addressOf,
  compareEvents,
  decodeRecord,
  isObject,
  RECORD_KIND,
  scopeTag,
  verify,
} from "./protocol";
import type { Predicate } from "./query";
import { matches } from "./query";
import type {
  ChangeFilter,
  ChangePayload,
  ChannelStatus,
  Filter,
  NostrEvent,
  Result,
  Row,
  SchemaShape,
  WriteReceipt,
} from "./types";

/** Public channel traffic. Relay storage of ephemeral events is not required by Nostr. */
export const REALTIME_KIND = 20078;
export interface ChannelOptions {
  broadcast?: { self?: boolean };
  /** Times are seconds. Heartbeats must occur before half the TTL has passed. */
  presence?: { ttl?: number; heartbeatInterval?: number };
}
export interface BroadcastMessage {
  type: "broadcast";
  event: string;
  payload: unknown;
}
export interface BroadcastPayload extends BroadcastMessage {
  pubkey: string;
  sessionId: string;
  eventId: string;
}
export interface PresenceMeta {
  pubkey: string;
  sessionId: string;
  state: Record<string, unknown>;
  expiresAt: number;
}
export type PresenceState = Record<string, PresenceMeta[]>;
export interface PresencePayload {
  event: "sync" | "join" | "leave";
  key?: string;
  newPresences?: PresenceMeta[];
  leftPresences?: PresenceMeta[];
}
interface WireMessage {
  v: 1;
  namespace: string;
  channel: string;
  sessionId: string;
  sequence: number;
  type: "broadcast" | "presence";
  event?: string;
  payload?: unknown;
  state?: Record<string, unknown> | null;
}
const realtimeTag = (namespace: string, channel: string): string =>
  `nostrbase:channel:${encodeURIComponent(namespace)}:${encodeURIComponent(channel)}`;

function jsonValue(value: unknown): unknown {
  const visit = (entry: unknown, ancestors: Set<object>): void => {
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") return;
    if (typeof entry === "number" && Number.isFinite(entry)) return;
    if (!entry || typeof entry !== "object" || ancestors.has(entry))
      throw new NostrbaseError("INVALID_RECORD", "Channel data must contain JSON values only.");
    if (
      !Array.isArray(entry) &&
      Object.getPrototypeOf(entry) !== Object.prototype &&
      Object.getPrototypeOf(entry) !== null
    )
      throw new NostrbaseError("INVALID_RECORD", "Channel data must contain JSON values only.");
    ancestors.add(entry);
    for (const item of Object.values(entry)) visit(item, ancestors);
    ancestors.delete(entry);
  };
  visit(value, new Set());
  return JSON.parse(JSON.stringify(value));
}

interface Listener {
  filter: ChangeFilter;
  predicates: Predicate[];
  callback: (payload: ChangePayload<object>) => void;
}
export class NostrbaseChannel<DB extends SchemaShape<DB>> {
  private listeners: Listener[] = [];
  private broadcastListeners: { event: string; callback: (payload: BroadcastPayload) => void }[] =
    [];
  private presenceListeners: {
    event: PresencePayload["event"];
    callback: (payload: PresencePayload) => void;
  }[] = [];
  private readonly sessionId = crypto.randomUUID();
  private sequence = 0;
  private seen = new Map<string, number>();
  private versions = new Map<string, { sequence: number; createdAt: number; expiresAt: number }>();
  private presences = new Map<string, PresenceMeta>();
  private tracked?: { pubkey: string; state: Record<string, unknown> };
  private heartbeat?: ReturnType<typeof setInterval>;
  private expiry?: ReturnType<typeof setInterval>;
  private controller?: AbortController;
  private queue: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private readonly ttl: number;
  private readonly heartbeatInterval: number;
  private subscription?: Subscription;
  private rows = new Map<string, { table: string; row: Row<object>; event: NostrEvent }>();
  private statusCallback?: (status: ChannelStatus, error?: NostrbaseError) => void;
  constructor(
    private client: NostrbaseClient<DB>,
    readonly name: string,
    private options: ChannelOptions = {},
  ) {
    if (typeof name !== "string" || !name.trim() || name.length > 256)
      throw new NostrbaseError("INVALID_CONFIG", "Channel name must contain 1 to 256 characters.");
    this.ttl = options.presence?.ttl ?? 30;
    this.heartbeatInterval = options.presence?.heartbeatInterval ?? Math.min(10, this.ttl / 3);
    if (
      !Number.isSafeInteger(this.ttl) ||
      this.ttl < 2 ||
      this.ttl > 3600 ||
      !Number.isFinite(this.heartbeatInterval) ||
      this.heartbeatInterval <= 0 ||
      this.heartbeatInterval > this.ttl / 2
    )
      throw new NostrbaseError(
        "INVALID_CONFIG",
        "Presence TTL must be 2 to 3600 seconds; heartbeatInterval must be positive and at most half the TTL.",
      );
  }
  on<K extends keyof DB & string>(
    type: "nostr_changes" | "postgres_changes",
    filter: ChangeFilter & { table: K },
    callback: (payload: ChangePayload<DB[K]>) => void,
  ): this;
  on(
    type: "broadcast",
    filter: { event: string },
    callback: (payload: BroadcastPayload) => void,
  ): this;
  on(
    type: "presence",
    filter: { event: PresencePayload["event"] },
    callback: (payload: PresencePayload) => void,
  ): this;
  on(
    type: "nostr_changes" | "postgres_changes" | "broadcast" | "presence",
    filter: ChangeFilter | { event: string },
    callback: (payload: never) => void,
  ): this {
    this.client.assertOpen();
    if (this.subscription)
      throw new NostrbaseError("INVALID_QUERY", "Add channel handlers before subscribing.");
    if (type === "broadcast") {
      if (typeof filter.event !== "string" || !filter.event || filter.event.length > 256)
        throw new NostrbaseError(
          "INVALID_QUERY",
          "Broadcast event must contain 1 to 256 characters.",
        );
      this.broadcastListeners.push({
        event: filter.event,
        callback: callback as (payload: BroadcastPayload) => void,
      });
      return this;
    }
    if (type === "presence") {
      if (!["sync", "join", "leave"].includes(filter.event ?? ""))
        throw new NostrbaseError("INVALID_QUERY", "Use sync, join, or leave for presence.");
      this.presenceListeners.push({
        event: filter.event as PresencePayload["event"],
        callback: callback as (payload: PresencePayload) => void,
      });
      return this;
    }
    if ((type !== "nostr_changes" && type !== "postgres_changes") || !("table" in filter))
      throw new NostrbaseError("INVALID_QUERY", "Unknown channel handler type.");
    this.client.from(filter.table as keyof DB & string);
    if (filter.author && !/^[0-9a-f]{64}$/.test(filter.author))
      throw new NostrbaseError("INVALID_QUERY", "Channel author must be a hex public key.");
    if (filter.event && !["*", "INSERT", "UPDATE", "DELETE"].includes(filter.event))
      throw new NostrbaseError("INVALID_QUERY", "Invalid change event.");
    const predicates: Predicate[] = [];
    if (filter.filter) {
      const parsed = /^([A-Za-z_][A-Za-z0-9_]*)=eq\.(.+)$/.exec(filter.filter);
      if (!parsed)
        throw new NostrbaseError("INVALID_QUERY", "Channel filter must use field=eq.value.");
      let value: unknown = parsed[2];
      try {
        value = JSON.parse(parsed[2] as string);
      } catch {
        /* Unquoted strings are allowed. */
      }
      predicates.push({ field: parsed[1] as string, op: "eq", value });
    }
    this.listeners.push({
      filter: { ...filter },
      predicates,
      callback: callback as (payload: ChangePayload<object>) => void,
    });
    return this;
  }
  private status(status: ChannelStatus, error?: NostrbaseError): void {
    try {
      this.statusCallback?.(status, error);
    } catch {
      /* Isolate observers. */
    }
  }
  private notify<T>(callback: (payload: T) => void, payload: T): void {
    try {
      callback(structuredClone(payload));
    } catch (error) {
      this.status("CHANNEL_ERROR", asError(error, "INVALID_QUERY"));
    }
  }
  private emitPresence(payload: PresencePayload): void {
    for (const listener of this.presenceListeners)
      if (listener.event === payload.event) this.notify(listener.callback, payload);
  }
  /** State is grouped by signing public key; each browser tab has a distinct session. */
  presenceState(): PresenceState {
    this.expirePresence();
    const state: PresenceState = Object.create(null);
    for (const presence of this.presences.values()) {
      state[presence.pubkey] ??= [];
      state[presence.pubkey]?.push(structuredClone(presence));
    }
    return state;
  }
  private removePresence(key: string): void {
    const previous = this.presences.get(key);
    if (!previous) return;
    this.presences.delete(key);
    this.emitPresence({ event: "leave", key: previous.pubkey, leftPresences: [previous] });
    this.emitPresence({ event: "sync" });
  }
  private expirePresence(): void {
    const now = Math.floor(Date.now() / 1000);
    for (const [key, presence] of this.presences)
      if (presence.expiresAt <= now) this.removePresence(key);
    for (const [id, expiresAt] of this.seen) if (expiresAt <= now) this.seen.delete(id);
    // Retain leave revisions until any older heartbeat must have expired.
    for (const [key, version] of this.versions)
      if (version.createdAt + 3600 <= now) this.versions.delete(key);
  }
  private processRealtime(event: NostrEvent): void {
    if (
      event.kind !== REALTIME_KIND ||
      !verify(event) ||
      !event.tags.some(
        (tag) => tag[0] === "t" && tag[1] === realtimeTag(this.client.namespace, this.name),
      )
    )
      return;
    this.expirePresence();
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = Number(event.tags.find((tag) => tag[0] === "expiration")?.[1]);
    if (
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= now ||
      expiresAt <= event.created_at ||
      expiresAt > event.created_at + 3600 ||
      event.created_at > now + 30 ||
      this.seen.has(event.id)
    )
      return;
    let message: WireMessage;
    try {
      const parsed: unknown = JSON.parse(event.content);
      if (
        !isObject(parsed) ||
        parsed.v !== 1 ||
        parsed.namespace !== this.client.namespace ||
        parsed.channel !== this.name ||
        typeof parsed.sessionId !== "string" ||
        !parsed.sessionId ||
        parsed.sessionId.length > 128 ||
        !Number.isSafeInteger(parsed.sequence) ||
        (parsed.sequence as number) < 0
      )
        return;
      message = parsed as unknown as WireMessage;
    } catch {
      return;
    }
    this.seen.set(event.id, expiresAt);
    if (message.type === "broadcast") {
      if (
        typeof message.event !== "string" ||
        !message.event ||
        message.event.length > 256 ||
        !("payload" in message)
      )
        return;
      if (message.sessionId === this.sessionId && !this.options.broadcast?.self) return;
      const payload: BroadcastPayload = {
        type: "broadcast",
        event: message.event,
        payload: message.payload,
        pubkey: event.pubkey,
        sessionId: message.sessionId,
        eventId: event.id,
      };
      for (const listener of this.broadcastListeners)
        if (listener.event === "*" || listener.event === message.event)
          this.notify(listener.callback, payload);
    } else if (message.type === "presence") {
      if (message.state !== null && !isObject(message.state)) return;
      const key = `${event.pubkey}:${message.sessionId}`;
      const previous = this.versions.get(key);
      if (
        previous &&
        (message.sequence <= previous.sequence || event.created_at < previous.createdAt)
      )
        return;
      this.versions.set(key, {
        sequence: message.sequence,
        createdAt: event.created_at,
        expiresAt,
      });
      if (message.state === null) {
        this.removePresence(key);
        return;
      }
      const joined = !this.presences.has(key);
      const presence: PresenceMeta = {
        pubkey: event.pubkey,
        sessionId: message.sessionId,
        state: message.state as Record<string, unknown>,
        expiresAt,
      };
      this.presences.set(key, presence);
      if (joined) this.emitPresence({ event: "join", key: event.pubkey, newPresences: [presence] });
      this.emitPresence({ event: "sync" });
    }
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.queue.then(operation, operation);
    this.queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
  private async publishRealtime(
    content: Pick<WireMessage, "type" | "event" | "payload" | "state">,
    generation: number,
    expectedPubkey?: string,
  ): Promise<Result<WriteReceipt>> {
    try {
      this.client.assertOpen();
      if (!this.subscription || generation !== this.generation || !this.controller)
        throw new NostrbaseError("INVALID_QUERY", "Subscribe to the channel before sending.");
      const { session } = await this.client.auth.requireSigner();
      const pubkey = expectedPubkey ?? session.user.pubkey;
      if (session.user.pubkey !== pubkey)
        throw new NostrbaseError("AUTH_FAILED", "The presence signer changed.");
      const createdAt = Math.floor(Date.now() / 1000);
      const signal = AbortSignal.any([
        this.client.signal(this.controller.signal),
        AbortSignal.timeout(this.client.timeout),
      ]);
      const event = await this.client.sign(
        {
          kind: REALTIME_KIND,
          created_at: createdAt,
          tags: [
            ["t", realtimeTag(this.client.namespace, this.name)],
            ["expiration", String(createdAt + this.ttl)],
          ],
          content: JSON.stringify({
            v: 1,
            namespace: this.client.namespace,
            channel: this.name,
            sessionId: this.sessionId,
            sequence: ++this.sequence,
            ...content,
          }),
        },
        pubkey,
      );
      if (signal.aborted || generation !== this.generation)
        throw new NostrbaseError("ABORTED", "Channel operation was aborted.");
      if (createdAt + this.ttl <= Math.floor(Date.now() / 1000))
        throw new NostrbaseError(
          "PUBLISH_FAILED",
          "Channel event expired during signing. Retry the operation.",
        );
      if ((await this.client.auth.getSession()).data?.user.pubkey !== pubkey)
        throw new NostrbaseError("AUTH_FAILED", "The channel signer changed during the write.");
      const relays = await this.client.transport.publish(this.client.relays, event, {
        timeout: this.client.timeout,
        signal,
      });
      const receipt = { id: event.id, eventId: event.id, relays };
      const meta = { relays, partial: relays.some((relay) => !relay.ok), receipts: [receipt] };
      if (generation !== this.generation || signal.aborted)
        return {
          data: receipt,
          error: new NostrbaseError("ABORTED", "Channel operation was aborted."),
          meta,
        };
      if (
        content.type === "presence" &&
        (await this.client.auth.getSession()).data?.user.pubkey !== pubkey
      ) {
        this.stopTracking();
        return {
          data: receipt,
          error: new NostrbaseError("AUTH_FAILED", "The presence signer changed during the write."),
          meta,
        };
      }
      if (relays.some((relay) => relay.ok)) this.processRealtime(event);
      if (relays.filter((relay) => relay.ok).length < this.client.minWriteAcks)
        return {
          data: receipt,
          error: new NostrbaseError(
            "PUBLISH_FAILED",
            "Channel write did not meet minWriteAcks.",
            receipt,
          ),
          meta,
        };
      return { data: receipt, error: null, meta };
    } catch (error) {
      return { data: null, error: asError(error) };
    }
  }
  /** Signed public ephemeral broadcast. Receiving subscriptions need no signer. */
  send(message: BroadcastMessage): Promise<Result<WriteReceipt>> {
    const generation = this.generation;
    return this.enqueue(async () => {
      try {
        if (
          message.type !== "broadcast" ||
          typeof message.event !== "string" ||
          !message.event ||
          message.event.length > 256
        )
          throw new NostrbaseError("INVALID_QUERY", "Use a broadcast message with an event name.");
        return await this.publishRealtime(
          { type: "broadcast", event: message.event, payload: jsonValue(message.payload) },
          generation,
        );
      } catch (error) {
        return { data: null, error: asError(error) };
      }
    });
  }
  track(state: Record<string, unknown>): Promise<Result<WriteReceipt>> {
    const generation = this.generation;
    return this.enqueue(async () => {
      try {
        if (!isObject(state))
          throw new NostrbaseError("INVALID_RECORD", "Presence state must be an object.");
        const snapshot = jsonValue(state) as Record<string, unknown>;
        const { session } = await this.client.auth.requireSigner();
        const pubkey = session.user.pubkey;
        const result = await this.publishRealtime(
          { type: "presence", state: snapshot },
          generation,
          pubkey,
        );
        const current = await this.client.auth.getSession();
        if (
          result.data?.relays.some((relay) => relay.ok) &&
          generation === this.generation &&
          current.data?.user.pubkey === pubkey
        ) {
          this.tracked = { pubkey, state: snapshot };
          this.startHeartbeat();
        }
        return result;
      } catch (error) {
        return { data: null, error: asError(error) };
      }
    });
  }
  untrack(): Promise<Result<WriteReceipt>> {
    const generation = this.generation;
    return this.enqueue(async () => {
      const pubkey = this.tracked?.pubkey;
      this.stopTracking();
      return this.publishRealtime({ type: "presence", state: null }, generation, pubkey);
    });
  }
  private stopTracking(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.tracked = undefined;
    for (const [key, presence] of this.presences)
      if (presence.sessionId === this.sessionId) this.removePresence(key);
  }
  private startHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    let pending = false;
    this.heartbeat = setInterval(() => {
      if (pending || !this.tracked) return;
      pending = true;
      const tracked = this.tracked;
      const generation = this.generation;
      void this.enqueue(() => {
        if (this.tracked !== tracked)
          return Promise.resolve<Result<WriteReceipt>>({
            data: null,
            error: new NostrbaseError("ABORTED", "Presence tracking stopped."),
          });
        return this.publishRealtime(
          { type: "presence", state: tracked.state },
          generation,
          tracked.pubkey,
        );
      }).then((result) => {
        pending = false;
        if (result.error && this.tracked === tracked) {
          this.status("CHANNEL_ERROR", result.error);
          if (result.error.code === "AUTH_FAILED" || result.error.code === "AUTH_REQUIRED")
            this.stopTracking();
        }
      });
    }, this.heartbeatInterval * 1000);
  }
  private emit(payload: ChangePayload<object>): void {
    for (const listener of this.listeners) {
      if (
        listener.filter.table !== payload.table ||
        (listener.filter.event &&
          listener.filter.event !== "*" &&
          listener.filter.event !== payload.eventType)
      )
        continue;
      const row = payload.new ?? payload.old;
      if (listener.filter.author && row?._nostr.pubkey !== listener.filter.author) continue;
      if (
        !(payload.new && matches(payload.new, listener.predicates)) &&
        !(payload.old && matches(payload.old, listener.predicates))
      )
        continue;
      try {
        listener.callback(structuredClone(payload));
      } catch (error) {
        this.status("CHANNEL_ERROR", asError(error, "INVALID_QUERY"));
      }
    }
  }
  private process(event: NostrEvent): void {
    if (!verify(event)) return;
    if (event.kind === 5) {
      for (const [address, previous] of this.rows) {
        if (event.pubkey !== previous.event.pubkey || event.created_at < previous.event.created_at)
          continue;
        if (
          !event.tags.some(
            (tag) =>
              (tag[0] === "a" && tag[1] === address) ||
              (tag[0] === "e" && tag[1] === previous.event.id),
          )
        )
          continue;
        const latest = this.client.eventStore.getReplaceable(
          RECORD_KIND,
          previous.event.pubkey,
          previous.event.tags.find((tag) => tag[0] === "d")?.[1],
        );
        if (latest && compareEvents(latest, previous.event) > 0 && !this.client.isDeleted(latest))
          continue;
        this.rows.delete(address);
        this.emit({
          eventType: "DELETE",
          table: previous.table,
          new: null,
          old: previous.row,
          event,
        });
      }
      return;
    }
    if (event.kind !== RECORD_KIND) return;
    // The shared store applies NIP-01 replacement and NIP-09 deletion rules.
    const latest = this.client.eventStore.getReplaceable(
      RECORD_KIND,
      event.pubkey,
      event.tags.find((tag) => tag[0] === "d")?.[1],
    );
    if (latest?.id !== event.id || this.client.isDeleted(event)) return;
    for (const table of new Set(this.listeners.map((listener) => listener.filter.table))) {
      const row = decodeRecord(event, this.client.namespace, table, this.client.definition(table));
      if (!row) continue;
      const address = addressOf(event);
      const previous = this.rows.get(address);
      if (
        previous?.event.id === event.id ||
        (previous && compareEvents(event, previous.event) <= 0)
      )
        continue;
      this.rows.set(address, { table, row, event });
      this.emit({
        eventType: previous ? "UPDATE" : "INSERT",
        table,
        new: row,
        old: previous?.row ?? null,
        event,
      });
    }
  }
  /** Initial cached/relay records are delivered as INSERT. SUBSCRIBED means handlers are installed. */
  subscribe(callback?: (status: ChannelStatus, error?: NostrbaseError) => void): this {
    this.client.assertOpen();
    if (this.subscription) return this;
    this.statusCallback = callback;
    const subscription = new Subscription();
    this.subscription = subscription;
    this.controller = new AbortController();
    const filters: Filter[] = this.listeners.length
      ? [
          {
            kinds: [RECORD_KIND],
            "#t": [
              ...new Set(
                this.listeners.map((listener) =>
                  scopeTag(this.client.namespace, listener.filter.table),
                ),
              ),
            ],
          },
          { kinds: [5] },
        ]
      : [];
    if (this.listeners.length && this.listeners.every((listener) => listener.filter.author)) {
      const authors = [
        ...new Set(this.listeners.map((listener) => listener.filter.author as string)),
      ];
      for (const filter of filters) filter.authors = authors;
    }
    if (!this.listeners.length || this.broadcastListeners.length || this.presenceListeners.length)
      filters.push({
        kinds: [REALTIME_KIND],
        "#t": [realtimeTag(this.client.namespace, this.name)],
      });
    subscription.add(this.client.ingested$.subscribe((event) => this.process(event)));
    subscription.add(
      this.client.auth.onAuthStateChange((_event, session) => {
        if (this.tracked && this.tracked.pubkey !== session?.user.pubkey) this.stopTracking();
      }).data.subscription,
    );
    this.expiry = setInterval(() => this.expirePresence(), 1000);
    subscription.add(() => {
      this.generation++;
      this.controller?.abort();
      this.stopTracking();
      if (this.expiry) clearInterval(this.expiry);
      this.expiry = undefined;
      this.presences.clear();
      this.seen.clear();
      this.versions.clear();
    });
    this.status("SUBSCRIBED");
    if (subscription.closed) return this;
    if (this.listeners.length) {
      void this.client
        .ready()
        .then(() => {
          if (subscription.closed) return;
          for (const event of this.client.eventStore.getByFilters(filters[0] as Filter)) {
            if (subscription.closed) break;
            this.process(event);
          }
        })
        .catch((error) => {
          if (subscription.closed) return;
          this.status("CHANNEL_ERROR", asError(error));
          this.unsubscribe();
        });
    }
    if (subscription.closed) return this;
    subscription.add(
      this.client.transport.subscribe(this.client.relays, filters).subscribe({
        next: (event) => {
          if (!verify(event) || !matchFilters(filters, event)) return;
          if (event.kind === REALTIME_KIND) {
            this.processRealtime(event);
            return;
          }
          this.client.ingest(event);
          this.process(event);
        },
        error: (error) => {
          this.status("CHANNEL_ERROR", asError(error));
          this.unsubscribe();
        },
        complete: () => this.unsubscribe(),
      }),
    );
    return this;
  }
  unsubscribe(): void {
    if (!this.subscription) return;
    this.subscription.unsubscribe();
    this.subscription = undefined;
    this.rows.clear();
    this.status("CLOSED");
  }
}
