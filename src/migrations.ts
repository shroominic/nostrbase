import { asError, NostrbaseError } from "./errors";
import { encodeRecord, rowData } from "./protocol";
import type { QueryBuilder, QueryState } from "./query";
import type { Result, Row, SchemaShape, Signer, TableDefinition, WriteReceipt } from "./types";

export interface MigrationOptions {
  dryRun?: boolean;
  queue?: boolean;
  signal?: AbortSignal;
}
export interface MigrationResult<T extends object> {
  examined: number;
  changed: number;
  rows: Row<T>[];
  receipts: WriteReceipt[];
}
interface MigrationHost<DB extends SchemaShape<DB>> {
  namespace: string;
  auth: { requireSigner(): Promise<{ signer: Signer; session: { user: { pubkey: string } } }> };
  from<K extends keyof DB & string>(table: K): QueryBuilder<DB[K]>;
  definition<T extends object>(table: string): TableDefinition<T> | undefined;
  ready(): Promise<void>;
  assertTable(table: string): void;
  readTable<T extends object>(
    table: string,
    state: QueryState,
    authors: string[],
    definition: TableDefinition<T>,
  ): Promise<{ rows: Row<T>[] }>;
}
/** Rewrites only records owned by the current signer. Run a dry run to inspect changes first. */
export class NostrbaseMigrations<DB extends SchemaShape<DB>> {
  constructor(private host: MigrationHost<DB>) {}
  async run<K extends keyof DB & string, Old extends object = DB[K]>(
    table: K,
    transform: (data: Old, row: Row<Old>) => DB[K] | null | Promise<DB[K] | null>,
    options: MigrationOptions = {},
  ): Promise<Result<MigrationResult<DB[K]>>> {
    const progress: MigrationResult<DB[K]> = { examined: 0, changed: 0, rows: [], receipts: [] };
    try {
      const { session } = await this.host.auth.requireSigner();
      await this.host.ready();
      this.host.assertTable(table);
      // Old data must be readable even when it fails the new destination schema.
      const read = await this.host.readTable<Old>(
        table,
        {
          operation: "select",
          predicates: [],
          order: [],
          allowAll: false,
          returning: true,
          local: !!options.queue,
          signal: options.signal,
        },
        [session.user.pubkey],
        {},
      );
      const planned: { row: Row<Old>; data: DB[K] }[] = [];
      for (const row of read.rows) {
        if (options.signal?.aborted) throw new NostrbaseError("ABORTED", "Migration was aborted.");
        progress.examined++;
        const next = await transform(structuredClone(rowData(row)), structuredClone(row));
        if (next === null) continue;
        encodeRecord(
          this.host.namespace,
          table,
          row.id,
          next,
          row._nostr.createdAt,
          row._nostr.updatedAt,
          this.host.definition(table),
        );
        if (JSON.stringify(next) !== JSON.stringify(rowData(row)))
          planned.push({ row, data: next });
      }
      if (options.dryRun) {
        progress.changed = planned.length;
        progress.rows = planned.map(({ row, data }) => ({
          ...data,
          id: row.id,
          _nostr: row._nostr,
        }));
        return { data: progress, error: null, count: progress.changed };
      }
      for (const { row, data } of planned) {
        // Upsert replaces the data object, allowing a migration to remove obsolete fields.
        let mutation = this.host
          .from(table)
          .upsert({ ...data, id: row.id })
          .author(session.user.pubkey)
          .select()
          .single();
        if (options.queue) mutation = mutation.queue();
        if (options.signal) mutation = mutation.abortSignal(options.signal);
        const result = await mutation;
        progress.receipts.push(...(result.meta?.receipts ?? []));
        if (result.data) {
          progress.rows.push(result.data);
          progress.changed++;
        }
        if (result.error)
          return {
            data: progress,
            error: result.error,
            count: progress.changed,
            meta: {
              relays: progress.receipts.flatMap((receipt) => receipt.relays),
              receipts: progress.receipts,
              partial: progress.changed > 0 || !!result.meta?.partial,
            },
          };
      }
      return {
        data: progress,
        error: null,
        count: progress.changed,
        meta: {
          relays: progress.receipts.flatMap((receipt) => receipt.relays),
          receipts: progress.receipts,
          partial: progress.receipts.some((receipt) => receipt.relays.some((relay) => !relay.ok)),
        },
      };
    } catch (error) {
      return {
        data: progress,
        error: asError(error),
        count: progress.changed,
        meta: {
          receipts: progress.receipts,
          relays: progress.receipts.flatMap((receipt) => receipt.relays),
          partial: progress.changed > 0,
        },
      };
    }
  }
}
