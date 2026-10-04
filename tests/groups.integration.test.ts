import { PrivateKeySigner } from "applesauce-signers";
import { describe, expect } from "vitest";
import type { ClientOptions, NostrbaseClient, Result } from "../src";
import { createClient } from "../src";
import { MemoryGroupStateAdapter } from "../src/group-store";
import type { GroupChangePayload, NostrbaseGroup } from "../src/groups";
import type { TestDB } from "./helpers";
import { alice, bob } from "./helpers";
import type { TestScope } from "./support/lifecycle";
import { required, test } from "./support/lifecycle";
import { relayOptions, WireRelay } from "./support/relay";

const charlie = new PrivateKeySigner(new Uint8Array(32).fill(3));
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
  signer = alice,
  options: Partial<ClientOptions<TestDB>> = {},
): NostrbaseClient<TestDB> {
  const sdk = createClient<TestDB>({
    namespace: "group-integration",
    relays: [node.url],
    signer,
    timeout: 1500,
    relayOptions,
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
    ...options,
  });
  scope.defer(() => sdk.closeAsync());
  return sdk;
}
async function join(
  sdk: NostrbaseClient<TestDB>,
  owner: NostrbaseGroup<TestDB>,
  pubkey: string,
): Promise<NostrbaseGroup<TestDB>> {
  const publication = await sdk.groups.publishKeyPackage();
  expect(publication.error).toBeNull();
  expect(publication.data?.length).toBeGreaterThanOrEqual(3);
  expect((await owner.invite(pubkey)).error).toBeNull();
  const invites = checked(await sdk.groups.invites());
  expect(invites).toHaveLength(1);
  expect(invites[0]?.joinable).toBe(true);
  return checked(await sdk.groups.join(required(invites[0]).id));
}

