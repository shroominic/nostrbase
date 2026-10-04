import { verifyEvent } from "nostr-tools";
import { NostrbaseError } from "./errors";
import type { EventTemplate, NostrEvent, Row, TableDefinition } from "./types";

export const RECORD_KIND = 30078;
export const PROTOCOL_VERSION = 1;
export const scopeTag = (namespace: string, table: string): string =>
  `nostrbase:${encodeURIComponent(namespace)}:${encodeURIComponent(table)}`;
export const recordIdentifier = (namespace: string, table: string, id: string): string =>
  `${scopeTag(namespace, table)}:${encodeURIComponent(id)}`;
export const addressOf = (event: NostrEvent): string =>
  `${event.kind}:${event.pubkey}:${event.tags.find((tag) => tag[0] === "d")?.[1] ?? ""}`;
export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function verify(event: NostrEvent): boolean {
  try {
    if (
      !Number.isSafeInteger(event.kind) ||
      event.kind < 0 ||
      event.kind > 65535 ||
      !Number.isSafeInteger(event.created_at) ||
      event.created_at < 0
    )
      return false;
    // Never carry nostr-tools' cached verification symbol from a mutable caller object.
    return verifyEvent({
      id: event.id,
      pubkey: event.pubkey,
      kind: event.kind,
      created_at: event.created_at,
      tags: event.tags,
      content: event.content,
      sig: event.sig,
    });
  } catch {
    return false;
  }
}
export function compareEvents(a: NostrEvent, b: NostrEvent): number {
  return a.created_at - b.created_at || b.id.localeCompare(a.id);
}
export function validateData<T extends object>(
  data: unknown,
  definition?: TableDefinition<T>,
): asserts data is T {
  if (!isObject(data) || "id" in data || "_nostr" in data)
    throw new NostrbaseError(
      "INVALID_RECORD",
      "Record data must be an object. id and _nostr are reserved fields.",
    );
  const visit = (value: unknown): void => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number" && Number.isFinite(value)) return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (
      isObject(value) &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    ) {
      for (const entry of Object.values(value)) visit(entry);
      return;
    }
    throw new NostrbaseError("INVALID_RECORD", "Records must contain JSON values only.");
  };
  try {
    visit(data);
  } catch (error) {
    if (error instanceof NostrbaseError) throw error;
    throw new NostrbaseError("INVALID_RECORD", "Record contains circular data.");
  }
  if (definition?.validate && !definition.validate(data))
    throw new NostrbaseError("INVALID_RECORD", "Record does not match the table schema.");
}
export function encodeRecord<T extends object>(
  namespace: string,
  table: string,
  id: string,
  data: T,
  createdAt: number,
  updatedAt: number,
  definition?: TableDefinition<T>,
): EventTemplate {
  validateData(data, definition);
  if (typeof id !== "string" || !id || id.length > 512)
    throw new NostrbaseError("INVALID_RECORD", "Record id must contain 1 to 512 characters.");
  const tags = [
    ["d", recordIdentifier(namespace, table, id)],
    ["t", scopeTag(namespace, table)],
  ];
  for (const field of definition?.indexes ?? []) {
    const value = (data as Record<string, unknown>)[field];
    if (value !== undefined)
      tags.push([
        "t",
        `${scopeTag(namespace, table)}:${encodeURIComponent(field)}:${encodeURIComponent(JSON.stringify(value))}`,
      ]);
  }
  return {
    kind: RECORD_KIND,
    created_at: updatedAt,
    tags,
    content: JSON.stringify({ v: PROTOCOL_VERSION, namespace, table, id, createdAt, data }),
  };
}
export function decodeRecord<T extends object>(
  event: NostrEvent,
  namespace: string,
  table: string,
  definition?: TableDefinition<T>,
): Row<T> | null {
  if (
    event.kind !== RECORD_KIND ||
    !event.tags.some((tag) => tag[0] === "t" && tag[1] === scopeTag(namespace, table))
  )
    return null;
  try {
    const record: unknown = JSON.parse(event.content);
    if (
      !isObject(record) ||
      record.v !== PROTOCOL_VERSION ||
      record.namespace !== namespace ||
      record.table !== table ||
      typeof record.id !== "string" ||
      !record.id ||
      record.id.length > 512 ||
      !Number.isSafeInteger(record.createdAt) ||
      (record.createdAt as number) < 0 ||
      (record.createdAt as number) > event.created_at ||
      event.tags.find((tag) => tag[0] === "d")?.[1] !==
        recordIdentifier(namespace, table, record.id)
    )
      return null;
    validateData(record.data, definition);
    return {
      ...record.data,
      id: record.id,
      _nostr: {
        pubkey: event.pubkey,
        eventId: event.id,
        createdAt: record.createdAt as number,
        updatedAt: event.created_at,
      },
    } as Row<T>;
  } catch {
    return null;
  }
}
export function rowData<T extends object>(row: Row<T>): T {
  const { id: _id, _nostr: _meta, ...data } = row;
  return data as T;
}
export function deletionTemplate(
  namespace: string,
  table: string,
  events: NostrEvent[],
  timestamp: number,
): EventTemplate {
  return {
    kind: 5,
    created_at: timestamp,
    content: "",
    tags: [
      ["t", scopeTag(namespace, table)],
      ["k", String(RECORD_KIND)],
      ...events.flatMap((event) => [
        ["e", event.id],
        ["a", addressOf(event)],
      ]),
    ],
  };
}
