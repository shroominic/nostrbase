import { asError, NostrbaseError } from "./errors";
import type { Cardinality, Insert, Projection, QueryData, Result, Row, Selection } from "./types";

export type PredicateOperator =
  | "eq"
  | "neq"
  | "in"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "is"
  | "textSearch"
  | "contains";
export interface Predicate {
  field: string;
  op: PredicateOperator;
  value: unknown;
}
export interface QueryState {
  operation: "select" | "insert" | "upsert" | "update" | "delete";
  values?: object[];
  patch?: object;
  predicates: Predicate[];
  authors?: string[];
  order: { field: string; ascending: boolean }[];
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
}
export function fieldValue(row: object, field: string): unknown {
  if (field.startsWith("_nostr."))
    return (row as { _nostr?: Record<string, unknown> })._nostr?.[field.slice(7)];
  return Object.hasOwn(row, field) ? (row as Record<string, unknown>)[field] : undefined;
}
export function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((value, index) => equal(value, b[index]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every(
        (key) =>
          Object.hasOwn(b, key) &&
          equal((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
      )
    );
  }
  return false;
}
export function matches(row: object, predicates: Predicate[]): boolean {
  return predicates.every(({ field, op, value }) => {
    const actual = fieldValue(row, field);
    switch (op) {
      case "eq":
      case "is":
        return equal(actual, value);
      case "neq":
        return !equal(actual, value);
      case "in":
        return Array.isArray(value) && value.some((entry) => equal(actual, entry));
      case "textSearch": {
        if (typeof actual !== "string" || typeof value !== "string") return false;
        const normalize = (text: string) =>
          text.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();
        const words = normalize(value).trim().split(/\s+/u).filter(Boolean);
        return words.every((word) => normalize(actual).includes(word));
      }
      case "contains":
        return Array.isArray(actual) && Array.isArray(value)
          ? value.every((entry) => actual.some((item) => equal(item, entry)))
          : actual !== null &&
              value !== null &&
              typeof actual === "object" &&
              typeof value === "object" &&
              Object.keys(value).every(
                (key) =>
                  Object.hasOwn(actual, key) &&
                  equal(
                    (actual as Record<string, unknown>)[key],
                    (value as Record<string, unknown>)[key],
                  ),
              );
      case "gt":
      case "gte":
      case "lt":
      case "lte": {
        if (
          !(typeof actual === "number" && typeof value === "number") &&
          !(typeof actual === "string" && typeof value === "string")
        )
          return false;
        if (op === "gt") return actual > value;
        if (op === "gte") return actual >= value;
        if (op === "lt") return actual < value;
        return actual <= value;
      }
    }
    return false;
  });
}
export function applyQuery<T extends object>(rows: Row<T>[], state: QueryState): Row<T>[] {
  let selected = rows.filter((row) => matches(row, state.predicates));
  selected.sort((a, b) => {
    for (const order of state.order) {
      const left = fieldValue(a, order.field);
      const right = fieldValue(b, order.field);
      if (equal(left, right)) continue;
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
  select<const Columns extends string = "*">(
    columns?: Columns & Selection<Row<T>, Columns>,
  ): QueryBuilder<T, Projection<Row<T>, Columns>, C> {
    return this.clone({ returning: true }, columns ?? "*");
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
  private predicate(
    field: string,
    op: PredicateOperator,
    value: unknown,
  ): QueryBuilder<T, Selected, C> {
    return this.clone({ predicates: [...this.state.predicates, { field, op, value }] });
  }
  eq<K extends keyof Row<T> & string>(field: K, value: Row<T>[K]): QueryBuilder<T, Selected, C> {
    return this.predicate(field, "eq", value);
  }
  neq<K extends keyof Row<T> & string>(field: K, value: Row<T>[K]): QueryBuilder<T, Selected, C> {
    return this.predicate(field, "neq", value);
  }
  in<K extends keyof Row<T> & string>(
    field: K,
    values: readonly Row<T>[K][],
  ): QueryBuilder<T, Selected, C> {
    return this.predicate(field, "in", values);
  }
  gt<K extends keyof Row<T> & string>(field: K, value: Row<T>[K]): QueryBuilder<T, Selected, C> {
    return this.predicate(field, "gt", value);
  }
  gte<K extends keyof Row<T> & string>(field: K, value: Row<T>[K]): QueryBuilder<T, Selected, C> {
    return this.predicate(field, "gte", value);
  }
  lt<K extends keyof Row<T> & string>(field: K, value: Row<T>[K]): QueryBuilder<T, Selected, C> {
    return this.predicate(field, "lt", value);
  }
  lte<K extends keyof Row<T> & string>(field: K, value: Row<T>[K]): QueryBuilder<T, Selected, C> {
    return this.predicate(field, "lte", value);
  }
  is<K extends keyof Row<T> & string>(
    field: K,
    value: null | boolean,
  ): QueryBuilder<T, Selected, C> {
    return this.predicate(field, "is", value);
  }
  contains<K extends keyof Row<T> & string>(
    field: K,
    value: Partial<Row<T>[K]>,
  ): QueryBuilder<T, Selected, C> {
    return this.predicate(field, "contains", value);
  }
  textSearch<K extends keyof T & string>(field: K, query: string): QueryBuilder<T, Selected, C> {
    return this.predicate(field, "textSearch", query);
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
    return this.clone({
      predicates: [
        ...this.state.predicates,
        ...Object.entries(values).map(([field, value]) => ({ field, op: "eq" as const, value })),
      ],
    });
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
    field: keyof Row<T> & string,
    options: { ascending?: boolean } = {},
  ): QueryBuilder<T, Selected, C> {
    return this.clone({
      order: [...this.state.order, { field, ascending: options.ascending ?? true }],
    });
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
      const result = await this.host.execute<T>(this.table, this.state);
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
