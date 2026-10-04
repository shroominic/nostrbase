import { matchFilters } from "nostr-tools";
import { Subscription } from "rxjs";
import { asError, NostrbaseError } from "./errors";
import { verify } from "./protocol";
import type {
  EventTemplate,
  Filter,
  NostrEvent,
  Result,
  Transport,
  TransportRead,
  WriteReceipt,
} from "./types";

interface EventHost {
  relays: string[];
  transport: Transport;
  minWriteAcks: number;
  request(filters: Filter[], signal?: AbortSignal): Promise<TransportRead>;
  sign(template: EventTemplate): Promise<NostrEvent>;
  publish(event: NostrEvent, signal?: AbortSignal): Promise<WriteReceipt>;
  ingest(event: NostrEvent): boolean;
  assertOpen(): void;
  trackEventSubscription(dispose: () => void): () => void;
}
/** Escape hatch for standard Nostr kinds, filters, profiles, and protocol-specific apps. */
export class NostrbaseEvents {
  constructor(private client: EventHost) {}
  /** NIP-50 search. Results depend on the configured relays' search support. */
  async search(
    query: string,
    filter: Filter = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<Result<NostrEvent[]>> {
    if (typeof query !== "string" || !query.trim())
      return {
        data: null,
        error: new NostrbaseError("INVALID_QUERY", "Search text cannot be empty."),
      };
    return this.query({ ...filter, search: query }, options);
  }
  async query(
    filter: Filter | Filter[],
    options: { signal?: AbortSignal } = {},
  ): Promise<Result<NostrEvent[]>> {
    try {
      const response = await this.client.request(
        Array.isArray(filter) ? filter : [filter],
        options.signal,
      );
      const events = [...new Map(response.events.map((event) => [event.id, event])).values()];
      return {
        data: events,
        error: null,
        count: events.length,
        meta: { relays: response.relays, partial: response.relays.some((relay) => !relay.ok) },
      };
    } catch (error) {
      return { data: null, error: asError(error) };
    }
  }
  async publish(
    template: EventTemplate,
    options: { signal?: AbortSignal } = {},
  ): Promise<Result<NostrEvent>> {
    try {
      return await this.publishSigned(await this.client.sign(template), options);
    } catch (error) {
      return { data: null, error: asError(error) };
    }
  }
  async publishSigned(
    event: NostrEvent,
    options: { signal?: AbortSignal } = {},
  ): Promise<Result<NostrEvent>> {
    try {
      const signed = structuredClone(event);
      if (!verify(signed))
        throw new NostrbaseError("INVALID_RECORD", "Event signature is invalid.");
      const receipt = await this.client.publish(signed, options.signal);
      const accepted = receipt.relays.filter((relay) => relay.ok).length;
      return {
        data: accepted ? signed : null,
        error:
          accepted >= this.client.minWriteAcks
            ? null
            : new NostrbaseError("PUBLISH_FAILED", "Publish did not meet minWriteAcks.", receipt),
        meta: {
          relays: receipt.relays,
          partial: accepted > 0 && accepted < receipt.relays.length,
          receipts: [receipt],
        },
      };
    } catch (error) {
      return { data: null, error: asError(error) };
    }
  }
  subscribe(
    filter: Filter | Filter[],
    callback: (event: NostrEvent) => void,
    onError?: (error: NostrbaseError) => void,
  ): { unsubscribe(): void } {
    this.client.assertOpen();
    const filters = Array.isArray(filter) ? filter : [filter];
    const seen = new Set<string>();
    const source = this.client.transport.subscribe(this.client.relays, filters);
    const subscription = new Subscription();
    const untrack = this.client.trackEventSubscription(() => subscription.unsubscribe());
    subscription.add(untrack);
    const reportError = (error: unknown) => {
      try {
        onError?.(asError(error));
      } catch {
        /* Isolate observers. */
      }
    };
    subscription.add(
      source.subscribe({
        next: (event) => {
          if (!verify(event) || !matchFilters(filters, event) || seen.has(event.id)) return;
          seen.add(event.id);
          this.client.ingest(event);
          try {
            callback(structuredClone(event));
          } catch (error) {
            reportError(error);
          }
        },
        error: (error) => {
          reportError(error);
          subscription.unsubscribe();
        },
        complete: () => subscription.unsubscribe(),
      }),
    );
    return { unsubscribe: () => subscription.unsubscribe() };
  }
}
