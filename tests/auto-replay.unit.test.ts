import { afterEach, describe, expect, it, vi } from "vitest";
import { NostrbaseAuth } from "../src/auth";
import { NostrbaseAutoReplay } from "../src/auto-replay";
import { NostrbaseError } from "../src/errors";
import type { Result, WriteReceipt } from "../src/types";
import { alice, bob } from "./helpers";
import { deferred } from "./support/lifecycle";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function fixture() {
  vi.useFakeTimers();
  const auth = new NostrbaseAuth(alice);
  await auth.getSession();
  let pending = true;
  let flush: (signal: AbortSignal) => Promise<Result<WriteReceipt[]>> = async () => {
    pending = false;
    return { data: [], error: null };
  };
  let reconnect: (() => void) | undefined;
  const calls: AbortSignal[] = [];
  const replay = new NostrbaseAutoReplay({
    auth,
    ready: async () => {},
    signal: (signal) => signal ?? new AbortController().signal,
    pending: async () => pending,
    flush: async (signal) => {
      calls.push(signal);
      return flush(signal);
    },
    watchReconnect: (wake) => {
      reconnect = wake;
      return () => {
        reconnect = undefined;
      };
    },
  });
  cleanups.push(() => {
    replay.stop();
    auth.dispose();
  });
  return {
    auth,
    replay,
    calls,
    setPending: (value: boolean) => {
      pending = value;
    },
    setFlush: (value: typeof flush) => {
      flush = value;
    },
    reconnect: () => reconnect?.(),
  };
}

