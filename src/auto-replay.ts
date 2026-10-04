import { asError, NostrbaseError } from "./errors";
import type { AuthChange, Result, Session, WriteReceipt } from "./types";

export interface AutoReplayOptions {
  initial?: boolean;
  retryDelay?: number;
  maxRetryDelay?: number;
  onResult?: (result: Result<WriteReceipt[]>) => void;
  onError?: (error: NostrbaseError, result: Result<WriteReceipt[]>) => void;
}
export interface AutoReplayStatus {
  running: boolean;
  inFlight: boolean;
  failures: number;
  nextRetryAt: number | null;
  lastResult?: Result<WriteReceipt[]>;
}
export interface AutoReplayHost {
  auth: {
    readonly revision: number;
    readonly revisionSignal: AbortSignal;
    readonly revisionSettled: boolean;
    onRevisionSettled(callback: () => void): { unsubscribe(): void };
    getSession(): Promise<Result<Session>>;
    onAuthStateChange(callback: (event: AuthChange, session: Session | null) => void): {
      data: { subscription: { unsubscribe(): void } };
    };
  };
  ready(): Promise<void>;
  signal(signal?: AbortSignal): AbortSignal;
  pending(pubkey: string): Promise<boolean>;
  flush(signal: AbortSignal): Promise<Result<WriteReceipt[]>>;
  watchReconnect?(wake: () => void): () => void;
}

/** One client-owned replay loop. Durable queues remain the source of work. */
export class NostrbaseAutoReplay {
  private options: AutoReplayOptions = {};
  private retryDelay = 1000;
  private maximumDelay = 30000;
  private running = false;
  private dirty = false;
  private failures = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private nextRetryAt: number | null = null;
  private flight?: Promise<void>;
  private controller?: AbortController;
  private disposers: (() => void)[] = [];
  private lastResult?: Result<WriteReceipt[]>;
  private epoch = 0;
  constructor(private readonly host: AutoReplayHost) {}

  get status(): AutoReplayStatus {
    return {
      running: this.running,
      inFlight: !!this.flight,
      failures: this.failures,
      nextRetryAt: this.nextRetryAt,
      lastResult: this.lastResult ? this.snapshot(this.lastResult) : undefined,
    };
  }
  private snapshot(result: Result<WriteReceipt[]>): Result<WriteReceipt[]> {
    return {
      ...result,
      data: result.data ? structuredClone(result.data) : null,
      meta: result.meta ? structuredClone(result.meta) : undefined,
    };
  }
  start(options: AutoReplayOptions = {}): void {
    const delay = options.retryDelay ?? 1000;
    const maximum = options.maxRetryDelay ?? 30000;
    if (
      !Number.isSafeInteger(delay) ||
      delay < 1 ||
      !Number.isSafeInteger(maximum) ||
      maximum < delay ||
      maximum > 2147483647
    )
      throw new NostrbaseError("INVALID_CONFIG", "Check automatic replay retry delays.");
    this.stop();
    this.options = { ...options };
    this.retryDelay = delay;
    this.maximumDelay = maximum;
    this.running = true;
    this.failures = 0;
    const generation = this.epoch;
    const auth = this.host.auth.onAuthStateChange((event, session) => {
      if (!this.running || generation !== this.epoch) return;
      this.controller?.abort();
      this.clearTimer();
      this.failures = 0;
      this.lastResult = undefined;
      if (session && (event !== "INITIAL_SESSION" || options.initial !== false)) this.wake();
    }).data.subscription;
    this.disposers.push(() => auth.unsubscribe());
    const settled = this.host.auth.onRevisionSettled(() => {
      if (!this.running || generation !== this.epoch) return;
      this.lastResult = undefined;
      this.failures = 0;
      this.wake();
    });
    this.disposers.push(() => settled.unsubscribe());
    if (this.host.watchReconnect) this.disposers.push(this.host.watchReconnect(() => this.wake()));
    if (typeof window !== "undefined") {
      const online = () => this.wake();
      window.addEventListener("online", online);
      this.disposers.push(() => window.removeEventListener("online", online));
    }
    if (options.initial !== false) this.wake();
  }
  stop(): void {
    this.running = false;
    this.epoch++;
    this.dirty = false;
    this.clearTimer();
    this.controller?.abort();
    for (const dispose of this.disposers.splice(0)) dispose();
  }
  async idle(): Promise<void> {
    await this.flight;
  }
  wake(): void {
    if (!this.running) return;
    this.dirty = true;
    if (this.flight) return;
    this.schedule(0);
  }
  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.nextRetryAt = null;
  }
  private schedule(delay: number): void {
    this.clearTimer();
    if (!this.running) return;
    this.nextRetryAt = Date.now() + delay;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.nextRetryAt = null;
      if (!this.running || this.flight) return;
      const generation = this.epoch;
      this.flight = this.run(generation).finally(() => {
        this.flight = undefined;
        if (this.running && this.dirty) this.schedule(0);
      });
    }, delay);
  }
  private async run(generation: number): Promise<void> {
    this.dirty = false;
    const controller = new AbortController();
    this.controller = controller;
    const revision = this.host.auth.revision;
    const revisionSignal = this.host.auth.revisionSignal;
    let signal = AbortSignal.any([controller.signal, revisionSignal]);
    const current = () =>
      this.running &&
      generation === this.epoch &&
      revision === this.host.auth.revision &&
      this.host.auth.revisionSettled &&
      !signal.aborted;
    let result: Result<WriteReceipt[]> | undefined;
    try {
      signal = this.host.signal(signal);
      await this.host.ready();
      const session = await this.host.auth.getSession();
      if (!current() || !session.data) return;
      if (session.error) throw session.error;
      if (!(await this.host.pending(session.data.user.pubkey)) || !current()) return;
      result = await this.host.flush(signal);
      if (!current()) return;
      this.lastResult = this.snapshot(result);
      try {
        this.options.onResult?.(this.snapshot(result));
      } catch {
        /* Isolate observers. */
      }
      if (!current()) return;
      if (result.error) {
        try {
          this.options.onError?.(result.error, this.snapshot(result));
        } catch {
          /* Isolate observers. */
        }
      }
      if (!current()) return;
      const pending = await this.host.pending(session.data.user.pubkey);
      if (!current()) return;
      if (pending) {
        if (!result.error && this.dirty) {
          this.failures = 0;
          return;
        }
        this.failures = Math.min(this.failures + 1, 31);
        // New work during a failed run joins its bounded retry instead of bypassing it.
        this.dirty = false;
        this.schedule(Math.min(this.maximumDelay, this.retryDelay * 2 ** (this.failures - 1)));
      } else this.failures = 0;
    } catch (error) {
      if (!current()) return;
      const converted = asError(error);
      const failed: Result<WriteReceipt[]> = result
        ? {
            ...result,
            error: converted,
            meta: { ...result.meta, relays: result.meta?.relays ?? [], partial: true },
          }
        : { data: [], error: converted, meta: { relays: [], partial: true, receipts: [] } };
      this.lastResult = this.snapshot(failed);
      try {
        this.options.onError?.(converted, this.snapshot(failed));
      } catch {
        /* Isolate observers. */
      }
      if (!current()) return;
      this.failures = Math.min(this.failures + 1, 31);
      this.dirty = false;
      this.schedule(Math.min(this.maximumDelay, this.retryDelay * 2 ** (this.failures - 1)));
    } finally {
      if (this.controller === controller) this.controller = undefined;
    }
  }
}
