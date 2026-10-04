import { verifiedSymbol, verifyEvent } from "nostr-tools";
import { Subject } from "rxjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NostrbaseAuth } from "../src/auth";
import { NostrbaseError } from "../src/errors";
import type { GroupNetworkHost, GroupOutboxEntry } from "../src/group-network";
import { GroupNetwork, GroupNetworkPublicationError } from "../src/group-network";
import { EncryptedGroupStore, MemoryGroupStateAdapter } from "../src/group-store";
import type { Filter, NostrEvent, RelayResult, Transport } from "../src/types";
import { alice, bob, MemoryTransport } from "./helpers";

const resources: {
  network: GroupNetwork;
  adapter: MemoryGroupStateAdapter;
  auth: NostrbaseAuth;
}[] = [];
const relayA = "wss://relay-a.test/";
const relayB = "wss://relay-b.test/";
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected fixture value is missing.");
  return value;
}
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(options: Partial<GroupNetworkHost> = {}) {
  const auth = new NostrbaseAuth(alice);
  const session = await auth.getSession();
  const account = session.data?.user.pubkey;
  if (!account) throw new Error("Sign-in failed");
  const revision = auth.revision;
  const lifetime = new AbortController();
  const guard = async () => {
    if (lifetime.signal.aborted) throw new NostrbaseError("CLIENT_CLOSED", "Client closed.");
    const current = await auth.getSession();
    if (auth.revision !== revision || current.data?.user.pubkey !== account)
      throw new NostrbaseError("AUTH_FAILED", "Group account changed.");
  };
  const adapter = new MemoryGroupStateAdapter();
  const store = new EncryptedGroupStore<GroupOutboxEntry>(
    adapter,
    { namespace: "network-test", account, device: "a".repeat(64), bucket: "outbox" },
    alice,
    guard,
  );
  const transport = new MemoryTransport();
  const host: GroupNetworkHost = {
    transport,
    relays: [relayA, relayB],
    timeout: 1000,
    minWriteAcks: 1,
    guard,
    signal: (signal) => (signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal),
    ...options,
  };
  const network = new GroupNetwork(host, store);
  resources.push({ network, adapter, auth });
  return { network, host, store, adapter, transport, auth, lifetime };
}
async function envelope(
  content = "encrypted-envelope",
  tags: string[][] = [],
): Promise<NostrEvent> {
  // Marmot's outer envelope author can be an ephemeral key, rather than the active account.
  return bob.signEvent({
    kind: 445,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["h", "group-route"], ...tags],
    content,
  });
}
afterEach(async () => {
  for (const { network, adapter, auth } of resources.splice(0)) {
    network.dispose();
    adapter.close();
    auth.dispose();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Marmot transport adapter", () => {
  it("clones and verifies inbound events, rejects a forged verification cache, and applies query filters", async () => {
    const { network, transport } = await fixture();
    const valid = await envelope();
    verifyEvent(valid);
    const invalid = { ...valid, content: "forged", [verifiedSymbol]: true };
    const wrongRoute = await envelope("other", [["h", "other-route"]]);
    const unsigned = { ...valid, pubkey: "invalid" };
    const live = new Subject<NostrEvent>();
    vi.spyOn(transport, "request").mockResolvedValue({
      events: [invalid, unsigned, wrongRoute, valid, valid],
      relays: [{ url: relayA, ok: true }],
    });
    vi.spyOn(transport, "subscribe").mockReturnValue(live);
    const filter: Filter = { kinds: [445], ids: [valid.id] };
    const read = await network.request([relayA], filter);
    expect(read.map((event) => event.id)).toEqual([valid.id]);
    required(read[0]).content = "caller mutation";
    expect(valid.content).toBe("encrypted-envelope");
    const next = vi.fn();
    const subscription = network.subscription([relayA], filter).subscribe({ next });
    await vi.waitFor(() => expect(transport.subscribe).toHaveBeenCalledOnce());
    live.next(invalid);
    live.next(unsigned);
    live.next(wrongRoute);
    live.next(valid);
    await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
    expect(next.mock.calls[0]?.[0].pubkey).toBe(await bob.getPublicKey());
    required(next.mock.calls[0])[0].content = "observer mutation";
    expect(valid.content).toBe("encrypted-envelope");
    subscription.unsubscribe();
  });

  it("normalizes explicit relay URLs and refuses unconfigured endpoints and invalid inbox pubkeys", async () => {
    const { network, transport } = await fixture();
    const event = await envelope();
    const result = await network.publish(["wss://relay-a.test", relayA], event);
    expect(Object.keys(result)).toEqual([relayA]);
    expect(result[relayA]).toEqual({ from: relayA, ok: true });
    await expect(network.request(["wss://unconfigured.test"], {})).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    await expect(network.publish(["https://relay-a.test"], event)).rejects.toMatchObject({
      code: "INVALID_QUERY",
    });
    await expect(network.getUserInboxRelays("bad")).rejects.toMatchObject({
      code: "INVALID_QUERY",
    });
    expect(transport.requests).toEqual([]);
  });

  it("uses only the latest signed recipient inbox event and falls back only when absent", async () => {
    const { network, transport } = await fixture();
    const pubkey = await bob.getPublicKey();
    expect(await network.getUserInboxRelays(pubkey)).toEqual([relayA, relayB]);
    const old = await bob.signEvent({
      kind: 10050,
      created_at: 100,
      content: "",
      tags: [["relay", relayA]],
    });
    const latest = await bob.signEvent({
      kind: 10050,
      created_at: 101,
      content: "",
      tags: [["relay", "wss://relay-b.test"]],
    });
    transport.events.push(old, latest);
    expect(await network.getUserInboxRelays(pubkey)).toEqual([relayB]);
    const outside = await bob.signEvent({
      kind: 10050,
      created_at: 102,
      content: "",
      tags: [["relay", "wss://recipient-private.test"]],
    });
    transport.events.push(outside);
    await expect(network.getUserInboxRelays(pubkey)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    const empty = await bob.signEvent({ kind: 10050, created_at: 103, content: "", tags: [] });
    transport.events.push(empty);
    await expect(network.getUserInboxRelays(pubkey)).rejects.toMatchObject({
      code: "INVALID_QUERY",
    });
  });

  it("persists exact envelopes before publication, keeps partial acks, and replays only rejected targets after restart", async () => {
    const { network, store, adapter, transport, host } = await fixture({ minWriteAcks: 2 });
    const event = await envelope();
    const calls: string[][] = [];
    vi.spyOn(transport, "publish").mockImplementation(async (targets, signed) => {
      calls.push(targets);
      expect((await store.getItem(signed.id))?.event).toEqual(structuredClone(event));
      return targets.map((url) => ({
        url,
        ok: url === relayA,
        message: url === relayA ? "stored" : "blocked",
      }));
    });
    const result = await network.publish([relayA, relayB], event);
    expect(result[relayA]?.ok).toBe(true);
    expect(result[relayB]?.ok).toBe(false);
    expect(network.receiptResult(event.id).error?.code).toBe("PUBLISH_FAILED");
    const pending = await network.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.targets).toEqual([relayA, relayB]);
    const raw = await adapter.get(required((await adapter.keys())[0]));
    expect(raw).not.toContain(event.content);
    expect(raw).not.toContain(event.id);
    network.close();
    const restarted = new GroupNetwork(host, store);
    resources.push({ network: restarted, adapter, auth: new NostrbaseAuth() });
    vi.mocked(transport.publish).mockImplementation(async (targets, signed) => {
      calls.push(targets);
      expect(signed).toEqual(structuredClone(event));
      return targets.map((url) => ({ url, ok: true, message: "retry stored" }));
    });
    const flushed = await restarted.flushPending();
    expect(flushed.error).toBeNull();
    expect(flushed.data?.[0]?.relays.map((relay) => relay.ok)).toEqual([true, true]);
    expect(calls).toEqual([[relayA, relayB], [relayB]]);
    expect(await restarted.listPending()).toEqual([]);
  });

  it("does not send envelopes before durable outbox and group-state hooks succeed", async () => {
    const beforePublish = vi.fn(async () => {
      throw new Error("ratchet save failed");
    });
    const { network, store, transport } = await fixture({ beforePublish });
    const event = await envelope();
    const save = vi.spyOn(store, "setItem").mockRejectedValueOnce(new Error("disk full"));
    await expect(network.publish([relayA], event)).rejects.toThrow("disk full");
    expect(transport.published).toEqual([]);
    expect(beforePublish).not.toHaveBeenCalled();
    save.mockRestore();
    await expect(network.publish([relayA], event)).rejects.toThrow("ratchet save failed");
    expect(transport.published).toEqual([]);
    expect((await store.getItem(event.id))?.event).toEqual(structuredClone(event));
  });

  it("returns true engine acks and preserves SDK receipts when post-publication persistence fails", async () => {
    const { network, store } = await fixture();
    const event = await envelope();
    const original = store.setItem.bind(store);
    let writes = 0;
    vi.spyOn(store, "setItem").mockImplementation(async (key, value) => {
      if (++writes === 2) throw new Error("disk failed after relay accepted");
      return original(key, value);
    });
    const response = await network.publish([relayA], event);
    expect(response[relayA]?.ok).toBe(true);
    const result = network.receiptResult(event.id);
    expect(result.data?.relays).toEqual([{ url: relayA, ok: true }]);
    expect(result.error).toBeInstanceOf(GroupNetworkPublicationError);
    expect((result.error as GroupNetworkPublicationError).context.durable).toBe(false);
    expect((await store.getItem(event.id))?.event.id).toBe(event.id);
    await network.listPending();
    expect(network.receipt(event.id)?.relays[0]?.ok).toBe(true);
    required(result.data?.relays[0]).ok = false;
    expect(network.receipt(event.id)?.relays[0]?.ok).toBe(true);
  });

  it("records WAL response before engine ack, preserving real receipts if the WAL hook fails", async () => {
    const hook = vi.fn(async (_event: NostrEvent, _response: Record<string, { ok: boolean }>) => {
      throw new Error("WAL write failed");
    });
    const { network, store } = await fixture({ afterPublish: hook });
    const event = await envelope();
    const result = await network.publish([relayA], event);
    expect(hook).toHaveBeenCalledWith(structuredClone(event), {
      [relayA]: { from: relayA, ok: true },
    });
    expect(result[relayA]?.ok).toBe(true);
    expect(network.receiptResult(event.id).error).toBeInstanceOf(GroupNetworkPublicationError);
    expect((await store.getItem(event.id))?.relays).toEqual([]);
  });

  it("stops after a bound auth revision changes during persistence or read, including same-key signer changes", async () => {
    const { network, store, transport, auth } = await fixture();
    const event = await envelope();
    const gate = deferred();
    const entered = deferred();
    const original = store.setItem.bind(store);
    vi.spyOn(store, "setItem").mockImplementation(async (key, value) => {
      entered.resolve();
      await gate.promise;
      return original(key, value);
    });
    const publication = network.publish([relayA], event);
    const rejected = expect(publication).rejects.toMatchObject({ code: "AUTH_FAILED" });
    await entered.promise;
    await auth.signInWithSigner(alice);
    gate.resolve();
    await rejected;
    expect(transport.published).toEqual([]);
    const next = await fixture();
    const readGate = deferred();
    const readEntered = deferred();
    vi.spyOn(next.transport, "request").mockImplementation(async () => {
      readEntered.resolve();
      await readGate.promise;
      return { events: [event], relays: [{ url: relayA, ok: true }] };
    });
    const request = next.network.request([relayA], { kinds: [445] });
    const stale = expect(request).rejects.toMatchObject({ code: "AUTH_FAILED" });
    await readEntered.promise;
    await next.auth.signInWithSigner(bob);
    readGate.resolve();
    await stale;
  });

  it("preserves actual relay acceptance after an account changes during network publication", async () => {
    const { network, transport, auth } = await fixture();
    const gate = deferred();
    const entered = deferred();
    vi.spyOn(transport, "publish").mockImplementation(async () => {
      entered.resolve();
      await gate.promise;
      return [{ url: relayA, ok: true }];
    });
    const event = await envelope();
    const pending = network.publish([relayA], event);
    await entered.promise;
    await auth.signOut();
    gate.resolve();
    const response = await pending;
    expect(response[relayA]?.ok).toBe(true);
    expect(network.receiptResult(event.id).data?.relays[0]?.ok).toBe(true);
    expect(network.receiptResult(event.id).error).toBeInstanceOf(GroupNetworkPublicationError);
  });

  it("aborts uncooperative reads, cleans subscriptions, and avoids hiding a partial ack on cancellation", async () => {
    const { network, transport, lifetime } = await fixture();
    vi.spyOn(transport, "request").mockImplementation(async () => new Promise(() => {}));
    const request = network.request([relayA], {});
    const cancelled = expect(request).rejects.toMatchObject({ code: "ABORTED" });
    await vi.waitFor(() => expect(transport.request).toHaveBeenCalledOnce());
    lifetime.abort();
    await cancelled;
    const next = await fixture();
    const received = vi.fn();
    const errors = vi.fn();
    next.network.subscription([relayA], {}).subscribe({ next: received, error: errors });
    await vi.waitFor(() => expect(next.transport.activeSubscriptions).toBe(1));
    next.network.close();
    expect(next.transport.activeSubscriptions).toBe(0);
    expect(errors).toHaveBeenCalledOnce();
    const last = await fixture();
    const entered = deferred();
    vi.spyOn(last.transport as Transport, "publish").mockImplementation(
      async (_relays, _event, options) => {
        entered.resolve();
        return new Promise<RelayResult[]>((resolve) =>
          options.signal.addEventListener(
            "abort",
            () =>
              resolve([
                { url: relayA, ok: true },
                { url: relayB, ok: false, message: "aborted" },
              ]),
            { once: true },
          ),
        );
      },
    );
    const event = await envelope();
    const publication = last.network.publish([relayA, relayB], event);
    await entered.promise;
    last.lifetime.abort();
    const response = await publication;
    expect(response[relayA]?.ok).toBe(true);
    expect(response[relayB]?.ok).toBe(false);
    expect(last.network.receipt(event.id)?.relays.map((relay) => relay.ok)).toEqual([true, false]);
  });

  it("leaves expired signed envelopes pending with errors and never publishes them", async () => {
    const { network, transport } = await fixture();
    const event = await envelope("expired", [
      ["expiration", String(Math.floor(Date.now() / 1000) - 1)],
    ]);
    await expect(network.publish([relayA], event)).rejects.toMatchObject({
      code: "PUBLISH_FAILED",
      context: { stage: "expired" },
    });
    expect(transport.published).toEqual([]);
    const flushed = await network.flushPending();
    expect(flushed.error?.code).toBe("PUBLISH_FAILED");
    expect(flushed.data?.[0]?.eventId).toBe(event.id);
    expect(transport.published).toEqual([]);
    expect(await network.listPending()).toHaveLength(1);
  });

  it("does not serialize inbound subscriptions behind a blocked publication", async () => {
    const { network, transport } = await fixture();
    const gate = deferred();
    const entered = deferred();
    vi.spyOn(transport, "publish").mockImplementation(async (targets) => {
      entered.resolve();
      await gate.promise;
      return targets.map((url) => ({ url, ok: true }));
    });
    const sent = await envelope("sending");
    const pending = network.publish([relayA], sent);
    await entered.promise;
    const next = vi.fn();
    const subscription = network.subscription([relayA], { kinds: [445] }).subscribe({ next });
    try {
      await vi.waitFor(() => expect(transport.activeSubscriptions).toBe(1));
      transport.live.next(await envelope("incoming"));
      await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
    } finally {
      gate.resolve();
      subscription.unsubscribe();
      await pending;
    }
  });

  it("finishes outbox removal without replaying an envelope already acknowledged by every target", async () => {
    const { network, store, transport } = await fixture();
    const event = await envelope();
    vi.spyOn(store, "removeItem").mockRejectedValueOnce(new Error("remove failed"));
    expect((await network.publish([relayA], event))[relayA]?.ok).toBe(true);
    expect(network.receiptResult(event.id).error).toBeInstanceOf(GroupNetworkPublicationError);
    const originalCount = transport.published.length;
    const result = await network.flushPending();
    expect(result.error).toBeNull();
    expect(result.data?.[0]?.relays[0]?.ok).toBe(true);
    expect(transport.published).toHaveLength(originalCount);
    expect(await network.listPending()).toEqual([]);
  });
});
