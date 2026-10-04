import type { RelayPool } from "applesauce-relay";
import { Observable, Subscription } from "rxjs";
import { NostrbaseError } from "./errors";
import type { Filter, NostrEvent, RelayResult, Transport, TransportRead } from "./types";

export function collect<T>(
  source: Observable<T>,
  timeout: number,
  signal: AbortSignal,
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const subscription = new Subscription();
    const values: T[] = [];
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      subscription.unsubscribe();
      if (error) reject(error);
      else resolve(values);
    };
    const aborted = () => finish(new NostrbaseError("ABORTED", "Operation was aborted."));
    const timer = setTimeout(
      () =>
        finish(new NostrbaseError("RELAY_ERROR", `Relay did not complete within ${timeout} ms.`)),
      timeout,
    );
    if (signal.aborted) {
      aborted();
      return;
    }
    signal.addEventListener("abort", aborted, { once: true });
    subscription.add(
      source.subscribe({
        next: (value) => values.push(value),
        error: finish,
        complete: () => finish(),
      }),
    );
  });
}

/** Applesauce owns connection reuse, Nostr wire messages, and reconnect behavior. */
export class ApplesauceTransport implements Transport {
  constructor(readonly pool: RelayPool) {}
  async request(
    relays: string[],
    filters: Filter[],
    options: { timeout: number; signal: AbortSignal },
  ): Promise<TransportRead> {
    const results = await Promise.allSettled(
      relays.map((url) =>
        collect(
          this.pool
            .relay(url)
            .request(filters, { timeout: options.timeout, reconnect: false, waitForAuth: false }),
          options.timeout,
          options.signal,
        ),
      ),
    );
    const events: NostrEvent[] = [];
    const statuses: RelayResult[] = results.map((result, index) => {
      const url = relays[index] as string;
      if (result.status === "fulfilled") {
        events.push(...result.value);
        return { url, ok: true };
      }
      return {
        url,
        ok: false,
        message: result.reason instanceof Error ? result.reason.message : String(result.reason),
      };
    });
    if (options.signal.aborted) throw new NostrbaseError("ABORTED", "Operation was aborted.");
    return { events, relays: statuses };
  }
  async publish(
    relays: string[],
    event: NostrEvent,
    options: { timeout: number; signal: AbortSignal },
  ): Promise<RelayResult[]> {
    // Use event() so a rejected write is reported without retrying an identical invalid event.
    const results = await Promise.allSettled(
      relays.map((url) =>
        collect(this.pool.relay(url).event(event), options.timeout, options.signal),
      ),
    );
    return results.map((result, index) => {
      const url = relays[index] as string;
      if (result.status === "fulfilled" && result.value[0])
        return { url, ok: result.value[0].ok, message: result.value[0].message };
      return {
        url,
        ok: false,
        message:
          result.status === "rejected" && result.reason instanceof Error
            ? result.reason.message
            : "Relay did not acknowledge the event.",
      };
    });
  }
  subscribe(relays: string[], filters: Filter[]): Observable<NostrEvent> {
    // Unlike pool.subscription(), req() exposes relay failures and CLOSED messages.
    return new Observable((observer) =>
      this.pool.req(relays, filters, { waitForAuth: false, reconnect: 3 }).subscribe({
        next: (message) => {
          if (message.type === "EVENT") observer.next(message.event);
          else if (message.type === "ERROR") observer.error(message.error);
          else if (message.type === "CLOSED")
            observer.error(new NostrbaseError("RELAY_ERROR", message.reason));
        },
        error: (error) => observer.error(error),
        complete: () => observer.complete(),
      }),
    );
  }
}
