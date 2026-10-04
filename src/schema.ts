import type { ZodType } from "zod";
import type { SchemaShape, TableDefinition } from "./types";

/** Pass a Zod schema to validate both writes and incoming records. Transforms are not applied. */
export function zodTable<T extends object>(
  schema: ZodType<T>,
  options: Omit<TableDefinition<T>, "validate"> = {},
): TableDefinition<T> {
  return { ...options, validate: (data): data is T => schema.safeParse(data).success };
}
export function defineTable<T extends object>(definition: TableDefinition<T>): TableDefinition<T> {
  return definition;
}
export function defineSchema<DB extends SchemaShape<DB>>(
  schema: { [K in keyof DB]: TableDefinition<DB[K]> },
): { [K in keyof DB]: TableDefinition<DB[K]> } {
  return schema;
}
export type InferDatabase<S> = {
  [K in keyof S]: S[K] extends TableDefinition<infer T> ? T : never;
};
