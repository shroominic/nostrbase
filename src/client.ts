import { EventStore } from "applesauce-core";
import { RelayPool } from "applesauce-relay";
import { matchFilters } from "nostr-tools";
import { Subject, Subscription } from "rxjs";
import { NostrbaseAuth } from "./auth";
import { NostrbaseBackup } from "./backup";
import type { ChannelOptions } from "./channel";
import { NostrbaseChannel } from "./channel";
import { NostrbaseDashboard } from "./dashboard";
import { NostrbaseDiagnostics } from "./diagnostics";
import { asError, NostrbaseError } from "./errors";
import { NostrbaseEvents } from "./events";
import { NostrbaseGroups } from "./groups";
import { NostrbaseMigrations } from "./migrations";
import { NostrbaseOffline } from "./offline";
import { NostrbasePersistence } from "./persistence";
import { NostrbasePrivateTables } from "./private";
import {
  addressOf,
  decodeRecord,
  deletionTemplate,
  encodeRecord,
  isObject,
  RECORD_KIND,
  recordIdentifier,
  rowData,
  scopeTag,
  verify,
} from "./protocol";
import type { QueryHost, QueryState } from "./query";
import { applyQuery, countMatches, nextCursor, parseCursor, QueryBuilder } from "./query";
import { NostrbaseRelations } from "./relations";
import { NostrbaseStorage } from "./storage";
import { NostrbaseSync } from "./sync";
import { ApplesauceTransport } from "./transport";
import type {
  ClientOptions,
  DefaultSchema,
  EventTemplate,
  Filter,
  NostrEvent,
  Result,
  ResultMeta,
  Row,
  SchemaShape,
  TableDefinition,
  Transport,
  TransportRead,
  WriteReceipt,
} from "./types";

