import { describe, expect, vi } from "vitest";
import type { NostrbaseClient, Result } from "../src";
import { createClient } from "../src";
import { MemoryGroupStateAdapter } from "../src/group-store";
import type { NostrbaseGroup } from "../src/groups";
import type { TestDB } from "./helpers";
import { alice, bob } from "./helpers";
import type { TestScope } from "./support/lifecycle";
import { required, test } from "./support/lifecycle";
import { relayOptions, WireRelay } from "./support/relay";

const aliceDevice = "01".repeat(32);
const bobDevice = "02".repeat(32);
function checked<T>(result: Result<T>): T {
  expect(result.error).toBeNull();
  return required(result.data);
}

async function relay(scope: TestScope): Promise<WireRelay> {
  const node = await new WireRelay().start();
  scope.defer(() => node.close());
  return node;
}
function client(
  scope: TestScope,
  node: WireRelay,
  adapter: MemoryGroupStateAdapter,
  signer = alice,
  deviceId = aliceDevice,
): NostrbaseClient<TestDB> {
  const sdk = createClient<TestDB>({
    namespace: "groups-restart",
    relays: [node.url],
    signer,
    timeout: 1500,
    relayOptions,
    groups: { adapter, deviceId },
    schema: {
      todos: {
        validate: (value): value is TestDB["todos"] =>
          !!value &&
          typeof value === "object" &&
          typeof (value as TestDB["todos"]).title === "string" &&
          typeof (value as TestDB["todos"]).done === "boolean",
      },
      projects: {},
    },
  });
  scope.defer(() => sdk.closeAsync());
  return sdk;
}
async function join(
  sdk: NostrbaseClient<TestDB>,
  owner: NostrbaseGroup<TestDB>,
): Promise<NostrbaseGroup<TestDB>> {
  expect((await sdk.groups.publishKeyPackage()).error).toBeNull();
  expect((await owner.invite(await bob.getPublicKey())).error).toBeNull();
  const invites = checked(await sdk.groups.invites());
  expect(invites).toHaveLength(1);
  return checked(await sdk.groups.join(required(invites[0]).id));
}

