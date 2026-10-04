import { IDBFactory } from "fake-indexeddb";
import { describe, expect } from "vitest";
import type { ClientOptions } from "../src";
import { createClient, IndexedDBPersistenceAdapter, RelayPool } from "../src";
import { encodeRecord } from "../src/protocol";
import type { TestDB } from "./helpers";
import { alice, bob } from "./helpers";
import { type TestScope, required, test } from "./support/lifecycle";
import { relayOptions, WireRelay } from "./support/relay";

async function relay(scope: TestScope) {
  const result = await new WireRelay().start();
  scope.defer(() => result.close());
  return result;
}
function client(
  scope: TestScope,
  relays: WireRelay[],
  options: Partial<ClientOptions<TestDB>> = {},
) {
  const result = createClient<TestDB>({
    namespace: "test-app",
    relays: relays.map((node) => node.url),
    signer: alice,
    timeout: 300,
    relayOptions,
    ...options,
  });
  scope.defer(() => result.closeAsync());
  return result;
}

describe("real relay failure contracts", () => {
  test("a completed relay remains usable while another sends data but never EOSE", async ({
    scope,
  }) => {
    const good = await relay(scope);
    const stalled = await relay(scope);
    stalled.readMode = "silence";
    const accepted = await alice.signEvent(
      encodeRecord("test-app", "todos", "good", { title: "good", done: false }, 10, 10),
    );
    const incomplete = await alice.signEvent(
      encodeRecord("test-app", "todos", "incomplete", { title: "incomplete", done: false }, 10, 10),
    );
    good.events.set(accepted.id, accepted);
    stalled.events.set(incomplete.id, incomplete);
    const sdk = client(scope, [good, stalled]);
    const result = await sdk.from("todos");
    expect(result.error).toBeNull();
    expect(result.data?.map((row) => row.id)).toEqual(["good"]);
    expect(result.meta?.partial).toBe(true);
    expect(
      result.meta?.relays.some((status) => status.url.startsWith(stalled.url) && !status.ok),
    ).toBe(true);
    await expect.poll(() => good.activeSubscriptions + stalled.activeSubscriptions).toBe(0);
  });

  test("ignores an OK for an unrelated event and retains a failed publication receipt", async ({
    scope,
  }) => {
    const node = await relay(scope);
    node.writeMode = "wrong-id";
    const sdk = client(scope, [node]);
    const result = await sdk.from("todos").insert({ id: "x", title: "x", done: false }).select();
    expect(result.error?.code).toBe("PUBLISH_FAILED");
    expect(result.count).toBe(0);
    expect(result.meta?.receipts?.[0]?.relays[0]?.ok).toBe(false);
    expect((await sdk.from("todos").local()).data).toEqual([]);
    expect(node.frames.filter((frame) => frame[0] === "EVENT")).toHaveLength(1);
  });

  test("relay CLOSED fails a live channel and releases the channel lifetime", async ({ scope }) => {
    const node = await relay(scope);
    const sdk = client(scope, [node]);
    const statuses: string[] = [];
    sdk
      .channel("restricted")
      .on("nostr_changes", { table: "todos" }, () => {})
      .subscribe((status) => statuses.push(status));
    await expect.poll(() => node.activeSubscriptions).toBe(1);
    node.restrictSubscriptions();
    await expect.poll(() => statuses).toEqual(["SUBSCRIBED", "CHANNEL_ERROR", "CLOSED"]);
    expect(node.activeSubscriptions).toBe(0);
  });

  test("rejects forged and signed out-of-scope records delivered in a valid EVENT frame", async ({
    scope,
  }) => {
    const node = await relay(scope);
    const valid = await alice.signEvent(
      encodeRecord("test-app", "todos", "valid", { title: "valid", done: false }, 10, 10),
    );
    const foreign = await alice.signEvent(
      encodeRecord("other-app", "todos", "foreign", { title: "foreign", done: false }, 10, 10),
    );
    node.injected = [valid, valid, { ...valid, content: "tampered" }, foreign];
    const sdk = client(scope, [node]);
    const result = await sdk.events.query({ kinds: [30078], "#t": ["nostrbase:test-app:todos"] });
    expect(result.error).toBeNull();
    expect(result.data?.map((event) => event.id)).toEqual([valid.id]);
    expect((await sdk.from("todos").local()).data?.map((row) => row.id)).toEqual(["valid"]);
    expect(sdk.cachedEvents().some((event) => event.id === foreign.id)).toBe(false);
  });

  test("closing a client aborts an outstanding read and sends CLOSE on the wire", async ({
    scope,
  }) => {
    const node = await relay(scope);
    node.readMode = "silence";
    const sdk = client(scope, [node]);
    const pending = Promise.resolve(sdk.from("todos"));
    await expect.poll(() => node.activeSubscriptions).toBe(1);
    await sdk.closeAsync();
    expect((await pending).error?.code).toBe("ABORTED");
    await expect.poll(() => node.activeSubscriptions).toBe(0);
    expect(node.frames.some((frame) => frame[0] === "CLOSE")).toBe(true);
  });
});

