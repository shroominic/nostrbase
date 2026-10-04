import { PrivateKeySigner } from "applesauce-signers";
import { matchFilters } from "nostr-tools";
import { Observable, Subject } from "rxjs";
import type {
  ClientOptions,
  Filter,
  NostrEvent,
  RelayResult,
  Transport,
  TransportRead,
} from "../src";
import { createClient } from "../src";

export type TestDB = {
  todos: {
    title: string;
    done: boolean;
    priority?: number;
    labels?: string[];
    details?: { note: string };
  };
  projects: { name: string };
};
export const alice = new PrivateKeySigner(new Uint8Array(32).fill(1));
export const bob = new PrivateKeySigner(new Uint8Array(32).fill(2));
export class MemoryTransport implements Transport {
  events: NostrEvent[] = [];
  live = new Subject<NostrEvent>();
  requests: Filter[][] = [];
  published: NostrEvent[] = [];
  readFailure = false;
  failPublishAt = -1;
  publishStatuses?: RelayResult[];
  readStatuses?: RelayResult[];
  activeSubscriptions = 0;
  async request(
    relays: string[],
    filters: Filter[],
    options: { signal: AbortSignal },
  ): Promise<TransportRead> {
    this.requests.push(filters);
    if (options.signal.aborted) throw new Error("aborted");
    return {
      events: this.readFailure ? [] : this.events.filter((event) => matchFilters(filters, event)),
      relays:
        this.readStatuses ??
        relays.map((url) => ({
          url,
          ok: !this.readFailure,
          message: this.readFailure ? "offline" : undefined,
        })),
    };
  }
  async publish(relays: string[], event: NostrEvent): Promise<RelayResult[]> {
    this.published.push(event);
    const statuses =
      this.published.length === this.failPublishAt
        ? relays.map((url) => ({ url, ok: false, message: "blocked" }))
        : (this.publishStatuses ?? relays.map((url) => ({ url, ok: true })));
    if (statuses.some((status) => status.ok)) {
      this.events.push(event);
      this.live.next(event);
    }
    return statuses;
  }
  subscribe(_relays: string[], filters: Filter[]): Observable<NostrEvent> {
    return new Observable((observer) => {
      this.activeSubscriptions++;
      const sub = this.live.subscribe({
        next: (event) => {
          if (matchFilters(filters, event)) observer.next(event);
        },
        error: (error) => observer.error(error),
      });
      return () => {
        this.activeSubscriptions--;
        sub.unsubscribe();
      };
    });
  }
}
export function setup(options: Partial<ClientOptions<TestDB>> = {}) {
  const transport = options.transport ?? new MemoryTransport();
  const client = createClient<TestDB>({
    namespace: "test-app",
    relays: ["wss://relay.test"],
    signer: alice,
    transport,
    schema: {
      todos: {
        indexes: ["done"],
        validate: (data): data is TestDB["todos"] =>
          typeof data === "object" &&
          data !== null &&
          typeof (data as TestDB["todos"]).title === "string" &&
          typeof (data as TestDB["todos"]).done === "boolean",
      },
      projects: {},
    },
    ...options,
  });
  return { client, transport: transport as MemoryTransport };
}