describe("durable Marmot group projections and signed intents", () => {
  test("restores author-owned records, version history, and tombstones after a full client restart", async ({
    scope,
  }) => {
    const node = await relay(scope);
    const adapter = new MemoryGroupStateAdapter();
    const owner = client(scope, node, adapter);
    const group = checked(await owner.groups.create({ name: "Persistent records" }));
    expect(
      (
        await group
          .from("todos")
          .insert({ id: "survives", title: "PRIVATE-RESTART-STATE", done: false })
      ).error,
    ).toBeNull();
    expect(
      (await group.from("todos").update({ done: true }).eq("id", "survives")).error,
    ).toBeNull();
    expect(
      (await group.from("todos").insert({ id: "deleted", title: "DELETE-ME", done: false })).error,
    ).toBeNull();
    expect((await group.from("todos").delete().eq("id", "deleted")).error).toBeNull();
    const original = required((await group.from("todos").eq("id", "survives").single()).data);
    await owner.closeAsync();
    const reopened = client(scope, node, adapter);
    const restored = checked(await reopened.groups.get(group.id));
    const frameCount = node.frames.length;
    const local = await restored.from("todos").local();
    expect(local.error).toBeNull();
    expect(local.data).toEqual([original]);
    expect(node.frames.length).toBe(frameCount);
    expect((await restored.from("todos").eq("id", "deleted")).data).toEqual([]);
    expect((await restored.sync()).error).toBeNull();
    expect((await restored.from("todos").local()).data).toEqual([original]);
    expect(JSON.stringify([...node.events.values()])).not.toContain("PRIVATE-RESTART-STATE");
    for (const key of await adapter.keys())
      expect(await adapter.get(key)).not.toContain("PRIVATE-RESTART-STATE");
  });
  test("routes concurrent initial group queries after restart through one handle and composes queued patches in order", async ({
    scope,
  }) => {
    const node = await relay(scope);
    const adapter = new MemoryGroupStateAdapter();
    scope.defer(() => adapter.close());
    const owner = client(scope, node, adapter);
    const group = checked(await owner.groups.create({ name: "Concurrent routing" }));
    expect(
      (
        await owner
          .from("todos")
          .inGroup(group.id)
          .insert({ id: "patch", title: "original", done: false })
      ).error,
    ).toBeNull();
    await owner.closeAsync();
    const reopened = client(scope, node, adapter);
    const handles: NostrbaseGroup<TestDB>[] = [];
    const get = reopened.groups.get.bind(reopened.groups);
    const resolve = vi.spyOn(reopened.groups, "get").mockImplementation(async (id) => {
      const result = await get(id);
      if (result.data) handles.push(result.data);
      return result;
    });
    scope.defer(() => resolve.mockRestore());
    const mutations = await Promise.all([
      reopened
        .from("todos")
        .inGroup(group.id)
        .update({ title: "CONCURRENT-QUEUED-PATCH" })
        .eq("id", "patch")
        .queue()
        .local()
        .select()
        .single(),
      reopened
        .from("todos")
        .inGroup(group.id)
        .update({ done: true })
        .eq("id", "patch")
        .queue()
        .local()
        .select()
        .single(),
    ]);
    for (const mutation of mutations) expect(mutation.error).toBeNull();
    expect(handles).toHaveLength(2);
    const restored = required(handles[0]);
    expect(handles[1]).toBe(restored);
    expect(new Set(mutations.map((result) => required(result.data)._nostr.updatedAt)).size).toBe(2);
    expect(
      mutations.some(
        (result) => result.data?.title === "CONCURRENT-QUEUED-PATCH" && result.data.done,
      ),
    ).toBe(true);
    expect(checked(await restored.flush())).toHaveLength(2);
    const current = checked(
      await reopened.from("todos").inGroup(group.id).eq("id", "patch").single(),
    );
    expect(current.title).toBe("CONCURRENT-QUEUED-PATCH");
    expect(current.done).toBe(true);
    expect(current._nostr.pubkey).toBe(await alice.getPublicKey());
    expect(handles.every((handle) => handle === restored)).toBe(true);
    expect(checked(await reopened.from("todos").local())).toEqual([]);
    expect(JSON.stringify([...node.events.values()])).not.toContain("CONCURRENT-QUEUED-PATCH");
  });

  test("reopens an explicitly queued signed intent and publishes without requesting another author signature", async ({
    scope,
  }) => {
    const node = await relay(scope);
    const adapter = new MemoryGroupStateAdapter();
    const owner = client(scope, node, adapter);
    const group = checked(await owner.groups.create({ name: "Queued records" }));
    const before = [...node.events.values()].filter((event) => event.kind === 445).length;
    const queued = await group
      .from("todos")
      .insert({ id: "queued", title: "PRIVATE-QUEUED-INTENT", done: false })
      .queue()
      .select()
      .single();
    expect(queued.error).toBeNull();
    const receipt = required(queued.meta?.receipts?.[0]);
    expect(receipt.queued).toBe(true);
    expect([...node.events.values()].filter((event) => event.kind === 445)).toHaveLength(before);
    await owner.closeAsync();
    const reopened = client(scope, node, adapter);
    const restored = checked(await reopened.groups.get(group.id));
    const sign = vi.spyOn(alice, "signEvent");
    try {
      const replay = await restored.flush();
      expect(replay.error).toBeNull();
      expect(replay.data).toHaveLength(1);
      expect(sign).not.toHaveBeenCalled();
      const row = required((await restored.from("todos").eq("id", "queued").single()).data);
      expect(row._nostr.eventId).toBe(receipt.eventId);
      expect(row.title).toBe("PRIVATE-QUEUED-INTENT");
      expect((await restored.flush()).data).toEqual([]);
    } finally {
      sign.mockRestore();
    }
    expect(JSON.stringify([...node.events.values()])).not.toContain("PRIVATE-QUEUED-INTENT");
  });
  test("retries an exact rejected MLS envelope after restart and restores its admitted projection", async ({
    scope,
  }) => {
    const node = await relay(scope);
    const adapter = new MemoryGroupStateAdapter();
    const owner = client(scope, node, adapter);
    const group = checked(await owner.groups.create({ name: "Rejected publication" }));
    node.writeMode = "reject";
    const result = await group
      .from("todos")
      .insert({ id: "retry", title: "PRIVATE-EXACT-RETRY", done: false });
    expect(result.error?.code).toBe("PUBLISH_FAILED");
    const frames = node.frames.filter(
      (frame) => frame[0] === "EVENT" && (frame[1] as { kind?: number }).kind === 445,
    );
    const signedEnvelope = required(frames.at(-1)?.[1]);
    await owner.closeAsync();
    node.writeMode = "accept";
    const reopened = client(scope, node, adapter);
    const retry = await reopened.groups.flush();
    expect(retry.error).toBeNull();
    const attempts = node.frames.filter(
      (frame) =>
        frame[0] === "EVENT" &&
        (frame[1] as { id?: string }).id === (signedEnvelope as { id: string }).id,
    );
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(
      attempts.every((frame) => JSON.stringify(frame[1]) === JSON.stringify(signedEnvelope)),
    ).toBe(true);
    const restored = checked(await reopened.groups.get(group.id));
    expect((await restored.from("todos").eq("id", "retry").single()).data?.title).toBe(
      "PRIVATE-EXACT-RETRY",
    );
  });
  test("recreates an author-owned ID above its retained deletion tombstone within the same clock second", async ({
    scope,
  }) => {
    const node = await relay(scope);
    const adapter = new MemoryGroupStateAdapter();
    const owner = client(scope, node, adapter);
    const group = checked(await owner.groups.create({ name: "Same-second recreation" }));
    const fixed = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(fixed);
    try {
      const first = await group
        .from("todos")
        .insert({ id: "recreate", title: "original", done: false })
        .select()
        .single();
      expect(first.error).toBeNull();
      expect((await group.from("todos").delete().eq("id", "recreate")).error).toBeNull();
      expect((await group.from("todos").eq("id", "recreate").local()).data).toEqual([]);
      const recreated = await group
        .from("todos")
        .insert({ id: "recreate", title: "RECREATED-AFTER-DELETE", done: true })
        .select()
        .single();
      expect(recreated.error).toBeNull();
      const current = await group.from("todos").eq("id", "recreate").local().single();
      expect(current.error).toBeNull();
      expect(current.data?.title).toBe("RECREATED-AFTER-DELETE");
      expect(required(current.data)._nostr.updatedAt).toBeGreaterThan(
        required(first.data)._nostr.updatedAt + 1,
      );
    } finally {
      clock.mockRestore();
    }
  });
  test("assigns increasing timestamps to queued upserts and keeps the last value when intent replay order reverses", async ({
    scope,
  }) => {
    const node = await relay(scope);
    const adapter = new MemoryGroupStateAdapter();
    const owner = client(scope, node, adapter);
    const group = checked(await owner.groups.create({ name: "Queued versions" }));
    const fixed = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(fixed);
    try {
      const first = await group
        .from("todos")
        .upsert({ id: "same", title: "FIRST-QUEUED", done: false })
        .queue()
        .select()
        .single();
      const last = await group
        .from("todos")
        .upsert({ id: "same", title: "LAST-QUEUED", done: true })
        .queue()
        .select()
        .single();
      expect(first.error).toBeNull();
      expect(last.error).toBeNull();
      expect(required(last.data)._nostr.updatedAt).toBeGreaterThan(
        required(first.data)._nostr.updatedAt,
      );
      await owner.closeAsync();
      const keys = adapter.keys.bind(adapter);
      const reordered = vi
        .spyOn(adapter, "keys")
        .mockImplementation(async () => (await keys()).reverse());
      try {
        const reopened = client(scope, node, adapter);
        const restored = checked(await reopened.groups.get(group.id));
        const replay = await restored.flush();
        expect(replay.error).toBeNull();
        expect(replay.data).toHaveLength(2);
        const current = await restored.from("todos").eq("id", "same").single();
        expect(current.error).toBeNull();
        expect(current.data?.title).toBe("LAST-QUEUED");
        expect(current.data?._nostr.eventId).toBe(last.data?._nostr.eventId);
      } finally {
        reordered.mockRestore();
      }
    } finally {
      clock.mockRestore();
    }
  });
  test("composes queued patches over the latest signed pending version instead of a stale published row", async ({
    scope,
  }) => {
    const node = await relay(scope);
    const adapter = new MemoryGroupStateAdapter();
    const owner = client(scope, node, adapter);
    const group = checked(await owner.groups.create({ name: "Queued patch composition" }));
    expect(
      (await group.from("todos").insert({ id: "patch", title: "PUBLISHED-BASE", done: false }))
        .error,
    ).toBeNull();
    const first = await group
      .from("todos")
      .update({ title: "FIRST-PENDING-PATCH" })
      .eq("id", "patch")
      .queue()
      .select()
      .single();
    expect(first.error).toBeNull();
    const second = await group
      .from("todos")
      .update({ done: true })
      .eq("id", "patch")
      .queue()
      .select()
      .single();
    expect(second.error).toBeNull();
    expect(second.data?.title).toBe("FIRST-PENDING-PATCH");
    expect(second.data?.done).toBe(true);
    const replay = await group.flush();
    expect(replay.error).toBeNull();
    expect(replay.data).toHaveLength(2);
    const current = await group.from("todos").eq("id", "patch").single();
    expect(current.error).toBeNull();
    expect(current.data?.title).toBe("FIRST-PENDING-PATCH");
    expect(current.data?.done).toBe(true);
    expect(current.data?._nostr.eventId).toBe(second.data?._nostr.eventId);
  });
  test("rejects a duplicate insert against an existing queued ID before requesting another signature", async ({
    scope,
  }) => {
    const node = await relay(scope);
    const adapter = new MemoryGroupStateAdapter();
    const owner = client(scope, node, adapter);
    const group = checked(await owner.groups.create({ name: "Queued uniqueness" }));
    expect(
      (await group.from("todos").insert({ id: "pending", title: "FIRST", done: false }).queue())
        .error,
    ).toBeNull();
    const sign = vi.spyOn(alice, "signEvent");
    try {
      const duplicate = await group
        .from("todos")
        .insert({ id: "pending", title: "SECOND", done: true })
        .queue();
      expect(duplicate.error?.code).toBe("CONFLICT");
      expect(sign).not.toHaveBeenCalled();
    } finally {
      sign.mockRestore();
    }
    expect((await group.flush()).data).toHaveLength(1);
    expect((await group.from("todos").eq("id", "pending").single()).data?.title).toBe("FIRST");
  });
  test("keeps previously admitted history after removal but refuses a queued former member's replay", async ({
    scope,
  }) => {
    const node = await relay(scope);
    const ownerAdapter = new MemoryGroupStateAdapter();
    const memberAdapter = new MemoryGroupStateAdapter();
    const owner = client(scope, node, ownerAdapter);
    const member = client(scope, node, memberAdapter, bob, bobDevice);
    const group = checked(await owner.groups.create({ name: "Removed queue" }));
    expect(
      (
        await group
          .from("todos")
          .insert({ id: "history", title: "PRIVATE-HISTORICAL", done: false })
      ).error,
    ).toBeNull();
    const shared = await join(member, group);
    expect((await shared.from("todos").eq("id", "history").single()).data?.title).toBe(
      "PRIVATE-HISTORICAL",
    );
    expect(
      (
        await shared
          .from("todos")
          .insert({ id: "stale", title: "FORMER-MEMBER-QUEUED", done: false })
          .queue()
      ).error,
    ).toBeNull();
    await member.closeAsync();
    expect((await group.remove(await bob.getPublicKey())).error).toBeNull();
    const reopened = client(scope, node, memberAdapter, bob, bobDevice);
    const removed = checked(await reopened.groups.get(group.id));
    const before = node.frames.length;
    const replay = await removed.flush();
    expect(replay.error?.code).toBe("PERMISSION_DENIED");
    expect(node.frames.slice(before).some((frame) => frame[0] === "EVENT")).toBe(false);
    expect((await removed.from("todos").eq("id", "history").local().single()).data?.title).toBe(
      "PRIVATE-HISTORICAL",
    );
    expect((await group.from("todos").eq("id", "stale")).data).toEqual([]);
  });
});
