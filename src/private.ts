import { matchFilters } from "nostr-tools";
import { merge, Subscription } from "rxjs";
import type { NostrbaseClient } from "./client";
import { asError, NostrbaseError } from "./errors";
import {
  addressOf,
  compareEvents,
  decodeRecord,
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
import type {
  ChangePayload,
  Filter,
  NostrEvent,
  Result,
  ResultMeta,
  Row,
  SchemaShape,
  Signer,
  WriteReceipt,
} from "./types";

const encryptedTable = (table: string): string => `private:${table}`;

/** Personal tables: ciphertext is public, plaintext is available only to its author. */
export class NostrbasePrivateTables<DB extends SchemaShape<DB>> implements QueryHost {
  private writeQueue: Promise<void> = Promise.resolve();
  private subscriptions = new Set<() => void>();
  constructor(private host: NostrbaseClient<DB>) {}
  from<K extends keyof DB & string>(table: K): QueryBuilder<DB[K]> {
    this.host.assertTable(table);
    return new QueryBuilder<DB[K]>(this, table);
  }
  private async identity(): Promise<{
    signer: Signer & { nip44: NonNullable<Signer["nip44"]> };
    pubkey: string;
  }> {
    const { signer, session } = await this.host.auth.requireSigner();
    if (!signer.nip44)
      throw new NostrbaseError(
        "AUTH_FAILED",
        "Private tables require a signer with NIP-44 encryption.",
      );
    return {
      signer: signer as Signer & { nip44: NonNullable<Signer["nip44"]> },
      pubkey: session.user.pubkey,
    };
  }
  private async checkIdentity(pubkey: string): Promise<void> {
    const active = await this.host.auth.requireSigner();
    if (active.session.user.pubkey !== pubkey)
      throw new NostrbaseError(
        "AUTH_FAILED",
        "The active signer changed during the private operation.",
      );
    this.host.assertOpen();
  }
  private filter(table: string, pubkey: string): Filter {
    return {
      kinds: [RECORD_KIND],
      authors: [pubkey],
      "#t": [scopeTag(this.host.namespace, encryptedTable(table))],
    };
  }
  private isCurrent(event: NostrEvent): boolean {
    if (this.host.isDeleted(event)) return false;
    const identifier = event.tags.find((tag) => tag[0] === "d")?.[1];
    const latest = this.host.eventStore.getReplaceable(event.kind, event.pubkey, identifier);
    return !latest || compareEvents(event, latest) >= 0;
  }
  async decode<T extends object>(event: NostrEvent, table: string): Promise<Row<T> | null> {
    const { signer, pubkey } = await this.identity();
    if (
      !verify(event) ||
      event.pubkey !== pubkey ||
      event.kind !== RECORD_KIND ||
      this.host.isDeleted(event)
    )
      return null;
    const route = encryptedTable(table);
    if (
      event.tags.filter((tag) => tag[0] === "d").length !== 1 ||
      event.tags.filter((tag) => tag[0] === "t").length !== 1 ||
      !event.tags.some(
        (tag) => tag[0] === "t" && tag[1] === scopeTag(this.host.namespace, route),
      ) ||
      event.tags.filter((tag) => tag[0] === "encryption").length !== 1 ||
      !event.tags.some((tag) => tag[0] === "encryption" && tag[1] === "nip44-self")
    )
      return null;
    let content: string;
    try {
      content = await signer.nip44.decrypt(pubkey, event.content);
    } catch {
      return null;
    }
    await this.checkIdentity(pubkey);
    if (this.host.isDeleted(event)) return null;
    try {
      const record: unknown = JSON.parse(content);
      if (
        !isObject(record) ||
        typeof record.id !== "string" ||
        event.tags.find((tag) => tag[0] === "d")?.[1] !==
          recordIdentifier(this.host.namespace, route, record.id)
      )
        return null;
      // Decode a temporary object only. It is never added to the event store or logs.
      return decodeRecord<T>(
        {
          ...event,
          content,
          tags: [
            ["d", recordIdentifier(this.host.namespace, table, record.id)],
            ["t", scopeTag(this.host.namespace, table)],
          ],
        },
        this.host.namespace,
        table,
        this.host.definition(table),
      );
    } catch {
      return null;
    }
  }
  private async read<T extends object>(
    table: string,
    state: QueryState,
    pubkey: string,
  ): Promise<{ rows: Row<T>[]; meta: ResultMeta }> {
    const filter = this.filter(table, pubkey);
    const cursor = parseCursor(state.page?.cursor);
    if (cursor && (cursor.namespace !== this.host.namespace || cursor.table !== table))
      throw new NostrbaseError("INVALID_QUERY", "Cursor belongs to another table or namespace.");
    const relayFilter =
      cursor && state.count !== "exact" ? { ...filter, until: cursor.timestamp } : filter;
    const relays: ResultMeta["relays"] = [];
    if (!state.queue && !state.local) {
      const response = await this.host.request(
        [
          relayFilter,
          {
            kinds: [5],
            authors: [pubkey],
            "#t": [scopeTag(this.host.namespace, encryptedTable(table))],
          },
        ],
        state.signal,
      );
      relays.push(...response.relays);
      const boundedCandidates = this.host.eventStore.getByFilters(filter);
      // `until` may return an old version of a record whose latest version is
      // newer than the cursor. Resolve each candidate address without time bounds.
      if (cursor) {
        for (let offset = 0; offset < boundedCandidates.length; offset += 100) {
          const identifiers = boundedCandidates
            .slice(offset, offset + 100)
            .map((event) => event.tags.find((tag) => tag[0] === "d")?.[1])
            .filter((value): value is string => !!value);
          if (!identifiers.length) continue;
          const latest = await this.host.request(
            [{ kinds: [RECORD_KIND], authors: [pubkey], "#d": [...new Set(identifiers)] }],
            state.signal,
          );
          relays.push(...latest.relays);
        }
      }
      const candidates = this.host.eventStore.getByFilters(filter);
      for (let offset = 0; offset < candidates.length; offset += 100) {
        const batch = candidates.slice(offset, offset + 100);
        const deletes = await this.host.request(
          [
            { kinds: [5], authors: [pubkey], "#a": batch.map(addressOf) },
            { kinds: [5], authors: [pubkey], "#e": batch.map((event) => event.id) },
          ],
          state.signal,
        );
        relays.push(...deletes.relays);
      }
    }
    const rows: Row<T>[] = [];
    const signal = this.host.signal(state.signal);
    for (const event of this.host.eventStore.getByFilters(filter)) {
      if (!matchFilters([filter], event)) continue;
      if (signal.aborted) throw new NostrbaseError("ABORTED", "Private operation was aborted.");
      const row = await this.decode<T>(event, table);
      if (row && this.isCurrent(event)) rows.push(row);
    }
    await this.checkIdentity(pubkey);
    if (signal.aborted) throw new NostrbaseError("ABORTED", "Private operation was aborted.");
    return {
      rows,
      meta: { relays, partial: relays.some((relay) => !relay.ok), cached: !!state.local },
    };
  }
  async execute<T extends object>(table: string, state: QueryState): Promise<Result<Row<T>[]>> {
    try {
      if (state.groupId !== undefined)
        throw new NostrbaseError("INVALID_QUERY", "Use client.from(table).inGroup(id) for groups.");
      await this.host.ready();
      this.host.assertOpen();
      if (this.host.signal(state.signal).aborted)
        throw new NostrbaseError("ABORTED", "Private operation was aborted.");
      const { pubkey } = await this.identity();
      this.host.sync.registerTable(encryptedTable(table));
      if (state.authors?.some((author) => author !== pubkey))
        throw new NostrbaseError(
          "PERMISSION_DENIED",
          "Personal private tables can only use the active author's records.",
        );
      if (state.operation === "select") {
        const result = await this.read<T>(table, state, pubkey);
        const rows = applyQuery(result.rows, state);
        return {
          data: state.head ? [] : rows,
          error: null,
          count: state.count === "exact" ? countMatches(result.rows, state) : rows.length,
          meta: { ...result.meta, nextCursor: nextCursor(this.host.namespace, table, rows, state) },
        };
      }
      const previous = this.writeQueue;
      let release: () => void = () => {};
      this.writeQueue = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await this.mutate<T>(table, state, pubkey);
      } finally {
        release();
      }
    } catch (error) {
      return { data: null, error: asError(error) };
    }
  }
  private async mutate<T extends object>(
    table: string,
    state: QueryState,
    pubkey: string,
  ): Promise<Result<Row<T>[]>> {
    const committed: Row<T>[] = [];
    const receipts: WriteReceipt[] = [];
    const meta: ResultMeta = { relays: [], partial: false, receipts };
    try {
      await this.checkIdentity(pubkey);
      const { signer } = await this.identity();
      const existing = await this.read<T>(table, state, pubkey);
      meta.relays.push(...existing.meta.relays);
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
          const id = providedId === undefined ? crypto.randomUUID() : providedId;
          if (typeof id !== "string")
            throw new NostrbaseError("INVALID_RECORD", "Record id must be a string.");
          if (seen.has(id))
            throw new NostrbaseError("CONFLICT", "A write batch cannot contain duplicate ids.");
          seen.add(id);
          encodeRecord(this.host.namespace, table, id, data, 0, 0, this.host.definition(table));
          const previous = existing.rows.find((row) => row.id === id);
          if (previous && state.operation === "insert")
            throw new NostrbaseError("CONFLICT", `Record already exists: ${id}.`);
          writes.push({ id, data: data as T, previous });
        }
      } else {
        if (!state.predicates.length && !state.allowAll)
          throw new NostrbaseError("INVALID_QUERY", "Filter updates and deletes, or call all().");
        targets = applyQuery(existing.rows, state);
        if (state.operation === "update") {
          if (!isObject(state.patch) || "id" in state.patch || "_nostr" in state.patch)
            throw new NostrbaseError("INVALID_RECORD", "Update cannot change id or _nostr.");
          writes = targets.map((previous) => ({
            id: previous.id,
            data: { ...rowData(previous), ...state.patch } as T,
            previous,
          }));
          for (const write of writes)
            encodeRecord(
              this.host.namespace,
              table,
              write.id,
              write.data,
              0,
              0,
              this.host.definition(table),
            );
        }
      }
      const publish = async (event: NostrEvent, id: string): Promise<WriteReceipt> => {
        if (this.host.signal(state.signal).aborted)
          throw new NostrbaseError("ABORTED", "Private operation was aborted.");
        let receipt: WriteReceipt;
        if (state.queue) {
          const queued = await this.host.offline.enqueueSigned(event);
          if (queued.error || !queued.data)
            throw (
              queued.error ?? new NostrbaseError("PUBLISH_FAILED", "Private queue write failed.")
            );
          receipt = queued.data;
          meta.queued = true;
        } else receipt = await this.host.publish(event, state.signal);
        const result = { ...receipt, id };
        receipts.push(result);
        meta.relays.push(...result.relays);
        await this.checkIdentity(pubkey);
        return result;
      };
      const checkReceipt = (receipt: WriteReceipt): void => {
        if (
          !state.queue &&
          receipt.relays.filter((relay) => relay.ok).length < this.host.minWriteAcks
        )
          throw new NostrbaseError(
            "PUBLISH_FAILED",
            `Private write of ${receipt.id} did not meet minWriteAcks.`,
            receipt,
          );
      };
      if (state.operation === "delete") {
        for (const row of targets) {
          const d = recordIdentifier(this.host.namespace, encryptedTable(table), row.id);
          const address = `${RECORD_KIND}:${pubkey}:${d}`;
          const event = await this.host.sign(
            {
              kind: 5,
              created_at: this.host.nextTimestamp(address),
              content: "",
              tags: [
                ["t", scopeTag(this.host.namespace, encryptedTable(table))],
                ["k", String(RECORD_KIND)],
                ["a", address],
                ["e", row._nostr.eventId],
              ],
            },
            pubkey,
          );
          const receipt = await publish(event, row.id);
          if (state.queue || receipt.relays.some((relay) => relay.ok)) committed.push(row);
          checkReceipt(receipt);
        }
      } else {
        for (const write of writes) {
          const route = encryptedTable(table);
          const address = `${RECORD_KIND}:${pubkey}:${recordIdentifier(this.host.namespace, route, write.id)}`;
          const timestamp = this.host.nextTimestamp(address);
          const plain = encodeRecord(
            this.host.namespace,
            table,
            write.id,
            write.data,
            write.previous?._nostr.createdAt ?? timestamp,
            timestamp,
            this.host.definition(table),
          );
          let content: string;
          try {
            content = await signer.nip44.encrypt(pubkey, plain.content);
          } catch {
            throw new NostrbaseError("AUTH_FAILED", "Signer could not encrypt the private record.");
          }
          await this.checkIdentity(pubkey);
          const event = await this.host.sign(
            {
              ...plain,
              content,
              tags: [
                ["d", recordIdentifier(this.host.namespace, route, write.id)],
                ["t", scopeTag(this.host.namespace, route)],
                ["encryption", "nip44-self"],
              ],
            },
            pubkey,
          );
          const receipt = await publish(event, write.id);
          // Use already validated data; avoid a second signer decrypt permission prompt.
          if (state.queue || receipt.relays.some((relay) => relay.ok))
            committed.push({
              ...write.data,
              id: write.id,
              _nostr: {
                pubkey,
                eventId: event.id,
                createdAt: write.previous?._nostr.createdAt ?? timestamp,
                updatedAt: timestamp,
              },
            });
          checkReceipt(receipt);
        }
      }
      await this.checkIdentity(pubkey);
      meta.partial = meta.relays.some((relay) => !relay.ok);
      return {
        data: state.returning ? committed : null,
        error: null,
        count: committed.length,
        meta,
      };
    } catch (error) {
      let failure = asError(error);
      // A publish may complete after sign-out or account change. Preserve ciphertext
      // receipts, but never expose this operation's plaintext to the new session.
      try {
        await this.checkIdentity(pubkey);
      } catch (identityError) {
        committed.length = 0;
        failure = asError(identityError);
      }
      meta.partial =
        receipts.some((receipt) => receipt.queued || receipt.relays.some((relay) => relay.ok)) ||
        meta.relays.some((relay) => !relay.ok);
      return {
        data: state.returning ? committed : null,
        error: failure,
        count: committed.length,
        meta,
      };
    }
  }
  async subscribe<K extends keyof DB & string>(
    table: K,
    callback: (change: ChangePayload<DB[K]>) => void,
    onError?: (error: NostrbaseError) => void,
  ): Promise<{ unsubscribe(): void }> {
    this.from(table);
    await this.host.ready();
    const { pubkey } = await this.identity();
    let closed = false;
    const current = new Map<string, { event: NostrEvent; row: Row<DB[K]> }>();
    const seedEvents = this.host.eventStore.getByFilters(this.filter(table, pubkey));
    let releaseSeed: () => void = () => {};
    let serial = new Promise<void>((resolve) => {
      releaseSeed = resolve;
    });
    const lifetime = new Subscription();
    let untrack: () => void = () => {};
    const reportError = (error: unknown): void => {
      if (closed) return;
      try {
        onError?.(asError(error));
      } catch {
        /* Observer errors cannot stop cleanup or poison the event chain. */
      }
    };
    const unsubscribe = (): void => {
      if (closed) return;
      closed = true;
      lifetime.unsubscribe();
      current.clear();
      this.subscriptions.delete(unsubscribe);
      untrack();
    };
    this.subscriptions.add(unsubscribe);
    untrack = this.host.trackEventSubscription(unsubscribe);
    lifetime.add(
      this.host.auth.onAuthStateChange((_change, session) => {
        if (session?.user.pubkey !== pubkey) unsubscribe();
      }).data.subscription,
    );
    lifetime.add(
      merge(
        this.host.transport.subscribe(this.host.relays, [
          this.filter(table, pubkey),
          { kinds: [5], authors: [pubkey] },
        ]),
        this.host.ingested$,
      ).subscribe({
        next: (event) => {
          serial = serial
            .then(async () => {
              if (closed || !verify(event) || event.pubkey !== pubkey) return;
              await this.checkIdentity(pubkey);
              if (event.kind === 5) {
                this.host.ingest(event);
                for (const [id, previous] of current) {
                  if (this.host.isDeleted(previous.event)) {
                    const identifier = previous.event.tags.find((tag) => tag[0] === "d")?.[1];
                    const latest = this.host.eventStore.getReplaceable(
                      RECORD_KIND,
                      pubkey,
                      identifier,
                    );
                    if (
                      latest &&
                      compareEvents(latest, previous.event) > 0 &&
                      !this.host.isDeleted(latest)
                    )
                      continue;
                    current.delete(id);
                    if (!closed)
                      callback(
                        structuredClone({
                          eventType: "DELETE",
                          table,
                          old: previous.row,
                          new: null,
                          event,
                        }),
                      );
                  }
                }
              } else {
                if (!this.isCurrent(event)) return;
                const row = await this.decode<DB[K]>(event, table);
                if (!row || closed || !this.isCurrent(event)) return;
                const previous = current.get(row.id);
                if (previous && compareEvents(event, previous.event) <= 0) return;
                this.host.ingest(event);
                if (closed || !this.isCurrent(event)) return;
                current.set(row.id, { event, row });
                callback(
                  structuredClone({
                    eventType: previous ? "UPDATE" : "INSERT",
                    table,
                    old: previous?.row ?? null,
                    new: row,
                    event,
                  }),
                );
              }
            })
            .catch(reportError);
        },
        error: (error) => {
          reportError(error);
          unsubscribe();
        },
      }),
    );
    try {
      for (const event of seedEvents) {
        if (closed) break;
        const row = await this.decode<DB[K]>(event, table);
        if (row && !closed && this.isCurrent(event)) current.set(row.id, { event, row });
      }
      await this.checkIdentity(pubkey);
    } catch (error) {
      unsubscribe();
      throw error;
    } finally {
      releaseSeed();
    }
    return { unsubscribe };
  }
  close(): void {
    for (const unsubscribe of this.subscriptions) unsubscribe();
  }
}
