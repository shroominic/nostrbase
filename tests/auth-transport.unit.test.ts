import { Observable, Subject } from "rxjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NostrbaseAuth } from "../src/auth";
import { collect } from "../src/transport";
import { alice, bob } from "./helpers";
import { deferred } from "./support/lifecycle";

afterEach(() => vi.useRealTimers());

describe("signer session races", () => {
  it("keeps the latest sign-in when public keys resolve in reverse order", async () => {
    const auth = new NostrbaseAuth();
    const key = deferred<string>();
    const old = auth.signInWithSigner({
      getPublicKey: () => key.promise,
      signEvent: alice.signEvent.bind(alice),
    });
    expect((await auth.signInWithSigner(bob)).error).toBeNull();
    key.resolve(await alice.getPublicKey());
    expect((await old).error?.code).toBe("AUTH_FAILED");
    expect((await auth.requireSigner()).session.user.pubkey).toBe(await bob.getPublicKey());
    auth.dispose();
  });

  it("preserves a working session if the replacement signer rejects", async () => {
    const auth = new NostrbaseAuth(alice);
    await auth.getSession();
    const replacement = await auth.signInWithSigner({
      getPublicKey: async () => {
        throw new Error("locked");
      },
      signEvent: bob.signEvent.bind(bob),
    });
    expect(replacement.error?.code).toBe("AUTH_FAILED");
    expect((await auth.requireSigner()).signer).toBe(alice);
    auth.dispose();
  });

  it("isolates observer errors and suppresses a removed initial callback", async () => {
    const auth = new NostrbaseAuth();
    const removed = vi.fn();
    const listener = auth.onAuthStateChange(removed);
    listener.data.subscription.unsubscribe();
    auth.onAuthStateChange(() => {
      throw new Error("observer");
    });
    const seen: string[] = [];
    auth.onAuthStateChange((type) => seen.push(type));
    expect((await auth.signInWithSigner(alice)).error).toBeNull();
    await auth.signOut();
    expect(seen).toContain("SIGNED_IN");
    expect(seen).toContain("SIGNED_OUT");
    expect(removed).not.toHaveBeenCalled();
    auth.dispose();
  });

  it("disposal invalidates a pending sign-in and rejects new observers", async () => {
    const key = deferred<string>();
    const auth = new NostrbaseAuth();
    const pending = auth.signInWithSigner({
      getPublicKey: () => key.promise,
      signEvent: alice.signEvent.bind(alice),
    });
    auth.dispose();
    key.resolve(await alice.getPublicKey());
    expect((await pending).error?.code).toBe("AUTH_FAILED");
    expect((await auth.getSession()).data).toBeNull();
    expect(() => auth.onAuthStateChange(() => {})).toThrow(/closed/);
  });
});

describe("bounded observable collection", () => {
  it("handles synchronous completion and error with exactly one teardown", async () => {
    vi.useFakeTimers();
    for (const fail of [false, true]) {
      const teardown = vi.fn();
      const error = new Error("wire failure");
      const pending = collect(
        new Observable<number>((observer) => {
          observer.next(1);
          if (fail) observer.error(error);
          else {
            observer.next(2);
            observer.complete();
          }
          return teardown;
        }),
        100,
        new AbortController().signal,
      );
      if (fail) await expect(pending).rejects.toBe(error);
      else expect(await pending).toEqual([1, 2]);
      expect(teardown).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it("never subscribes when the caller has already cancelled", async () => {
    vi.useFakeTimers();
    const subscribe = vi.fn();
    const controller = new AbortController();
    controller.abort();
    await expect(collect(new Observable(subscribe), 100, controller.signal)).rejects.toMatchObject({
      code: "ABORTED",
    });
    expect(subscribe).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("enforces an absolute deadline even while values continue arriving", async () => {
    vi.useFakeTimers();
    const source = new Subject<number>();
    const pending = collect(source, 100, new AbortController().signal);
    const failure = expect(pending).rejects.toMatchObject({ code: "RELAY_ERROR" });
    for (let time = 0; time < 4; time++) {
      source.next(time);
      await vi.advanceTimersByTimeAsync(25);
    }
    await failure;
    expect(source.observed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("removes the abort listener and subscription on in-flight cancellation", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const source = new Subject();
    const pending = collect(source, 100, controller.signal);
    const failure = expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    controller.abort();
    await failure;
    expect(source.observed).toBe(false);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });
});