export class NostrbaseClient<DB extends SchemaShape<DB> = DefaultSchema> implements QueryHost {
  readonly auth: NostrbaseAuth;
  readonly pool: RelayPool;
  readonly eventStore: EventStore;
  readonly transport: Transport;
  readonly events: NostrbaseEvents;
  readonly diagnostics: NostrbaseDiagnostics;
  readonly persistence?: NostrbasePersistence;
  readonly offline: NostrbaseOffline;
  readonly sync: NostrbaseSync;
  readonly private: NostrbasePrivateTables<DB>;
  readonly groups: NostrbaseGroups<DB>;
  readonly storage: NostrbaseStorage<DB>;
  readonly backup: NostrbaseBackup;
  readonly relations: NostrbaseRelations<DB>;
  readonly migrations: NostrbaseMigrations<DB>;
  readonly dashboard: NostrbaseDashboard;
  private ingestion = new Subject<NostrEvent>();
  readonly ingested$ = this.ingestion.asObservable();
  private observers = new Subscription();
  readonly namespace: string;
  readonly relays: string[];
  readonly timeout: number;
  readonly minWriteAcks: number;
  private options: ClientOptions<DB>;
  private ownedPool: boolean;
  private ownedStore: boolean;
  private controller = new AbortController();
  private writeQueue: Promise<void> = Promise.resolve();
  private channels = new Set<NostrbaseChannel<DB>>();
  private eventSubscriptions = new Set<() => void>();
  private timestamps = new Map<string, number>();
  private deletedAddresses = new Map<string, number>();
  private deletedIds = new Map<string, number>();
  private history = new Map<string, NostrEvent>();
  private closing?: Promise<void>;
  constructor(options: ClientOptions<DB>) {
    if (
      !options ||
      typeof options.namespace !== "string" ||
      !options.namespace.trim() ||
      options.namespace.length > 256
    )
      throw new NostrbaseError(
        "INVALID_CONFIG",
        "Set a stable namespace with 1 to 256 characters.",
      );
    if (!Array.isArray(options.relays) || !options.relays.length)
      throw new NostrbaseError("INVALID_CONFIG", "Configure at least one relay.");
    this.relays = [
      ...new Set(
        options.relays.map((url) => {
          try {
            const parsed = new URL(url);
            if (
              !["wss:", "ws:"].includes(parsed.protocol) ||
              parsed.username ||
              parsed.password ||
              parsed.hash
            )
              throw new Error();
            return parsed.toString();
          } catch {
            throw new NostrbaseError("INVALID_CONFIG", `Invalid relay URL: ${url}`);
          }
        }),
      ),
    ];
    this.timeout = options.timeout ?? 10000;
    this.minWriteAcks = options.minWriteAcks ?? 1;
    if (
      !Number.isSafeInteger(this.timeout) ||
      this.timeout <= 0 ||
      !Number.isSafeInteger(this.minWriteAcks) ||
      this.minWriteAcks < 1 ||
      this.minWriteAcks > this.relays.length
    )
      throw new NostrbaseError("INVALID_CONFIG", "Check timeout and minWriteAcks.");
    this.namespace = options.namespace;
    this.options = options;
    this.ownedPool = !options.pool;
    this.ownedStore = !options.eventStore;
    this.pool = options.pool ?? new RelayPool(options.relayOptions);
    this.eventStore = options.eventStore ?? new EventStore();
    this.transport = options.transport ?? new ApplesauceTransport(this.pool);
    this.auth = new NostrbaseAuth(options.signer);
    this.diagnostics = new NostrbaseDiagnostics(options.diagnostics);
    const watch = (relay: ReturnType<RelayPool["relay"]>) => {
      this.observers.add(
        relay.connected$.subscribe((connected) =>
          this.diagnostics.record("connection", "relay", {
            url: new URL(relay.url).origin + new URL(relay.url).pathname,
            connected,
          }),
        ),
      );
    };
    for (const relay of this.pool.relays.values()) watch(relay);
    this.observers.add(this.pool.add$.subscribe(watch));
    this.persistence = options.persistence
      ? new NostrbasePersistence(this, options.persistence)
      : undefined;
    this.offline = new NostrbaseOffline(
      {
        namespace: this.namespace,
        minWriteAcks: this.minWriteAcks,
        auth: this.auth,
        ready: () => this.persistence?.ready() ?? Promise.resolve(),
        assertOpen: () => this.assertOpen(),
        signal: (signal) => this.signal(signal),
        ingest: (event) => this.ingest(event),
        publish: (event, signal) => this.publish(event, signal),
      },
      options.offline,
      this.persistence?.adapter,
    );
    this.sync = new NostrbaseSync(this, options.sync);
    this.private = new NostrbasePrivateTables(this);
    this.groups = new NostrbaseGroups(this, options.groups);
    this.storage = new NostrbaseStorage(this, options.storage);
    this.backup = new NostrbaseBackup(this);
    this.relations = new NostrbaseRelations(this);
    this.migrations = new NostrbaseMigrations(this);
    this.dashboard = new NostrbaseDashboard(this);
    this.events = new NostrbaseEvents(this);
    this.offline.attachAutoReplay(
      {
        auth: this.auth,
        ready: () => this.ready(),
        signal: (signal) => this.signal(signal),
        pending: async (pubkey) =>
          (await this.offline.hasPending(pubkey)) || this.groups.hasReplayPending(),
        flush: (signal) => this.replayQueues(signal),
        watchReconnect: (wake) => {
          const subscriptions = new Subscription();
          if (this.transport instanceof ApplesauceTransport) {
            const pool = this.transport.pool;
            const watchReplay = (relay: ReturnType<RelayPool["relay"]>) => {
              if (!this.relays.includes(new URL(relay.url).toString())) return;
              let previous = false;
              subscriptions.add(
                relay.connected$.subscribe((connected) => {
                  if (connected && !previous) wake();
                  previous = connected;
                }),
              );
            };
            for (const relay of pool.relays.values()) watchReplay(relay);
            subscriptions.add(pool.add$.subscribe(watchReplay));
          }
          return () => subscriptions.unsubscribe();
        },
      },
      options.offline?.autoReplay,
    );
    if (options.sync) this.sync.start();
    void this.ready().catch(() => this.diagnostics.record("error", "hydrate"));
  }
  async ready(): Promise<void> {
    this.assertOpen();
    await this.persistence?.ready();
    await this.offline.ready();
    this.assertOpen();
  }
  private async replayQueues(signal: AbortSignal): Promise<Result<WriteReceipt[]>> {
    const publicResult = await this.offline.flush({ signal });
    const receipts = [...(publicResult.data ?? [])];
    let failure = publicResult.error;
    try {
      if (!signal.aborted && (await this.groups.hasReplayPending())) {
        const groupResult = await this.groups.replayQueued({ signal });
        receipts.push(...(groupResult.data ?? []));
        failure ??= groupResult.error;
      }
    } catch (error) {
      failure ??= asError(error);
    }
    return {
      data: receipts,
      error: failure,
      count: receipts.length,
      meta: {
        relays: receipts.flatMap((receipt) => receipt.relays),
        receipts,
        partial: !!failure || receipts.some((receipt) => receipt.relays.some((relay) => !relay.ok)),
      },
    };
  }
  nextTimestamp(address: string): number {
    return Math.max(Math.floor(Date.now() / 1000), (this.timestamps.get(address) ?? -1) + 1);
  }
  cachedEvents(): NostrEvent[] {
    return structuredClone([
      ...new Map(
        [...this.eventStore.getByFilters({}), ...this.history.values()].map((event) => [
          event.id,
          event,
        ]),
      ).values(),
    ]);
  }
  assertOpen(): void {
    if (this.controller.signal.aborted)
      throw new NostrbaseError("CLIENT_CLOSED", "Client is closed. Create another client.");
  }
  signal(signal?: AbortSignal): AbortSignal {
    this.assertOpen();
    return signal ? AbortSignal.any([this.controller.signal, signal]) : this.controller.signal;
  }
  definition<T extends object>(table: string): TableDefinition<T> | undefined {
    return (this.options.schema as Record<string, TableDefinition<object>> | undefined)?.[table] as
      | TableDefinition<T>
      | undefined;
  }
  assertTable(table: string): void {
    this.assertOpen();
    if (typeof table !== "string" || !table.trim() || table.length > 256)
      throw new NostrbaseError("INVALID_QUERY", "Table name must contain 1 to 256 characters.");
    if (table.startsWith("private:"))
      throw new NostrbaseError(
        "INVALID_QUERY",
        "The private: prefix is reserved for encrypted table routing.",
      );
    if (this.options.schema && !Object.hasOwn(this.options.schema, table))
      throw new NostrbaseError("INVALID_QUERY", `Unknown table: ${table}`);
  }
  from<K extends keyof DB & string>(table: K): QueryBuilder<DB[K]> {
    this.assertTable(table);
    return new QueryBuilder<DB[K]>(this, table);
  }
  async request(filters: Filter[], signal?: AbortSignal): Promise<TransportRead> {
    await this.ready();
    const combined = this.signal(signal);
    if (combined.aborted) throw new NostrbaseError("ABORTED", "Operation was aborted.");
    const result = await this.transport.request(this.relays, filters, {
      timeout: this.timeout,
      signal: combined,
    });
    this.diagnostics.record("request", "read", {
      filters: filters.length,
      received: result.events.length,
      failedRelays: result.relays.filter((relay) => !relay.ok).length,
    });
    if (combined.aborted) throw new NostrbaseError("ABORTED", "Operation was aborted.");
    if (!result.relays.some((relay) => relay.ok))
      throw new NostrbaseError(
        "RELAY_ERROR",
        "Every relay failed to complete the read.",
        result.relays,
      );
    const events = result.events.filter((event) => verify(event) && matchFilters(filters, event));
    for (const event of events) this.ingest(event);
    return { ...result, events };
  }
  ingest(event: NostrEvent): boolean {
    if (!verify(event)) return false;
    if (event.kind >= 20000 && event.kind < 30000) return true;
    // The store must own its signed copy; transports and result callers may mutate theirs.
    event = structuredClone(event);
    const known = this.history.has(event.id);
    this.history.set(event.id, structuredClone(event));
    this.persistence?.record(event);
    try {
      if (event.kind === 5) {
        for (const tag of event.tags) {
          if (tag[0] === "a" && tag[1]?.startsWith(`${RECORD_KIND}:${event.pubkey}:`)) {
            const address = tag[1];
            this.deletedAddresses.set(
              address,
              Math.max(this.deletedAddresses.get(address) ?? -1, event.created_at),
            );
            this.timestamps.set(
              address,
              Math.max(this.timestamps.get(address) ?? -1, event.created_at),
            );
          } else if (tag[0] === "e" && tag[1]) {
            const key = `${event.pubkey}:${tag[1]}`;
            this.deletedIds.set(key, Math.max(this.deletedIds.get(key) ?? -1, event.created_at));
          }
        }
      } else if (event.kind === RECORD_KIND) {
        const address = addressOf(event);
        this.timestamps.set(
          address,
          Math.max(this.timestamps.get(address) ?? -1, event.created_at),
        );
        if (this.isDeleted(event)) return false;
      }
      const added = this.eventStore.add(event) !== null;
      if (added)
        this.diagnostics.record("ingest", "event", { eventId: event.id, kind: event.kind });
      if (!known) this.ingestion.next(structuredClone(event));
      return added;
    } catch {
      return false;
    }
  }
  isDeleted(event: NostrEvent): boolean {
    return (
      (this.deletedAddresses.get(addressOf(event)) ?? -1) >= event.created_at ||
      (this.deletedIds.get(`${event.pubkey}:${event.id}`) ?? -1) >= event.created_at
    );
  }
  async readTable<T extends object>(
    table: string,
    state: QueryState,
    authors = state.authors,
    definition: TableDefinition<T> | undefined = this.definition<T>(table),
  ): Promise<{ rows: Row<T>[]; meta: ResultMeta }> {
    const filter: Filter = { kinds: [RECORD_KIND], "#t": [scopeTag(this.namespace, table)] };
    const cursor = parseCursor(state.page?.cursor);
    if (cursor) {
      if (cursor.namespace !== this.namespace || cursor.table !== table)
        throw new NostrbaseError("INVALID_QUERY", "Cursor belongs to another table or namespace.");
      if (state.count !== "exact") filter.until = cursor.timestamp;
    }
    if (authors) filter.authors = authors;
    const idPredicate = state.predicates.find(
      (predicate) => predicate.field === "id" && (predicate.op === "eq" || predicate.op === "in"),
    );
    if (idPredicate) {
      const ids = idPredicate.op === "eq" ? [idPredicate.value] : idPredicate.value;
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string"))
        throw new NostrbaseError("INVALID_QUERY", "Record ids must be strings.");
      if (!ids.length) return { rows: [], meta: { relays: [], partial: false } };
      filter["#d"] = ids.map((id) => recordIdentifier(this.namespace, table, id as string));
    }
    if (state.local || state.queue) {
      const rows = this.eventStore
        .getByFilters({ ...filter, until: undefined })
        .filter((event) => matchFilters([filter], event) && !this.isDeleted(event))
        .map((event) => decodeRecord<T>(event, this.namespace, table, definition))
        .filter((row): row is Row<T> => row !== null);
      return { rows, meta: { relays: [], partial: false, cached: true } };
    }
    const scopedDeletes: Filter = { kinds: [5], "#t": [scopeTag(this.namespace, table)] };
    if (authors) scopedDeletes.authors = authors;
    const records = await this.request([filter, scopedDeletes], state.signal);
    const relays = [...records.relays];
    // A cursor excludes newer events at the relay. Resolve candidate addresses without
    // that bound so another relay's newer version cannot be replaced by an old page row.
    if (cursor) {
      const identifiers = [
        ...new Set(
          [...records.events, ...this.eventStore.getByFilters({ ...filter, until: undefined })]
            .filter((event) => event.kind === RECORD_KIND && matchFilters([filter], event))
            .map((event) => event.tags.find((tag) => tag[0] === "d")?.[1])
            .filter((id): id is string => !!id),
        ),
      ];
      for (let offset = 0; offset < identifiers.length; offset += 100) {
        const latest = await this.request(
          [{ ...filter, until: undefined, "#d": identifiers.slice(offset, offset + 100) }],
          state.signal,
        );
        relays.push(...latest.relays);
      }
    }
    const candidates = this.eventStore
      .getByFilters({ ...filter, until: undefined })
      .filter((event) => matchFilters([filter], event));
    // Fetch NIP-09 deletes by pointer. Other Nostr clients need not use our namespace tag.
    const addresses = [
      ...new Set([
        ...candidates.map(addressOf),
        ...(authors ?? []).flatMap((author) =>
          (filter["#d"] ?? []).map((identifier) => `${RECORD_KIND}:${author}:${identifier}`),
        ),
      ]),
    ];
    for (let offset = 0; offset < Math.max(candidates.length, addresses.length); offset += 100) {
      const batch = candidates.slice(offset, offset + 100);
      const deletionFilters: Filter[] = [];
      if (addresses.length > offset)
        deletionFilters.push({ kinds: [5], "#a": addresses.slice(offset, offset + 100) });
      if (batch.length) deletionFilters.push({ kinds: [5], "#e": batch.map((event) => event.id) });
      const deletions = await this.request(deletionFilters, state.signal);
      relays.push(...deletions.relays);
    }
    const rows = this.eventStore
      .getByFilters({ ...filter, until: undefined })
      .filter((event) => matchFilters([filter], event) && !this.isDeleted(event))
      .map((event) => decodeRecord<T>(event, this.namespace, table, definition))
      .filter((row): row is Row<T> => row !== null);
    return { rows, meta: { relays, partial: relays.some((relay) => !relay.ok) } };
  }
  async sign(template: EventTemplate, expectedPubkey?: string): Promise<NostrEvent> {
    await this.ready();
    const { signer, session } = await this.auth.requireSigner();
    const revision = this.auth.revision;
    if (expectedPubkey && expectedPubkey !== session.user.pubkey)
      throw new NostrbaseError("AUTH_FAILED", "The active signer changed during the write.");
    const expected = structuredClone(template);
    let event: NostrEvent;
    try {
      event = structuredClone(await signer.signEvent(structuredClone(expected)));
    } catch (error) {
      throw asError(error, "AUTH_FAILED");
    }
    const active = await this.auth.getSession();
    if (
      active.error ||
      !active.data ||
      revision !== this.auth.revision ||
      active.data.user.pubkey !== session.user.pubkey
    )
      throw new NostrbaseError("AUTH_FAILED", "The active signer changed during signing.");
    if (
      event.pubkey !== session.user.pubkey ||
      event.kind !== expected.kind ||
      event.created_at !== expected.created_at ||
      event.content !== expected.content ||
      JSON.stringify(event.tags) !== JSON.stringify(expected.tags) ||
      !verify(event)
    )
      throw new NostrbaseError("AUTH_FAILED", "Signer returned an invalid or altered event.");
    this.assertOpen();
    return event;
  }
  async publish(event: NostrEvent, signal?: AbortSignal): Promise<WriteReceipt> {
    await this.ready();
    const combined = this.signal(signal);
    if (combined.aborted) throw new NostrbaseError("ABORTED", "Operation was aborted.");
    const relays = await this.transport.publish(this.relays, event, {
      timeout: this.timeout,
      signal: combined,
    });
    this.diagnostics.record("publish", "event", {
      eventId: event.id,
      kind: event.kind,
      acknowledged: relays.filter((relay) => relay.ok).length,
      failed: relays.filter((relay) => !relay.ok).length,
    });
    if (relays.some((relay) => relay.ok)) this.ingest(event);
    return { id: event.id, eventId: event.id, relays };
  }
  private async writeLock<T>(callback: () => Promise<T>): Promise<T> {
    const previous = this.writeQueue;
    let release: () => void = () => {};
    this.writeQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      this.assertOpen();
      return await callback();
    } finally {
      release();
    }
  }
  /** Execute the query only within a stored private Marmot group. */
  async executeInGroup<T extends object>(
    groupId: string,
    table: string,
    state: QueryState,
  ): Promise<Result<Row<T>[]>> {
    try {
      this.assertOpen();
      this.assertTable(table);
      if (state.validationError) throw state.validationError;
      if (state.groupId !== undefined && state.groupId !== groupId)
        throw new NostrbaseError("INVALID_QUERY", "Query has conflicting group scopes.");
      const signal = this.signal(state.signal);
      if (signal.aborted) throw new NostrbaseError("ABORTED", "Operation was aborted.");
      const group = await this.groups.get(groupId);
      if (signal.aborted) throw new NostrbaseError("ABORTED", "Operation was aborted.");
      if (group.error) return { data: null, error: group.error, meta: group.meta };
      if (!group.data)
        throw new NostrbaseError("NOT_FOUND", "Private group is not stored on this device.");
      return await group.data.execute<T>(table, { ...state, groupId });
    } catch (error) {
      return { data: null, error: asError(error) };
    }
  }
  async execute<T extends object>(table: string, state: QueryState): Promise<Result<Row<T>[]>> {
    if (state.groupId !== undefined) return this.executeInGroup<T>(state.groupId, table, state);
    try {
      await this.ready();
      if (this.signal(state.signal).aborted)
        throw new NostrbaseError("ABORTED", "Operation was aborted.");
      this.sync.registerTable(table);
      if (state.operation === "select") {
        const result = await this.readTable<T>(table, state);
        const rows = applyQuery(result.rows, state);
        return {
          data: state.head ? [] : rows,
          error: null,
          count: state.count === "exact" ? countMatches(result.rows, state) : rows.length,
          meta: { ...result.meta, nextCursor: nextCursor(this.namespace, table, rows, state) },
        };
      }
      return await this.writeLock(() => this.mutate<T>(table, state));
    } catch (error) {
      const converted = asError(error);
      this.diagnostics.record("error", "query", { code: converted.code });
      return { data: null, error: converted };
    }
  }
  private async mutate<T extends object>(
    table: string,
    state: QueryState,
  ): Promise<Result<Row<T>[]>> {
    const committed: Row<T>[] = [];
    const receipts: WriteReceipt[] = [];
    const meta: ResultMeta = { relays: [], partial: false, receipts, queued: !!state.queue };
    try {
      const { session } = await this.auth.requireSigner();
      const pubkey = session.user.pubkey;
      if (state.authors?.some((author) => author !== pubkey))
        throw new NostrbaseError(
          "PERMISSION_DENIED",
          "You can only write records signed by your own key.",
        );
      let writes: { id: string; data: T; previous?: Row<T> }[] = [];
      let targets: Row<T>[] = [];
      if (state.operation === "insert" || state.operation === "upsert") {
        if (!state.values?.length)
          throw new NostrbaseError("INVALID_RECORD", "Insert at least one record.");
        const seen = new Set<string>();
        for (const input of state.values) {
          if (!isObject(input))
            throw new NostrbaseError("INVALID_RECORD", "Record must be an object.");
          const { id: providedId, ...data } = input;
          if (
            providedId !== undefined &&
            (typeof providedId !== "string" || !providedId || providedId.length > 512)
          )
            throw new NostrbaseError(
              "INVALID_RECORD",
              "Record id must contain 1 to 512 characters.",
            );
          const id = (providedId as string | undefined) ?? crypto.randomUUID();
          if (seen.has(id))
            throw new NostrbaseError("CONFLICT", "A write batch cannot contain duplicate ids.");
          seen.add(id);
          // Validate the full batch before its first publish.
          encodeRecord(this.namespace, table, id, data, 0, 0, this.definition(table));
          writes.push({ id, data: data as T });
        }
        const existing = await this.readTable<T>(
          table,
          {
            ...state,
            predicates: [{ field: "id", op: "in", value: writes.map((write) => write.id) }],
          },
          [pubkey],
          {},
        );
        meta.relays.push(...existing.meta.relays);
        for (const write of writes) {
          write.previous = existing.rows.find((row) => row.id === write.id);
          if (state.operation === "insert" && write.previous)
            throw new NostrbaseError(
              "CONFLICT",
              `Record already exists: ${write.id}. Use upsert to replace it.`,
            );
        }
      } else {
        if (!state.predicates.length && !state.allowAll)
          throw new NostrbaseError(
            "INVALID_QUERY",
            "Filter updates and deletes, or call all() to select all your records.",
          );
        const existing = await this.readTable<T>(table, state, [pubkey]);
        meta.relays.push(...existing.meta.relays);
        targets = applyQuery(existing.rows, state);
        if (state.operation === "update") {
          if (!isObject(state.patch) || "id" in state.patch || "_nostr" in state.patch)
            throw new NostrbaseError(
              "INVALID_RECORD",
              "Update data must be an object. id and _nostr cannot be changed.",
            );
          writes = targets.map((previous) => ({
            id: previous.id,
            data: { ...rowData(previous), ...state.patch } as T,
            previous,
          }));
          for (const write of writes)
            encodeRecord(this.namespace, table, write.id, write.data, 0, 0, this.definition(table));
        }
      }
      if (state.operation === "delete") {
        // One deletion event per record gives precise partial-write receipts.
        for (const row of targets) {
          const previous = this.eventStore.getEvent(row._nostr.eventId);
          if (!previous) continue;
          const event = await this.sign(
            deletionTemplate(
              this.namespace,
              table,
              [previous],
              Math.max(Math.floor(Date.now() / 1000), previous.created_at + 1),
            ),
            pubkey,
          );
          const receipt = { ...(await this.submit(event, state)), id: row.id };
          receipts.push(receipt);
          meta.relays.push(...receipt.relays);
          if (receipt.queued || receipt.relays.some((relay) => relay.ok)) committed.push(row);
          if (
            !receipt.queued &&
            receipt.relays.filter((relay) => relay.ok).length < this.minWriteAcks
          )
            throw new NostrbaseError(
              "PUBLISH_FAILED",
              `Deletion of ${row.id} did not meet minWriteAcks.`,
              receipt,
            );
        }
      } else {
        for (const write of writes) {
          const updatedAt = Math.max(
            Math.floor(Date.now() / 1000),
            (write.previous?._nostr.updatedAt ?? -1) + 1,
            (this.timestamps.get(
              `${RECORD_KIND}:${pubkey}:${recordIdentifier(this.namespace, table, write.id)}`,
            ) ?? -1) + 1,
          );
          const event = await this.sign(
            encodeRecord(
              this.namespace,
              table,
              write.id,
              write.data,
              write.previous?._nostr.createdAt ?? updatedAt,
              updatedAt,
              this.definition(table),
            ),
            pubkey,
          );
          const receipt = { ...(await this.submit(event, state)), id: write.id };
          receipts.push(receipt);
          meta.relays.push(...receipt.relays);
          if (receipt.queued || receipt.relays.some((relay) => relay.ok)) {
            const row = decodeRecord<T>(event, this.namespace, table, this.definition(table));
            if (row) committed.push(row);
          }
          if (
            !receipt.queued &&
            receipt.relays.filter((relay) => relay.ok).length < this.minWriteAcks
          )
            throw new NostrbaseError(
              "PUBLISH_FAILED",
              `Write of ${write.id} did not meet minWriteAcks.`,
              receipt,
            );
        }
      }
      meta.partial = meta.relays.some((relay) => !relay.ok);
      return {
        data: state.returning ? committed : null,
        error: null,
        count: committed.length,
        meta,
      };
    } catch (error) {
      meta.partial = committed.length > 0 || meta.relays.some((relay) => !relay.ok);
      return {
        data: state.returning ? committed : null,
        error: asError(error),
        count: committed.length,
        meta,
      };
    }
  }
  private async submit(event: NostrEvent, state: QueryState): Promise<WriteReceipt> {
    if (!state.queue) return this.publish(event, state.signal);
    if (this.signal(state.signal).aborted)
      throw new NostrbaseError("ABORTED", "Operation was aborted.");
    const result = await this.offline.enqueueSigned(event);
    if (result.error) throw result.error;
    if (!result.data) throw new NostrbaseError("PUBLISH_FAILED", "Queue did not return a receipt.");
    this.diagnostics.record("queue", "enqueue", { eventId: event.id, kind: event.kind });
    return result.data;
  }
  channel(name: string, options?: ChannelOptions): NostrbaseChannel<DB> {
    this.assertOpen();
    const channel = new NostrbaseChannel(this, name, options);
    this.channels.add(channel);
    return channel;
  }
  async removeChannel(channel: NostrbaseChannel<DB>): Promise<void> {
    channel.unsubscribe();
    this.channels.delete(channel);
  }
  async removeAllChannels(): Promise<void> {
    for (const channel of this.channels) channel.unsubscribe();
    this.channels.clear();
  }
  trackEventSubscription(dispose: () => void): () => void {
    this.eventSubscriptions.add(dispose);
    return () => this.eventSubscriptions.delete(dispose);
  }
  close(): void {
    if (this.controller.signal.aborted) return;
    this.offline.stopAutoReplay();
    this.controller.abort();
    this.observers.unsubscribe();
    this.sync.close();
    this.private.close();
    this.groups.close();
    for (const channel of this.channels) channel.unsubscribe();
    this.channels.clear();
    for (const dispose of this.eventSubscriptions) dispose();
    this.eventSubscriptions.clear();
    this.auth.dispose();
    this.closing = this.offline
      .close()
      .then(() => this.groups.closeAsync())
      .then(() => this.persistence?.close())
      .then(() => {});
    void this.closing.catch(() => this.diagnostics.record("error", "close"));
    if (this.ownedPool) this.pool.close();
    if (this.ownedStore) this.eventStore.dispose();
    this.ingestion.complete();
  }
  async closeAsync(): Promise<void> {
    this.close();
    await this.closing;
    this.diagnostics.close();
  }
  [Symbol.dispose](): void {
    this.close();
  }
}
export function createClient<DB extends SchemaShape<DB> = DefaultSchema>(
  options: ClientOptions<DB>,
): NostrbaseClient<DB> {
  return new NostrbaseClient(options);
}
