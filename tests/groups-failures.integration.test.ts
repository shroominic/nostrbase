import { PrivateKeySigner } from "applesauce-signers";
import { describe, expect, vi } from "vitest";
import { createClient } from "../src";
import type { ClientOptions, NostrbaseClient } from "../src";
import { MemoryGroupStateAdapter } from "../src/group-store";
import type { GroupStateAdapter } from "../src/group-store";
import type { NostrbaseGroup } from "../src/groups";
import { alice, bob } from "./helpers";
import type { TestDB } from "./helpers";
import { required, test } from "./support/lifecycle";
import type { TestScope } from "./support/lifecycle";
import { relayOptions, WireRelay } from "./support/relay";

class ProjectionFaultAdapter implements GroupStateAdapter {
  readonly saved = new MemoryGroupStateAdapter();
  failOnce = false;
  failBucket = ":records%3A";
  failureCount = 0;
  onFailure?: () => void;
  get(key: string) {
    return this.saved.get(key);
  }
  async set(key: string, value: string): Promise<void> {
    if (this.failOnce && key.includes(this.failBucket)) {
      this.failOnce = false;
      this.failureCount++;
      if (this.failBucket === ":records%3A")
        expect((await this.keys()).some((item) => item.includes(":pending-ingress:"))).toBe(true);
      this.onFailure?.();
      throw new Error("PRIVATE-PROJECTION-FAULT");
    }
    await this.saved.set(key, value);
  }
  remove(key: string) {
    return this.saved.remove(key);
  }
  keys() {
    return this.saved.keys();
  }
  close() {
    this.saved.close();
  }
}