describe("Marmot groups over the existing Applesauce WebSocket transport", () => {
  test("invites a second account, transfers verified prior records, and streams author-owned CRUD", async ({
    scope,
  }) => {
    const node = await relay(scope);
    const writer = client(scope, node);
    const reader = client(scope, node, bob);
    const aliceKey = await alice.getPublicKey();
    const bobKey = await bob.getPublicKey();
    const group = checked(
      await writer.groups.create({
        name: "Shared tasks",
        description: "Private collection",
      }),
    );
    const prior = await group
      .from("todos")
      .insert({ id: "prior", title: "PRIVATE-SNAPSHOT", done: false })
      .select()
      .single();
    expect(prior.error).toBeNull();
    const other = await join(reader, group, bobKey);
    expect(other.id).toBe(group.id);
    expect(other.info.name).toBe("Shared tasks");
    expect(new Set(other.info.members)).toEqual(new Set([aliceKey, bobKey]));
    const restored = await other.from("todos").eq("id", "prior").single();
    expect(restored.error).toBeNull();
    expect(restored.data?.title).toBe("PRIVATE-SNAPSHOT");
    expect(restored.data?._nostr.pubkey).toBe(aliceKey);
    const denied = await reader
      .from("todos")
      .inGroup(group.id)
      .update({ done: true })
      .eq("id", "prior")
      .author(aliceKey);
    expect(denied.error?.code).toBe("PERMISSION_DENIED");
    const invalid = await group
      .from("todos")
      .insert({ id: "bad", title: 1, done: false } as unknown as TestDB["todos"]);
    expect(invalid.error?.code).toBe("INVALID_RECORD");
    const changes: GroupChangePayload<TestDB["todos"]>[] = [];
    const errors: unknown[] = [];
    const subscription = other.subscribe(
      "todos",
      (event) => changes.push(event),
      (error) => errors.push(error),
    );
    scope.defer(() => subscription.unsubscribe());
    await expect.poll(() => node.activeSubscriptions).toBeGreaterThan(0);
    expect(
      (await group.from("todos").insert({ id: "live", title: "PRIVATE-LIVE", done: false })).error,
    ).toBeNull();
    await expect
      .poll(() =>
        changes.filter((change) => change.new?.id === "live").map((change) => change.eventType),
      )
      .toEqual(["INSERT"]);
    expect((await group.from("todos").update({ done: true }).eq("id", "live")).error).toBeNull();
    await expect
      .poll(() =>
        changes.filter((change) => change.new?.id === "live").map((change) => change.eventType),
      )
      .toEqual(["INSERT", "UPDATE"]);
    expect((await group.from("todos").delete().eq("id", "live")).error).toBeNull();
    await expect
      .poll(() =>
        changes
          .filter((change) => (change.new ?? change.old)?.id === "live")
          .map((change) => change.eventType),
      )
      .toEqual(["INSERT", "UPDATE", "DELETE"]);
    expect((await other.from("todos").eq("id", "live")).data).toEqual([]);
    expect(
      (
        await reader
          .from("todos")
          .inGroup(group.id)
          .insert({ id: "mine", title: "Bob's record", done: false })
      ).error,
    ).toBeNull();
    expect((await group.from("todos").author(bobKey).eq("id", "mine").single()).data?.title).toBe(
      "Bob's record",
    );
    expect(errors).toEqual([]);
    const wire = JSON.stringify([...node.events.values()]);
    expect(wire).not.toContain("PRIVATE-SNAPSHOT");
    expect(wire).not.toContain("PRIVATE-LIVE");
    expect([...node.events.values()].some((event) => event.kind === 30443)).toBe(true);
    expect([...node.events.values()].some((event) => event.kind === 1059)).toBe(true);
    expect([...node.events.values()].some((event) => event.kind === 445)).toBe(true);
    expect(writer.cachedEvents().some((event) => event.kind === 445)).toBe(false);
    expect(reader.cachedEvents().some((event) => event.kind === 445)).toBe(false);
    subscription.unsubscribe();
    await expect.poll(() => node.activeSubscriptions).toBe(0);
  }, 30000);

  test("admin removes a member, retained members advance epochs, and the removed member cannot read or write new records", async ({
    scope,
  }) => {
    const node = await relay(scope);
    const admin = client(scope, node);
    const member = client(scope, node, bob);
    const third = client(scope, node, charlie);
    const adminKey = await alice.getPublicKey();
    const bobKey = await bob.getPublicKey();
    const charlieKey = await charlie.getPublicKey();
    const owner = checked(await admin.groups.create({ name: "Membership test" }));
    const removed = await join(member, owner, bobKey);
    await owner.sync();
    const retained = await join(third, owner, charlieKey);
    expect((await removed.sync()).error).toBeNull();
    expect((await owner.sync()).error).toBeNull();
    expect((await removed.remove(charlieKey)).error?.code).toBe("PERMISSION_DENIED");
    const before = owner.info.epoch;
    const removal = await owner.remove(bobKey);
    expect(removal.error).toBeNull();
    expect(owner.info.epoch).toBeGreaterThan(before);
    expect(owner.info.members).not.toContain(bobKey);
    expect((await retained.sync()).error).toBeNull();
    expect(new Set(retained.info.members)).toEqual(new Set([adminKey, charlieKey]));
    await removed.sync();
    expect(removed.info.status).toBe("removed");
    const sent = await owner
      .from("todos")
      .insert({ id: "after-removal", title: "CURRENT-MEMBERS-ONLY", done: false });
    expect(sent.error).toBeNull();
    expect((await retained.from("todos").eq("id", "after-removal").single()).data?.title).toBe(
      "CURRENT-MEMBERS-ONLY",
    );
    const forbidden = await removed
      .from("todos")
      .insert({ id: "not-allowed", title: "Removed", done: false });
    expect(forbidden.error?.code).toBe("PERMISSION_DENIED");
    expect((await removed.from("todos").eq("id", "after-removal")).data ?? []).toEqual([]);
    expect(JSON.stringify([...node.events.values()])).not.toContain("CURRENT-MEMBERS-ONLY");
  }, 30000);

  test("restores encrypted state for the same account and device and stops old handles on account switches", async ({
    scope,
  }) => {
    const node = await relay(scope);
    const adapter = new MemoryGroupStateAdapter();
    scope.defer(() => adapter.close());
    const options = { groups: { adapter, deviceId: "c".repeat(64) } };
    const first = client(scope, node, alice, options);
    const owner = checked(await first.groups.create({ name: "Restart test" }));
    expect(
      (await owner.from("todos").insert({ id: "saved", title: "ENCRYPTED-RESTART", done: false }))
        .error,
    ).toBeNull();
    const id = owner.id;
    await first.closeAsync();
    const restarted = client(scope, node, alice, options);
    const restored = checked(await restarted.groups.get(id));
    expect((await restored.from("todos").eq("id", "saved").single()).data?.title).toBe(
      "ENCRYPTED-RESTART",
    );
    await restarted.auth.signInWithSigner(bob);
    expect((await restored.from("todos").local()).error?.code).toBe("AUTH_FAILED");
    expect((await restarted.groups.get(id)).error?.code).toBe("NOT_FOUND");
    await restarted.auth.signInWithSigner(alice);
    const accountRestored = checked(await restarted.groups.get(id));
    expect((await accountRestored.from("todos").local().single()).data?.title).toBe(
      "ENCRYPTED-RESTART",
    );
    const raw = await Promise.all((await adapter.keys()).map((key) => adapter.get(key)));
    expect(JSON.stringify(raw)).not.toContain("ENCRYPTED-RESTART");
  }, 30000);
});