describe("durable app workflow over IndexedDB and WebSocket", () => {
  test("personal private records stream across devices as ciphertext and remain author-scoped", async ({
    scope,
  }) => {
    const node = await relay(scope);
    const writer = client(scope, [node]);
    const reader = client(scope, [node]);
    const otherAccount = client(scope, [node], { signer: bob });
    const changes: string[] = [];
    await reader.private.subscribe("todos", (change) =>
      changes.push(`${change.eventType}:${change.new?.title ?? change.old?.title}`),
    );
    await expect.poll(() => node.activeSubscriptions).toBe(1);
    expect(
      (
        await writer.private
          .from("todos")
          .insert({ id: "secret", title: "first secret", done: false })
      ).error,
    ).toBeNull();
    await expect.poll(() => changes).toEqual(["INSERT:first secret"]);
    expect((await reader.private.from("todos").single()).data?.title).toBe("first secret");
    expect((await otherAccount.private.from("todos")).data).toEqual([]);
    expect((await otherAccount.from("todos")).data).toEqual([]);
    expect(
      (await writer.private.from("todos").update({ title: "second secret" }).eq("id", "secret"))
        .error,
    ).toBeNull();
    await expect.poll(() => changes).toEqual(["INSERT:first secret", "UPDATE:second secret"]);
    expect((await writer.private.from("todos").delete().eq("id", "secret")).error).toBeNull();
    await expect
      .poll(() => changes)
      .toEqual(["INSERT:first secret", "UPDATE:second secret", "DELETE:second secret"]);
    expect(JSON.stringify(node.frames)).not.toContain("first secret");
    expect(JSON.stringify(node.frames)).not.toContain("second secret");
    await reader.auth.signOut();
    await expect.poll(() => node.activeSubscriptions).toBe(0);
  });

  test("closing one client preserves the subscriptions and connection of another using the same pool", async ({
    scope,
  }) => {
    const node = await relay(scope);
    const pool = new RelayPool(relayOptions);
    scope.defer(() => pool.close());
    const first = client(scope, [node], { pool });
    const second = client(scope, [node], { pool });
    const seen: string[] = [];
    second
      .channel("shared-pool")
      .on("nostr_changes", { table: "todos" }, (change) => seen.push(change.new?.id ?? "deleted"))
      .subscribe();
    await expect.poll(() => node.activeSubscriptions).toBe(1);
    expect((await first.from("todos")).error).toBeNull();
    await first.closeAsync();
    await expect.poll(() => node.activeSubscriptions).toBe(1);
    const remote = client(scope, [node]);
    expect(
      (await remote.from("todos").insert({ id: "still-connected", title: "x", done: false })).error,
    ).toBeNull();
    await expect.poll(() => seen).toEqual(["still-connected"]);
    await second.closeAsync();
    await expect.poll(() => node.activeSubscriptions).toBe(0);
  });

  test("restarts offline, explicitly replays signed CRUD, recovers remote data, and keeps tombstones", async ({
    scope,
  }) => {
    const node = await relay(scope);
    const factory = new IDBFactory();
    const makeAdapter = () => new IndexedDBPersistenceAdapter("workflow", factory);
    const first = client(scope, [node], { persistence: { adapter: makeAdapter() } });
    const queued = await first
      .from("todos")
      .insert({ id: "offline", title: "offline", done: false })
      .queue()
      .select()
      .single();
    expect(queued.error).toBeNull();
    const original = structuredClone(required((await first.offline.list())[0]).event);
    expect(node.frames).toEqual([]);
    await first.closeAsync();

    const restarted = client(scope, [node], { persistence: { adapter: makeAdapter() } });
    expect((await restarted.from("todos").local().single()).data?.title).toBe("offline");
    expect(node.frames).toEqual([]);
    const replay = await restarted.offline.flush();
    expect(replay.error).toBeNull();
    expect(node.frames.filter((frame) => frame[0] === "EVENT")[0]?.[1]).toEqual(original);
    expect(await restarted.offline.list()).toEqual([]);

    const remote = client(scope, [node]);
    expect(
      (await remote.from("todos").update({ title: "remote edit" }).eq("id", "offline")).error,
    ).toBeNull();
    const recovered = await restarted.sync.table("todos");
    expect(recovered.error).toBeNull();
    expect(recovered.meta?.sync[0]?.strategy).toBe("query");
    expect((await restarted.from("todos").local().single()).data?.title).toBe("remote edit");
    expect((await restarted.from("todos").delete().eq("id", "offline").queue()).error).toBeNull();
    expect((await restarted.offline.flush()).error).toBeNull();
    await restarted.closeAsync();

    node.injected = [original]; // Another relay may still keep the old signed copy.
    const fresh = client(scope, [node], { persistence: { adapter: makeAdapter() } });
    expect((await fresh.from("todos").local()).data).toEqual([]);
    expect((await fresh.from("todos")).data).toEqual([]);
    expect(await fresh.offline.list()).toEqual([]);
    expect(node.frames.filter((frame) => frame[0] === "EVENT")).toHaveLength(3);
  });
});
