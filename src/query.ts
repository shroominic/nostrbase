import { asError, NostrbaseError } from "./errors";
import {
  type DeepPartial,
  equal,
  type FilterOperator,
  type FilterValue,
  fieldPath,
  fieldValue,
  makeFilterPredicate,
  makePredicate,
  matches,
  type Predicate,
  parseOr,
  type QueryField,
  type QueryFieldValue,
  snapshotValue,
} from "./query-filters";
import type { Cardinality, Insert, Projection, QueryData, Result, Row, Selection } from "./types";

export type {
  DeepPartial,
  FilterOperator,
  FilterValue,
  Predicate,
  PredicateOperator,
  QueryField,
  QueryFieldValue,
  QueryOperator,
} from "./query-filters";
export { equal, fieldValue, matches } from "./query-filters";
export interface SelectOptions {
  count?: "exact";
  head?: boolean;
}

export interface QueryState {
  operation: "select" | "insert" | "upsert" | "update" | "delete";
  groupId?: string;
  values?: object[];
  patch?: object;
  predicates: Predicate[];
  authors?: string[];
  order: { field: string; ascending: boolean; nullsFirst?: boolean }[];
  count?: "exact";
  head?: boolean;
  limit?: number;
  range?: [number, number];
  allowAll: boolean;
  returning: boolean;
  signal?: AbortSignal;
  validationError?: NostrbaseError;
  queue?: boolean;
  local?: boolean;
  page?: { size: number; cursor?: string };
}
export interface QueryHost {
  execute<T extends object>(table: string, state: QueryState): Promise<Result<Row<T>[]>>;
  executeInGroup?<T extends object>(
    groupId: string,
    table: string,
    state: QueryState,
  ): Promise<Result<Row<T>[]>>;
}
/** Exact count within the supplied verified records, before ordering or page limits. */
export function countMatches<T extends object>(rows: Row<T>[], state: QueryState): number {
  return rows.filter((row) => matches(row, state.predicates)).length;
}
export function applyQuery<T extends object>(rows: Row<T>[], state: QueryState): Row<T>[] {
  let selected = rows.filter((row) => matches(row, state.predicates));
  selected.sort((a, b) => {
    for (const order of state.order) {
      const left = fieldValue(a, order.field);
      const right = fieldValue(b, order.field);
      if (equal(left, right) || (left == null && right == null)) continue;
      if (left == null || right == null) {
        const nullsFirst = order.nullsFirst ?? !order.ascending;
        return left == null ? (nullsFirst ? -1 : 1) : nullsFirst ? 1 : -1;
      }
      const comparison =
        left == null
          ? 1
          : right == null
            ? -1
            : typeof left === "number" && typeof right === "number"
              ? left - right
              : String(left).localeCompare(String(right));
      return order.ascending ? comparison : -comparison;
    }
    return (
      b._nostr.updatedAt - a._nostr.updatedAt || a._nostr.eventId.localeCompare(b._nostr.eventId)
    );
  });
  if (state.range) selected = selected.slice(state.range[0], state.range[1] + 1);
  if (state.page) {
    const cursor = parseCursor(state.page.cursor);
    if (cursor)
      selected = selected.filter(
        (row) =>
          row._nostr.updatedAt < cursor.timestamp ||
          (row._nostr.updatedAt === cursor.timestamp && row._nostr.eventId > cursor.eventId),
      );
    selected = selected.slice(0, state.page.size);
  }
  if (state.limit !== undefined) selected = selected.slice(0, state.limit);
  return selected;
}

export interface TableCursor {
  namespace: string;
  table: string;
  timestamp: number;
  eventId: string;
}
export function parseCursor(value?: string): TableCursor | undefined {
  if (value === undefined) return undefined;
  try {
    const cursor = JSON.parse(decodeURIComponent(value)) as TableCursor;
    if (
      typeof cursor.namespace !== "string" ||
      typeof cursor.table !== "string" ||
      !Number.isSafeInteger(cursor.timestamp) ||
      cursor.timestamp < 0 ||
      !/^[0-9a-f]{64}$/.test(cursor.eventId)
    )
      throw new Error();
    return cursor;
  } catch {
    throw new NostrbaseError("INVALID_QUERY", "Pagination cursor is invalid.");
  }
}
export function nextCursor<T extends object>(
  namespace: string,
  table: string,
  rows: Row<T>[],
  state: QueryState,
): string | undefined {
  const last = rows.at(-1);
  return state.page && rows.length === state.page.size && last
    ? encodeURIComponent(
        JSON.stringify({
          namespace,
          table,
          timestamp: last._nostr.updatedAt,
          eventId: last._nostr.eventId,
        } satisfies TableCursor),
      )
    : undefined;
}

