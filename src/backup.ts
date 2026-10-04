import type { EventStore } from "applesauce-core";
import { asError, NostrbaseError } from "./errors";
import { RECORD_KIND, scopeTag, verify } from "./protocol";
import type { NostrEvent, Result } from "./types";

export interface Backup {
  format: "nostrbase-backup";
  version: 1;
  namespace: string;
  exportedAt: number;
  events: NostrEvent[];
}
export interface BackupImport {
  imported: number;
  duplicates: number;
}
interface BackupHost {
  namespace: string;
  eventStore: EventStore;
  cachedEvents(): NostrEvent[];
  ready(): Promise<void>;
  assertOpen(): void;
  ingest(event: NostrEvent): boolean;
}
export function belongsToNamespace(
  event: NostrEvent,
  namespace: string,
  known: ReadonlySet<string> = new Set(),
): boolean {
  if (event.kind >= 20000 && event.kind < 30000) return false;
  const prefix = `nostrbase:${encodeURIComponent(namespace)}:`;
  if (event.kind === RECORD_KIND)
    return (
      event.tags.some((tag) => tag[0] === "d" && tag[1]?.startsWith(prefix)) &&
      event.tags.some((tag) => tag[0] === "t" && tag[1]?.startsWith(prefix))
    );
  if (event.kind === 5)
    return event.tags.some(
      (tag) =>
        (tag[0] === "t" && tag[1]?.startsWith(prefix)) ||
        (tag[0] === "a" && tag[1]?.startsWith(`${RECORD_KIND}:${event.pubkey}:${prefix}`)) ||
        (tag[0] === "e" && !!tag[1] && known.has(`${event.pubkey}:${tag[1]}`)),
    );
  return event.tags.some((tag) => tag[0] === "t" && tag[1] === scopeTag(namespace, "events"));
}
export class NostrbaseBackup {
  constructor(private host: BackupHost) {}
  async export(): Promise<Result<Backup>> {
    try {
      await this.host.ready();
      this.host.assertOpen();
      const stored = this.host.cachedEvents();
      const known = new Set(
        stored
          .filter(
            (event) => event.kind === RECORD_KIND && belongsToNamespace(event, this.host.namespace),
          )
          .map((event) => `${event.pubkey}:${event.id}`),
      );
      const events = stored.filter(
        (event) => verify(event) && belongsToNamespace(event, this.host.namespace, known),
      );
      return {
        data: {
          format: "nostrbase-backup",
          version: 1,
          namespace: this.host.namespace,
          exportedAt: Date.now(),
          events: structuredClone(events),
        },
        error: null,
        count: events.length,
      };
    } catch (error) {
      return { data: null, error: asError(error) };
    }
  }
  async import(input: Backup | string): Promise<Result<BackupImport>> {
    try {
      await this.host.ready();
      this.host.assertOpen();
      const parsed = typeof input === "string" ? JSON.parse(input) : input;
      if (
        parsed?.format !== "nostrbase-backup" ||
        parsed.version !== 1 ||
        parsed.namespace !== this.host.namespace ||
        !Array.isArray(parsed.events)
      )
        throw new NostrbaseError(
          "INVALID_RECORD",
          "Backup format, version, or namespace is invalid.",
        );
      const events = structuredClone(parsed.events) as NostrEvent[];
      const known = new Set(
        [...this.host.cachedEvents(), ...events]
          .filter(
            (event) =>
              verify(event) &&
              event.kind === RECORD_KIND &&
              belongsToNamespace(event, this.host.namespace),
          )
          .map((event) => `${event.pubkey}:${event.id}`),
      );
      // Validate the whole archive before changing the cache. Never publish imported events.
      for (const event of events)
        if (!verify(event) || !belongsToNamespace(event, this.host.namespace, known))
          throw new NostrbaseError(
            "INVALID_RECORD",
            "Backup contains an invalid signature or an event outside this namespace.",
          );
      let imported = 0;
      let duplicates = 0;
      // Deletes first prevents stale records from appearing during import.
      events.sort(
        (a, b) => Number(b.kind === 5) - Number(a.kind === 5) || a.created_at - b.created_at,
      );
      for (const event of events) {
        if (this.host.eventStore.hasEvent(event.id)) {
          duplicates++;
          continue;
        }
        if (this.host.ingest(event)) imported++;
      }
      return { data: { imported, duplicates }, error: null, count: imported };
    } catch (error) {
      return { data: null, error: asError(error, "INVALID_RECORD") };
    }
  }
}