describe("automatic queue replay coordinator", () => {
  it("runs once initially, coalesces wakes, and stays idle when no work remains", async () => {
    const f = await fixture();
    f.replay.start();
    f.replay.wake();
    f.reconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls).toHaveLength(1);
    expect(f.replay.status).toMatchObject({ inFlight: false, failures: 0, nextRetryAt: null });
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.calls).toHaveLength(1);
  });

  it("uses capped exponential retry delays and preserves partial receipts in observers", async () => {
    const f = await fixture();
    const observed: Result<WriteReceipt[]>[] = [];
    const receipt: WriteReceipt = {
      id: "x",
      eventId: "x",
      relays: [
        { url: "wss://r.test", ok: true },
        { url: "wss://s.test", ok: false },
      ],
    };
    f.setFlush(async () => ({
      data: [receipt],
      error: new NostrbaseError("PUBLISH_FAILED", "insufficient acknowledgements"),
      meta: { relays: receipt.relays, partial: true, receipts: [receipt] },
    }));
    f.replay.start({
      retryDelay: 100,
      maxRetryDelay: 250,
      onError: (_, result) => observed.push(result),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(f.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(199);
    expect(f.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(249);
    expect(f.calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.calls).toHaveLength(4);
    expect(observed[0]?.data).toEqual([receipt]);
    expect(f.replay.status.failures).toBe(4);
    f.replay.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps one flight and discards stale work when a same-key signer revision starts", async () => {
    const f = await fixture();
    const entered = deferred();
    const finish = deferred<Result<WriteReceipt[]>>();
    f.setFlush(async () => {
      entered.resolve();
      return finish.promise;
    });
    f.replay.start();
    await vi.advanceTimersByTimeAsync(0);
    await entered.promise;
    f.replay.wake();
    f.replay.wake();
    expect(f.calls).toHaveLength(1);
    const identity = deferred<string>();
    const login = f.auth.signInWithSigner({
      getPublicKey: () => identity.promise,
      signEvent: (event) => alice.signEvent(event),
    });
    expect(f.calls[0]?.aborted).toBe(true);
    f.replay.stop();
    finish.resolve({ data: [], error: null });
    await f.replay.idle();
    identity.resolve(await alice.getPublicKey());
    await login;
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.calls).toHaveLength(1);
    expect(f.replay.status.lastResult).toBeUndefined();
  });

  it("waits for sign-in, filters auth transitions, and disposes reconnect listeners on stop", async () => {
    const f = await fixture();
    await f.auth.signOut();
    f.replay.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    await f.auth.signInWithSigner(bob);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls).toHaveLength(1);
    f.replay.stop();
    f.setPending(true);
    f.reconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls).toHaveLength(1);
  });

  it("wakes on browser online and removes the browser listener on stop", async () => {
    const browser = new EventTarget();
    vi.stubGlobal("window", browser);
    const f = await fixture();
    f.replay.start({ initial: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls).toHaveLength(0);
    browser.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls).toHaveLength(1);
    f.setPending(true);
    f.replay.stop();
    browser.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls).toHaveLength(1);
  });

  it("waits for a failed replacement signer to settle, then resumes the retained account", async () => {
    const f = await fixture();
    const finish = deferred<Result<WriteReceipt[]>>();
    f.setFlush(async () => finish.promise);
    f.replay.start();
    await vi.advanceTimersByTimeAsync(0);
    const identity = deferred<string>();
    const login = f.auth.signInWithSigner({
      getPublicKey: () => identity.promise,
      signEvent: (event) => alice.signEvent(event),
    });
    expect(f.calls[0]?.aborted).toBe(true);
    finish.resolve({ data: [], error: new NostrbaseError("ABORTED", "canceled") });
    await f.replay.idle();
    f.replay.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls).toHaveLength(1);
    expect(f.replay.status.lastResult).toBeUndefined();
    f.setFlush(async () => {
      f.setPending(false);
      return { data: [], error: null };
    });
    identity.reject(new Error("signer denied"));
    expect((await login).error?.code).toBe("AUTH_FAILED");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls).toHaveLength(2);
    expect((await f.auth.getSession()).data?.user.pubkey).toBe(await alice.getPublicKey());
  });

  it("rejects unsafe delays and isolates observer mutation/failure", async () => {
    const f = await fixture();
    expect(() => f.replay.start({ retryDelay: 0 })).toThrowError(/retry delays/);
    expect(() => f.replay.start({ maxRetryDelay: 2147483648 })).toThrowError(/retry delays/);
    f.replay.start({
      onResult: (result) => {
        result.data?.push({ id: "mutated", eventId: "mutated", relays: [] });
        throw new Error("observer failed");
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.replay.status.lastResult?.data).toEqual([]);
    expect(f.calls).toHaveLength(1);
  });

  it("does not deliver an old failure to the new loop after onResult restarts replay", async () => {
    const f = await fixture();
    const newError = vi.fn();
    let attempts = 0;
    f.setFlush(async () => {
      attempts++;
      if (attempts === 1)
        return { data: [], error: new NostrbaseError("PUBLISH_FAILED", "old failure") };
      f.setPending(false);
      return { data: [], error: null };
    });
    f.replay.start({
      onResult: () => {
        f.replay.stop();
        f.replay.start({ onError: newError });
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(newError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.calls).toHaveLength(2);
    expect(newError).not.toHaveBeenCalled();
  });
});

it("does not overwrite a new replay epoch from an old catch observer", async () => {
  vi.useFakeTimers();
  let calls = 0;
  const signal = new AbortController().signal;
  const replay = new NostrbaseAutoReplay({
    auth: {
      revision: 1,
      revisionSignal: signal,
      revisionSettled: true,
      onRevisionSettled: () => ({ unsubscribe() {} }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      getSession: async () => ({ data: { user: { id: "a", pubkey: "a" } }, error: null }),
    },
    ready: async () => {},
    signal: (signal) => signal ?? new AbortController().signal,
    pending: async () => true,
    flush: async () => {
      calls++;
      throw new Error("transport failed");
    },
  });
  try {
    replay.start({
      retryDelay: 100,
      onError: () => {
        replay.stop();
        replay.start({ retryDelay: 1000 });
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(replay.status.failures).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(2);
  } finally {
    replay.stop();
    vi.useRealTimers();
  }
});