async function relay(scope: TestScope): Promise<WireRelay> {
  const node = await new WireRelay().start();
  scope.defer(() => node.close());
  return node;
}
function client(
  scope: TestScope,
  nodes: WireRelay[],
  signer = alice,
  options: Partial<ClientOptions<TestDB>> = {},
): NostrbaseClient<TestDB> {
  const sdk = createClient<TestDB>({
    namespace: "groups-failures",
    relays: nodes.map((node) => node.url),
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
  pubkey?: string,
): Promise<NostrbaseGroup<TestDB>> {
  expect((await sdk.groups.publishKeyPackage()).error).toBeNull();
  expect((await owner.invite(pubkey ?? (await bob.getPublicKey()))).error).toBeNull();
  const invites = await sdk.groups.invites();
  return sdk.groups.join(required(invites[0]).id);
}

describe("Marmot accepted publications and receive persistence failures", () => {
  test("preserves a partial ACK and retries the same ciphertext until minWriteAcks is met", async ({
    scope,
  }) => {
    const accepted = await relay(scope);
    const rejected = await relay(scope);
    const sdk = client(scope, [accepted, rejected], alice, { minWriteAcks: 2 });
    const group = await sdk.groups.create({ name: "Partial acknowledgement" });
    rejected.writeMode = "reject";
    const result = await group
      .from("todos")
      .insert({ id: "partial", title: "PRIVATE-PARTIAL-ACK", done: false });
    expect(result.error?.code).toBe("PUBLISH_FAILED");
    expect(result.meta?.partial).toBe(true);
    const receipt = required(result.meta?.receipts?.[0]);
    expect(receipt.relays.filter((value) => value.ok)).toHaveLength(1);
    expect(receipt.relays.filter((value) => !value.ok)).toHaveLength(1);
    const envelope = required(accepted.events.get(receipt.eventId));
    expect((await group.from("todos").local().single()).data?.title).toBe("PRIVATE-PARTIAL-ACK");
    rejected.writeMode = "accept";
    const replay = await sdk.groups.flush();
    expect(replay.error).toBeNull();
    expect(rejected.events.get(receipt.eventId)).toEqual(envelope);
    const attempts = [...accepted.frames, ...rejected.frames].filter(
      (frame) => frame[0] === "EVENT" && (frame[1] as { id?: string }).id === receipt.eventId,
    );
    expect(attempts.length).toBeGreaterThanOrEqual(3);
    expect(attempts.every((frame) => JSON.stringify(frame[1]) === JSON.stringify(envelope))).toBe(
      true,
    );
    expect(
      JSON.stringify([...accepted.events.values(), ...rejected.events.values()]),
    ).not.toContain("PRIVATE-PARTIAL-ACK");
    expect(JSON.stringify(result.meta)).not.toContain("PRIVATE-PARTIAL-ACK");
  });

  test("keeps invitation history after failed Welcome fanout and does not resend the membership commit", async ({
    scope,
  }) => {
    const node = await relay(scope);
    const admin = client(scope, [node]);
    const member = client(scope, [node], bob);
    const group = await admin.groups.create({ name: "Welcome retry" });
    expect(
      (
        await group
          .from("todos")
          .insert({ id: "history", title: "PRIVATE-WELCOME-HISTORY", done: false })
      ).error,
    ).toBeNull();
    expect((await member.groups.publishKeyPackage()).error).toBeNull();
    const before = node.frames.filter((frame) => frame[0] === "EVENT").length;
    node.rejectWriteNumber = before + 2; // Invite commit succeeds; its gift wrap fails.
    const invitation = await group.invite(await bob.getPublicKey());
    expect(invitation.error?.code).toBe("PUBLISH_FAILED");
    expect(invitation.meta?.partial).toBe(true);
    expect(group.info.members).toContain(await bob.getPublicKey());
    expect(invitation.data?.length).toBeGreaterThanOrEqual(2); // Commit + historical snapshot.
    expect((await member.groups.invites()).length).toBe(0);
    const groupFrames = node.frames.filter(
      (frame) => frame[0] === "EVENT" && (frame[1] as { kind?: number }).kind === 445,
    );
    const commit = required(groupFrames.at(-2)?.[1]) as { id: string };
    expect((await admin.groups.flush()).error).toBeNull();
    expect([...node.events.values()].filter((event) => event.kind === 1059)).toHaveLength(1);
    expect(
      node.frames.filter(
        (frame) => frame[0] === "EVENT" && (frame[1] as { id?: string }).id === commit.id,
      ),
    ).toHaveLength(1);
    const invites = await member.groups.invites();
    expect(invites).toHaveLength(1);
    const shared = await member.groups.join(required(invites[0]).id);
    expect((await shared.from("todos").eq("id", "history").single()).data?.title).toBe(
      "PRIVATE-WELCOME-HISTORY",
    );
    expect(JSON.stringify([...node.events.values()])).not.toContain("PRIVATE-WELCOME-HISTORY");
  });

  test("restores an authenticated received record from encrypted ingress after projection save fails and the client stops", async ({
    scope,
  }) => {
    const node = await relay(scope);
    const adapter = new ProjectionFaultAdapter();
    scope.defer(() => adapter.close());
    const admin = client(scope, [node]);
    const options = { groups: { adapter, deviceId: "0b".repeat(32) } };
    const member = client(scope, [node], bob, options);
    const group = await admin.groups.create({ name: "Receive journal" });
    const shared = await join(member, group);
    await group.sync();
    expect(
      (
        await group
          .from("todos")
          .insert({ id: "receive", title: "PRIVATE-RECEIVE-JOURNAL", done: false })
      ).error,
    ).toBeNull();
    adapter.failOnce = true;
    adapter.onFailure = () => member.close();
    const sync = await shared.sync();
    expect(sync.error).not.toBeNull();
    expect(JSON.stringify(sync.error)).not.toContain("PRIVATE-PROJECTION-FAULT");
    expect(adapter.failureCount).toBe(1);
    expect((await adapter.keys()).some((key) => key.includes(":pending-ingress:"))).toBe(true);
    await member.closeAsync();
    const restored = client(scope, [node], bob, options);
    const reopened = await restored.groups.get(group.id);
    const before = node.frames.length;
    const row = await reopened.from("todos").local().eq("id", "receive").single();
    expect(row.error).toBeNull();
    expect(row.data?.title).toBe("PRIVATE-RECEIVE-JOURNAL");
    expect(node.frames.length).toBe(before);
    expect((await adapter.keys()).some((key) => key.includes(":pending-ingress:"))).toBe(false);
    const ciphertext = await Promise.all((await adapter.keys()).map((key) => adapter.get(key)));
    expect(JSON.stringify(ciphertext)).not.toContain("PRIVATE-RECEIVE-JOURNAL");
    expect(JSON.stringify([...node.events.values()])).not.toContain("PRIVATE-RECEIVE-JOURNAL");
  });

  test("loads an unloaded group after restart to retry a Welcome that failed before network publication", async ({
    scope,
  }) => {
    const node = await relay(scope);
    const adapter = new ProjectionFaultAdapter();
    scope.defer(() => adapter.close());
    const options = { groups: { adapter, deviceId: "0a".repeat(32) } };
    const admin = client(scope, [node], alice, options);
    const member = client(scope, [node], bob);
    const group = await admin.groups.create({ name: "Unloaded Welcome recovery" });
    expect(
      (
        await group
          .from("todos")
          .insert({ id: "old", title: "PRIVATE-WELCOME-STORAGE", done: false })
      ).error,
    ).toBeNull();
    expect((await member.groups.publishKeyPackage()).error).toBeNull();
    adapter.failBucket = ":welcome-envelopes:";
    adapter.failOnce = true;
    const invite = await group.invite(await bob.getPublicKey());
    expect(invite.error?.code).toBe("PUBLISH_FAILED");
    expect(adapter.failureCount).toBe(1);
    expect([...node.events.values()].filter((event) => event.kind === 1059)).toEqual([]);
    await admin.closeAsync();
    const reopened = client(scope, [node], alice, options);
    adapter.failOnce = true;
    const failedRetry = await reopened.groups.flush();
    expect(failedRetry.error?.code).toBe("PUBLISH_FAILED");
    expect(failedRetry.meta?.partial).toBe(true);
    expect(JSON.stringify(failedRetry.error)).not.toContain("PRIVATE-PROJECTION-FAULT");
    expect([...node.events.values()].filter((event) => event.kind === 1059)).toEqual([]);
    expect((await reopened.groups.flush()).error).toBeNull();
    expect([...node.events.values()].filter((event) => event.kind === 1059)).toHaveLength(1);
    const invites = await member.groups.invites();
    const shared = await member.groups.join(required(invites[0]).id);
    expect((await shared.from("todos").eq("id", "old").single()).data?.title).toBe(
      "PRIVATE-WELCOME-STORAGE",
    );
  });

  test("rejects a newly received former member record when the same batch applies its removal", async ({
    scope,
  }) => {
    const realTimeout = globalThis.setTimeout;
    let earlyWakeups = 0;
    // Real timers can fire just before the engine's fractional monotonic cutoff.
    // Force that edge while preserving the actual clock and full security gates.
    const timers = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (delay !== undefined && delay > 900 && delay < 1100) {
        earlyWakeups++;
        return realTimeout(callback, delay - 3, ...args);
      }
      return realTimeout(callback, delay, ...args);
    }) as typeof setTimeout);
    scope.defer(() => {
      timers.mockRestore();
    });
    const node = await relay(scope);
    const charlie = new PrivateKeySigner(new Uint8Array(32).fill(3));
    const admin = client(scope, [node]);
    const member = client(scope, [node], bob);
    const observer = client(scope, [node], charlie);
    const group = await admin.groups.create({ name: "Batch admission authority" });
    const former = await join(member, group);
    await group.sync();
    const charlieKey = await charlie.getPublicKey();
    const retained = await join(observer, group, charlieKey);
    expect((await former.sync()).error).toBeNull();
    expect((await group.sync()).error).toBeNull();
    expect(
      (await former.from("todos").insert({ id: "late", title: "FORMER-AUTHOR-LATE", done: false }))
        .error,
    ).toBeNull();
    expect((await retained.from("todos").local().eq("id", "late")).data).toEqual([]);
    const bobKey = await bob.getPublicKey();
    expect((await group.remove(bobKey)).error).toBeNull();
    expect((await retained.sync()).error).toBeNull();
    expect(retained.info.members).not.toContain(await bob.getPublicKey());
    expect((await retained.from("todos").local().eq("id", "late")).data).toEqual([]);
    // The admin admitted this record before removing its author, so it remains history.
    expect((await group.from("todos").local().eq("id", "late").single()).data?.title).toBe(
      "FORMER-AUTHOR-LATE",
    );
    expect(earlyWakeups).toBeGreaterThan(0);
  }, 30000);
});
