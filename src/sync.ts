import type { EventStore } from "applesauce-core";
import type { RelayPool } from "applesauce-relay";
import { matchFilters } from "nostr-tools";
import { Subscription } from "rxjs";
import { asError, NostrbaseError } from "./errors";
import { addressOf, RECORD_KIND, scopeTag, verify } from "./protocol";
import type { Filter, NostrEvent, RelayResult, Result, ResultMeta, Transport } from "./types";

export interface SyncOptions {
  tables?: readonly string[];
  initial?: boolean;
  reconnect?: boolean;
  timeout?: number;
  onError?: (error: NostrbaseError) => void;
}
export interface SyncPullOptions {
  signal?: AbortSignal;
  relays?: readonly string[];
  /** Disable reconciliation and request normal events directly. */
  strategy?: "auto" | "query";
}
export interface SyncRelayResult extends RelayResult {
  strategy: "negentropy" | "query" | "mixed";
  fallbackReason?: string;
  received: number;
}
export interface SyncMeta extends ResultMeta {
  sync: SyncRelayResult[];
}
export interface SyncResult extends Result<NostrEvent[]> {
  meta?: SyncMeta;
}
interface SyncHost {
  namespace: string;
  relays: string[];
  pool: RelayPool;
  eventStore: EventStore;
  transport: Transport;
  timeout: number;
  ready(): Promise<void>;
  assertOpen(): void;
  signal(signal?: AbortSignal): AbortSignal;
  ingest(event: NostrEvent): boolean;
}
/** Pull-only reconciliation. Cached events belonging to other authors are never published. */
export class NostrbaseSync {
  private tables = new Set<string>();
  private subscriptions = new Subscription();
  private lifetime = new AbortController();
  private started = false;
  private timeout: number;
  private background = new Set<string>();
  constructor(
    private host: SyncHost,
    private options: SyncOptions = {},
  ) {
    this.timeout = options.timeout ?? host.timeout;
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 1)
      throw new NostrbaseError("INVALID_CONFIG", "sync.timeout must be a positive integer.");
    for (const table of options.tables ?? []) this.registerTable(table);
  }
  registerTable(table: string, initial = true): void {
    if (
      typeof table !== "string" ||
      !table.trim() ||
      table.length > (table.startsWith("private:") ? 264 : 256)
    )
      throw new NostrbaseError("INVALID_QUERY", "Sync table name is invalid or too long.");
    const added = !this.tables.has(table);
    this.tables.add(table);
    if (added && initial && this.started && this.options.initial)
      this.runBackground(`initial:${table}`, this.tableFilters(table));
  }
  private tableFilters(table: string): Filter[] {
    return [
      { kinds: [RECORD_KIND], "#t": [scopeTag(this.host.namespace, table)] },
      { kinds: [5], "#t": [scopeTag(this.host.namespace, table)] },
    ];
  }
  async table(table: string, options: SyncPullOptions = {}): Promise<SyncResult> {
    this.registerTable(table, false);
    return this.pull(this.tableFilters(table), options);
  }
  private async bounded<T>(
    run: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    const timeout = new AbortController();
    const combined = AbortSignal.any([signal, timeout.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let aborted: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      aborted = () =>
        reject(
          new NostrbaseError(
            signal.aborted ? "ABORTED" : "RELAY_ERROR",
            signal.aborted
              ? "Sync was aborted."
              : "Negentropy timed out; query recovery is required.",
          ),
        );
      combined.addEventListener("abort", aborted, { once: true });
      timer = setTimeout(() => timeout.abort(), this.timeout);
      if (combined.aborted) aborted();
    });
    try {
      return await Promise.race([run(combined), cancelled]);
    } finally {
      clearTimeout(timer);
      if (aborted) combined.removeEventListener("abort", aborted);
    }
  }
  async pull(input?: Filter | Filter[], options: SyncPullOptions = {}): Promise<SyncResult> {
    const received = new Map<string, NostrEvent>();
    const statuses: SyncRelayResult[] = [];
    try {
      this.host.assertOpen();
      await this.host.ready();
      const signal = AbortSignal.any([this.host.signal(options.signal), this.lifetime.signal]);
      if (signal.aborted) throw new NostrbaseError("ABORTED", "Sync was aborted.");
      const filters = structuredClone(
        input
          ? Array.isArray(input)
            ? input
            : [input]
          : [...this.tables].flatMap((table) => this.tableFilters(table)),
      );
      if (!filters.length)
        throw new NostrbaseError(
          "INVALID_QUERY",
          "Set sync.tables, use a table, or supply explicit sync filters.",
        );
      if (filters.some((filter) => !filter || typeof filter !== "object" || Array.isArray(filter)))
        throw new NostrbaseError("INVALID_QUERY", "Sync filters must be Nostr filter objects.");
      const relays = [...new Set(options.relays ?? this.host.relays)];
      if (!relays.length || relays.some((relay) => !this.host.relays.includes(relay)))
        throw new NostrbaseError(
          "INVALID_QUERY",
          "Sync relay URLs must be configured on the client.",
        );
      const accept = (events: NostrEvent[], filter: Filter[], scopeSignal: AbortSignal) => {
        if (scopeSignal.aborted) return;
        for (const event of events) {
          if (verify(event) && matchFilters(filter, event)) {
            this.host.ingest(event);
            received.set(event.id, event);
          }
        }
      };
      const request = async (url: string, filter: Filter[], scopeSignal: AbortSignal) => {
        if (scopeSignal.aborted) throw new NostrbaseError("ABORTED", "Sync was aborted.");
        const response = await this.host.transport.request([url], filter, {
          timeout: this.timeout,
          signal: scopeSignal,
        });
        if (scopeSignal.aborted) throw new NostrbaseError("ABORTED", "Sync was aborted.");
        if (!response.relays.some((status) => status.url === url && status.ok))
          throw new NostrbaseError(
            "RELAY_ERROR",
            "Relay failed to complete sync query.",
            response.relays,
          );
        return response.events;
      };
      await Promise.all(
        relays.map(async (url) => {
          let strategy: SyncRelayResult["strategy"] =
            options.strategy === "query" ? "query" : "negentropy";
          let usedNegentropy = false;
          let usedQuery = false;
          let fallbackReason: string | undefined;
          let count = 0;
          const record = (events: NostrEvent[], filter: Filter[], scopeSignal: AbortSignal) => {
            const verified = events.filter((event) => verify(event) && matchFilters(filter, event));
            count += verified.length;
            accept(verified, filter, scopeSignal);
          };
          try {
            for (const filter of filters) {
              if (options.strategy !== "query") {
                try {
                  await this.bounded(async (scopeSignal) => {
                    // Pass a filtered vector. Arrays supplied to Applesauce are not filtered internally.
                    const local = this.host.eventStore
                      .getByFilters(filter)
                      .filter((event) => verify(event));
                    const complete = await this.host.pool.relay(url).negentropy(
                      local,
                      filter,
                      async (_have, need) => {
                        // Do not push _have: relay reconciliation does not grant write authority.
                        for (let offset = 0; offset < need.length; offset += 100) {
                          const ids = need.slice(offset, offset + 100);
                          const events = await request(url, [{ ids }], scopeSignal);
                          const matching = events.filter(
                            (event) =>
                              ids.includes(event.id) &&
                              verify(event) &&
                              matchFilters([filter], event),
                          );
                          record(matching, [filter], scopeSignal);
                          if (ids.some((id) => !matching.some((event) => event.id === id)))
                            throw new NostrbaseError(
                              "RELAY_ERROR",
                              "Relay did not return every reconciled event.",
                            );
                        }
                      },
                      { signal: scopeSignal },
                    );
                    if (!complete || scopeSignal.aborted)
                      throw new NostrbaseError("RELAY_ERROR", "Negentropy did not complete.");
                  }, signal);
                  usedNegentropy = true;
                  strategy = usedQuery ? "mixed" : "negentropy";
                  continue;
                } catch (error) {
                  if (signal.aborted) throw new NostrbaseError("ABORTED", "Sync was aborted.");
                  strategy = usedNegentropy ? "mixed" : "query";
                  fallbackReason = error instanceof Error ? error.message : String(error);
                }
              }
              usedQuery = true;
              const events = await request(url, [filter], signal);
              record(events, [filter], signal);
            }
            // NIP-09 clients need not add our namespace tag. Recover deletes by record pointers.
            const candidates = this.host.eventStore
              .getByFilters(filters)
              .filter((event) => event.kind === RECORD_KIND);
            for (let offset = 0; offset < candidates.length; offset += 100) {
              const batch = candidates.slice(offset, offset + 100);
              const deletionFilters: Filter[] = [
                { kinds: [5], "#a": [...new Set(batch.map(addressOf))] },
                { kinds: [5], "#e": batch.map((event) => event.id) },
              ];
              record(await request(url, deletionFilters, signal), deletionFilters, signal);
            }
            statuses.push({ url, ok: true, strategy, fallbackReason, received: count });
          } catch (error) {
            statuses.push({
              url,
              ok: false,
              strategy,
              fallbackReason,
              received: count,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }),
      );
      if (signal.aborted) throw new NostrbaseError("ABORTED", "Sync was aborted.");
      const meta: SyncMeta = {
        relays: statuses,
        sync: statuses,
        partial: statuses.some((status) => !status.ok),
      };
      if (!statuses.some((status) => status.ok))
        return {
          data: [...received.values()],
          error: new NostrbaseError(
            "RELAY_ERROR",
            "Every relay failed to complete synchronization.",
            statuses,
          ),
          meta,
        };
      return { data: [...received.values()], error: null, count: received.size, meta };
    } catch (error) {
      return {
        data: [...received.values()],
        error: asError(error),
        count: received.size,
        meta: { relays: statuses, sync: statuses, partial: true },
      };
    }
  }
  private report(error: NostrbaseError): void {
    try {
      this.options.onError?.(error);
    } catch {
      /* Observer isolation. */
    }
  }
  private runBackground(key: string, filters?: Filter[], relays?: string[]): void {
    if (this.lifetime.signal.aborted || this.background.has(key)) return;
    this.background.add(key);
    void this.pull(filters, { relays })
      .then((result) => {
        if (result.error && result.error.code !== "ABORTED") this.report(result.error);
      })
      .catch((error) => this.report(asError(error)))
      .finally(() => this.background.delete(key));
  }
  /** Opt-in startup/reconnect recovery. This does not replace live subscriptions. */
  start(): void {
    if (this.started || this.lifetime.signal.aborted) return;
    this.started = true;
    if (this.options.initial && this.tables.size) this.runBackground("initial");
    if (this.options.reconnect) {
      for (const url of this.host.relays) {
        let connectedOnce = false;
        let disconnected = false;
        this.subscriptions.add(
          this.host.pool.relay(url).connected$.subscribe((connected) => {
            if (!connected) {
              if (connectedOnce) disconnected = true;
              return;
            }
            if (connectedOnce && disconnected && this.tables.size)
              this.runBackground(`reconnect:${url}`, undefined, [url]);
            connectedOnce = true;
            disconnected = false;
          }),
        );
      }
    }
  }
  close(): void {
    this.lifetime.abort();
    this.subscriptions.unsubscribe();
  }
}
