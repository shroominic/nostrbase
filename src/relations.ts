import { asError, NostrbaseError } from "./errors";
import type { QueryBuilder } from "./query";
import type { Result, Row, SchemaShape } from "./types";

export interface RecordReference<K extends string = string> {
  table: K;
  id: string;
  author: string;
}
interface RelationsHost<DB extends SchemaShape<DB>> {
  from<K extends keyof DB & string>(table: K): QueryBuilder<DB[K]>;
}
export function reference<K extends string>(
  table: K,
  id: string,
  author: string,
): RecordReference<K> {
  if (!table || !id || !/^[0-9a-f]{64}$/.test(author))
    throw new NostrbaseError(
      "INVALID_RECORD",
      "A reference needs a table, record id, and full author public key.",
    );
  return Object.freeze({ table, id, author });
}
/** References are resolved in the client. They do not enforce foreign keys. */
export class NostrbaseRelations<DB extends SchemaShape<DB>> {
  constructor(private host: RelationsHost<DB>) {}
  async resolve<K extends keyof DB & string>(
    target: RecordReference<K>,
  ): Promise<Result<Row<DB[K]>>> {
    try {
      reference(target.table, target.id, target.author);
      const query = this.host.from(target.table);
      return await query
        .author(target.author)
        .eq("id", target.id as Row<DB[K]>["id"])
        .single();
    } catch (error) {
      return { data: null, error: asError(error, "INVALID_QUERY") };
    }
  }
  async resolveMany<K extends keyof DB & string>(
    targets: readonly RecordReference<K>[],
  ): Promise<Result<(Row<DB[K]> | null)[]>> {
    const results = await Promise.all(targets.map((target) => this.resolve(target)));
    const failure = results.find((result) => result.error && result.error.code !== "NOT_FOUND");
    return {
      data: results.map((result) => result.data),
      error: failure?.error ?? null,
      meta: {
        relays: results.flatMap((result) => result.meta?.relays ?? []),
        partial: results.some((result) => result.error !== null || result.meta?.partial),
      },
    };
  }
}