/** Queries are immutable and execute once when awaited. */
export class QueryBuilder<T extends object, Selected = Row<T>, C extends Cardinality = "many">
  implements PromiseLike<Result<QueryData<Selected, C>>>
{
  private promise?: Promise<Result<QueryData<Selected, C>>>;
  constructor(
    private host: QueryHost,
    readonly table: string,
    private state: QueryState = {
      operation: "select",
      predicates: [],
      order: [],
      allowAll: false,
      returning: true,
    },
    private columns = "*",
    private cardinality: Cardinality = "many",
    private throws = false,
  ) {}
  private clone<S = Selected, Next extends Cardinality = C>(
    patch: Partial<QueryState> = {},
    columns = this.columns,
    cardinality = this.cardinality,
    throws = this.throws,
  ): QueryBuilder<T, S, Next> {
    return new QueryBuilder<T, S, Next>(
      this.host,
      this.table,
      { ...this.state, ...patch },
      columns,
      cardinality,
      throws,
    );
  }
  /** Route this query to a shared private collection. Unsupported hosts never fall back to another scope. */
  inGroup(groupId: string): QueryBuilder<T, Selected, C> {
    const validationError =
      this.state.validationError ??
      (typeof groupId !== "string" || !/^[0-9a-f]{64}$/.test(groupId)
        ? new NostrbaseError("INVALID_QUERY", "Group ID must be full lowercase 64-hex.")
        : undefined);
    return this.clone({ groupId, validationError });
  }
  select<const Columns extends string = "*">(
    columns?: Columns & Selection<Row<T>, Columns>,
    options: SelectOptions = {},
  ): QueryBuilder<T, Projection<Row<T>, Columns>, C> {
    const invalid =
      !options ||
      typeof options !== "object" ||
      Array.isArray(options) ||
      Object.keys(options).some((key) => key !== "count" && key !== "head") ||
      (options.count !== undefined && options.count !== "exact") ||
      (options.head !== undefined && typeof options.head !== "boolean");
    return this.clone(
      {
        returning: true,
        count: options?.count,
        head: options?.head,
        validationError:
          this.state.validationError ??
          (invalid
            ? new NostrbaseError(
                "INVALID_QUERY",
                "Select accepts count: exact and a boolean head option.",
              )
            : undefined),
      },
      columns ?? "*",
    );
  }
  insert(values: Insert<T> | Insert<T>[]): QueryBuilder<T, Row<T>, "many"> {
    return this.clone(
      {
        operation: "insert",
        values: Array.isArray(values) ? values : [values],
        returning: false,
      },
      "*",
      "many",
    );
  }
  upsert(values: Insert<T> | Insert<T>[]): QueryBuilder<T, Row<T>, "many"> {
    return this.clone(
      {
        operation: "upsert",
        values: Array.isArray(values) ? values : [values],
        returning: false,
      },
      "*",
      "many",
    );
  }
  update(patch: Partial<T>): QueryBuilder<T, Row<T>, "many"> {
    return this.clone({ operation: "update", patch, returning: false }, "*", "many");
  }
  delete(): QueryBuilder<T, Row<T>, "many"> {
    return this.clone({ operation: "delete", returning: false }, "*", "many");
  }
  private addPredicate(build: () => Predicate): QueryBuilder<T, Selected, C> {
    try {
      return this.clone({ predicates: [...this.state.predicates, build()] });
    } catch (error) {
      return this.clone({
        validationError: this.state.validationError ?? asError(error, "INVALID_QUERY"),
      });
    }
  }
  private predicate(field: string, op: string, value: unknown): QueryBuilder<T, Selected, C> {
    return this.addPredicate(() => makePredicate(field, op, value));
  }
  eq<K extends keyof Row<T> & string>(field: K, value: Row<T>[K]): QueryBuilder<T, Selected, C>;
  eq<K extends Exclude<QueryField<Row<T>>, keyof Row<T>>>(
    field: K,
    value: QueryFieldValue<Row<T>, K>,
  ): QueryBuilder<T, Selected, C>;
  eq(field: string, value: unknown): QueryBuilder<T, Selected, C> {
    return this.predicate(field, "eq", value);
  }
  neq<K extends keyof Row<T> & string>(field: K, value: Row<T>[K]): QueryBuilder<T, Selected, C>;
  neq<K extends Exclude<QueryField<Row<T>>, keyof Row<T>>>(
    field: K,
    value: QueryFieldValue<Row<T>, K>,
  ): QueryBuilder<T, Selected, C>;
  neq(field: string, value: unknown): QueryBuilder<T, Selected, C> {
    return this.predicate(field, "neq", value);
  }
  in<K extends QueryField<Row<T>>>(
    field: K,
    values: readonly QueryFieldValue<Row<T>, K>[],
  ): QueryBuilder<T, Selected, C> {
    return this.predicate(field, "in", values);
  }
  gt<K extends keyof Row<T> & string>(field: K, value: Row<T>[K]): QueryBuilder<T, Selected, C>;
  gt<K extends Exclude<QueryField<Row<T>>, keyof Row<T>>>(
    field: K,
    value: QueryFieldValue<Row<T>, K>,
  ): QueryBuilder<T, Selected, C>;
  gt(field: string, value: unknown): QueryBuilder<T, Selected, C> {
    return this.predicate(field, "gt", value);
  }
  gte<K extends keyof Row<T> & string>(field: K, value: Row<T>[K]): QueryBuilder<T, Selected, C>;
  gte<K extends Exclude<QueryField<Row<T>>, keyof Row<T>>>(
    field: K,
    value: QueryFieldValue<Row<T>, K>,
  ): QueryBuilder<T, Selected, C>;
  gte(field: string, value: unknown): QueryBuilder<T, Selected, C> {
    return this.predicate(field, "gte", value);
  }
  lt<K extends keyof Row<T> & string>(field: K, value: Row<T>[K]): QueryBuilder<T, Selected, C>;
  lt<K extends Exclude<QueryField<Row<T>>, keyof Row<T>>>(
    field: K,
    value: QueryFieldValue<Row<T>, K>,
  ): QueryBuilder<T, Selected, C>;
  lt(field: string, value: unknown): QueryBuilder<T, Selected, C> {
    return this.predicate(field, "lt", value);
  }
  lte<K extends keyof Row<T> & string>(field: K, value: Row<T>[K]): QueryBuilder<T, Selected, C>;
  lte<K extends Exclude<QueryField<Row<T>>, keyof Row<T>>>(
    field: K,
    value: QueryFieldValue<Row<T>, K>,
  ): QueryBuilder<T, Selected, C>;
  lte(field: string, value: unknown): QueryBuilder<T, Selected, C> {
    return this.predicate(field, "lte", value);
  }
  is<K extends QueryField<Row<T>>>(field: K, value: null | boolean): QueryBuilder<T, Selected, C> {
    return this.predicate(field, "is", value);
  }
  contains<K extends QueryField<Row<T>>>(
    field: K,
    value: DeepPartial<QueryFieldValue<Row<T>, K>>,
  ): QueryBuilder<T, Selected, C> {
    return this.predicate(field, "contains", value);
  }
  containedBy<K extends QueryField<Row<T>>>(
    field: K,
    value: DeepPartial<QueryFieldValue<Row<T>, K>>,
  ): QueryBuilder<T, Selected, C> {
    return this.predicate(field, "containedBy", value);
  }
  overlaps<K extends QueryField<Row<T>>>(
    field: K,
    value: FilterValue<QueryFieldValue<Row<T>, K>, "overlaps">,
  ): QueryBuilder<T, Selected, C> {
    return this.predicate(field, "overlaps", value);
  }
  like<K extends QueryField<Row<T>>>(field: K, pattern: string): QueryBuilder<T, Selected, C> {
    return this.predicate(field, "like", pattern);
  }
  ilike<K extends QueryField<Row<T>>>(field: K, pattern: string): QueryBuilder<T, Selected, C> {
    return this.predicate(field, "ilike", pattern);
  }
  textSearch<K extends QueryField<T>>(field: K, query: string): QueryBuilder<T, Selected, C> {
    return this.predicate(field, "textSearch", query);
  }
  filter<K extends QueryField<Row<T>>, O extends FilterOperator>(
    field: K,
    op: O,
    value: FilterValue<QueryFieldValue<Row<T>, K>, O> | string,
  ): QueryBuilder<T, Selected, C> {
    return this.addPredicate(() => makeFilterPredicate(field, op, value));
  }
  not<K extends QueryField<Row<T>>, O extends FilterOperator>(
    field: K,
    op: O,
    value: FilterValue<QueryFieldValue<Row<T>, K>, O> | string,
  ): QueryBuilder<T, Selected, C> {
    return this.addPredicate(() => ({
      field: "",
      op: "not",
      value: makeFilterPredicate(field, op, value),
    }));
  }
  /** PostgREST-style alternatives. Other chained filters remain AND conditions. */
  or(expression: string): QueryBuilder<T, Selected, C> {
    return this.addPredicate(() => parseOr(expression));
  }
  /** Read only from the local verified cache; no relay request is made. */
  local(): QueryBuilder<T, Selected, C> {
    return this.clone({ local: true });
  }
  /** Sign and save a mutation for explicit offline replay. Requires a signed-in author. */
  queue(): QueryBuilder<T, Selected, C> {
    return this.clone({ queue: true, local: true });
  }
  /** Timestamp/event-id cursor pagination, newest records first. */
  page(size: number, options: { cursor?: string } = {}): QueryBuilder<T, Selected, C> {
    const invalid =
      !Number.isSafeInteger(size) ||
      size < 1 ||
      size > 1000 ||
      this.state.order.length > 0 ||
      !!this.state.range;
    let error = invalid
      ? new NostrbaseError(
          "INVALID_QUERY",
          "Page size must be 1 to 1000; cursor pages use newest-first order without range offsets.",
        )
      : this.state.validationError;
    try {
      parseCursor(options.cursor);
    } catch (failure) {
      error = asError(failure, "INVALID_QUERY");
    }
    return this.clone({ page: { size, cursor: options.cursor }, validationError: error });
  }
  match(values: Partial<Row<T>>): QueryBuilder<T, Selected, C> {
    try {
      if (!values || typeof values !== "object" || Array.isArray(values))
        throw new NostrbaseError("INVALID_QUERY", "Match requires a field-value object.");
      const predicates = Object.entries(snapshotValue(values) as Record<string, unknown>).map(
        ([field, value]) => makePredicate(field, "eq", value),
      );
      return this.clone({ predicates: [...this.state.predicates, ...predicates] });
    } catch (error) {
      return this.clone({
        validationError: this.state.validationError ?? asError(error, "INVALID_QUERY"),
      });
    }
  }
  author(pubkey: string | readonly string[]): QueryBuilder<T, Selected, C> {
    const authors = typeof pubkey === "string" ? [pubkey] : [...pubkey];
    const validationError =
      !authors.length || authors.some((key) => !/^[0-9a-f]{64}$/.test(key))
        ? new NostrbaseError("INVALID_QUERY", "Authors must be full hex public keys.")
        : this.state.validationError;
    return this.clone({ authors, validationError });
  }
  order(
    field: QueryField<Row<T>>,
    options: { ascending?: boolean; nullsFirst?: boolean } = {},
  ): QueryBuilder<T, Selected, C> {
    try {
      fieldPath(field);
      if (
        !options ||
        typeof options !== "object" ||
        Array.isArray(options) ||
        Object.keys(options).some((key) => key !== "ascending" && key !== "nullsFirst") ||
        (options.ascending !== undefined && typeof options.ascending !== "boolean") ||
        (options.nullsFirst !== undefined && typeof options.nullsFirst !== "boolean")
      )
        throw new NostrbaseError(
          "INVALID_QUERY",
          "Order direction and nullsFirst must be booleans.",
        );
      return this.clone({
        order: [
          ...this.state.order,
          {
            field,
            ascending: options.ascending ?? true,
            ...(options.nullsFirst !== undefined ? { nullsFirst: options.nullsFirst } : {}),
          },
        ],
      });
    } catch (error) {
      return this.clone({
        validationError: this.state.validationError ?? asError(error, "INVALID_QUERY"),
      });
    }
  }
  limit(count: number): QueryBuilder<T, Selected, C> {
    return this.clone({
      limit: count,
      validationError:
        !Number.isSafeInteger(count) || count < 0
          ? new NostrbaseError("INVALID_QUERY", "Limit must be a nonnegative integer.")
          : this.state.validationError,
    });
  }
  range(from: number, to: number): QueryBuilder<T, Selected, C> {
    return this.clone({
      range: [from, to],
      validationError:
        !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from
          ? new NostrbaseError("INVALID_QUERY", "Range must use nonnegative inclusive offsets.")
          : this.state.validationError,
    });
  }
  /** Explicitly permit an update or delete of every record owned by the signer. */
  all(): QueryBuilder<T, Selected, C> {
    return this.clone({ allowAll: true });
  }
  single(): QueryBuilder<T, Selected, "one"> {
    return this.clone({ returning: true }, this.columns, "one");
  }
  maybeSingle(): QueryBuilder<T, Selected, "maybe"> {
    return this.clone({ returning: true }, this.columns, "maybe");
  }
  abortSignal(signal: AbortSignal): QueryBuilder<T, Selected, C> {
    return this.clone({ signal });
  }
  throwOnError(): QueryBuilder<T, Selected, C> {
    return this.clone({}, this.columns, this.cardinality, true);
  }
  private async run(): Promise<Result<QueryData<Selected, C>>> {
    try {
      if (this.state.validationError) throw this.state.validationError;
      if (this.state.head && (this.state.operation !== "select" || this.cardinality !== "many"))
        throw new NostrbaseError(
          "INVALID_QUERY",
          "Head reads require a select query with many-row cardinality.",
        );
      if (this.state.page && (this.state.order.length || this.state.range))
        throw new NostrbaseError(
          "INVALID_QUERY",
          "Cursor pages require newest-first order without range offsets.",
        );
      if (this.state.queue && this.state.operation === "select")
        throw new NostrbaseError(
          "INVALID_QUERY",
          "Use local() for cached reads; queue() is for mutations.",
        );
      if (
        this.columns !== "*" &&
        (!this.columns.trim() ||
          this.columns.split(",").some((column) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(column.trim())))
      )
        throw new NostrbaseError(
          "INVALID_QUERY",
          "Select accepts * or comma-separated field names.",
        );
      let result: Result<Row<T>[]>;
      if (this.state.groupId !== undefined) {
        if (typeof this.host.executeInGroup !== "function")
          throw new NostrbaseError(
            "INVALID_QUERY",
            "This query host does not support group routing.",
          );
        result = await this.host.executeInGroup<T>(this.state.groupId, this.table, this.state);
      } else {
        result = await this.host.execute<T>(this.table, this.state);
      }
      if (result.error && this.throws) throw result.error;
      if (result.data === null) return result as Result<QueryData<Selected, C>>;
      const rows = result.data.map((row) =>
        this.columns === "*"
          ? row
          : Object.fromEntries(
              this.columns
                .split(",")
                .map((column) => column.trim())
                .filter((column) => Object.hasOwn(row, column))
                .map((column) => [column, (row as Record<string, unknown>)[column]]),
            ),
      );
      if (this.cardinality !== "many") {
        const cardinalityError =
          rows.length > 1
            ? new NostrbaseError(
                "MULTIPLE_ROWS",
                "Query returned more than one record. Filter by id and author.",
              )
            : !rows.length && this.cardinality === "one" && !result.error
              ? new NostrbaseError("NOT_FOUND", "Query returned no records.")
              : null;
        if (cardinalityError) {
          if (this.throws) throw cardinalityError;
          return { ...result, data: null, error: result.error ?? cardinalityError } as Result<
            QueryData<Selected, C>
          >;
        }
        return { ...result, data: rows[0] ?? null } as Result<QueryData<Selected, C>>;
      }
      return { ...result, data: rows } as Result<QueryData<Selected, C>>;
    } catch (error) {
      const converted = asError(error, "INVALID_QUERY");
      if (this.throws) throw converted;
      return { data: null, error: converted };
    }
  }
  // biome-ignore lint/suspicious/noThenProperty: Awaitable query builders are the public SDK contract.
  then<TResult1 = Result<QueryData<Selected, C>>, TResult2 = never>(
    onfulfilled?:
      | ((value: Result<QueryData<Selected, C>>) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    this.promise ??= this.run();
    return this.promise.then(onfulfilled, onrejected);
  }
}
