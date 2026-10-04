import { describe, expect } from "vitest";
import type { ClientOptions, NostrbaseClient, Result, WriteReceipt } from "../src";
import { createClient } from "../src";
import { MemoryGroupStateAdapter } from "../src/group-store";
import { MemoryPersistenceAdapter } from "../src/persistence";
import type { TestDB } from "./helpers";
import { alice, bob, MemoryTransport } from "./helpers";
import type { TestScope } from "./support/lifecycle";
import { deferred, required, test } from "./support/lifecycle";
import { relayOptions, WireRelay } from "./support/relay";

function checked<T>(result: Result<T>): T {
  expect(result.error).toBeNull();
  return required(result.data);
}
async function relay(scope: TestScope) {
  const node = await new WireRelay().start();
  scope.defer(() => node.close());
  return node;
}
function client(
  scope: TestScope,
  nodes: WireRelay[],
  options: Partial<ClientOptions<TestDB>> = {},
): NostrbaseClient<TestDB> {
  const sdk = createClient<TestDB>({
    namespace: "automatic-replay",
    signer: alice,
    relays: nodes.map((node) => node.url),
    timeout: 1000,
    relayOptions,
    ...options,
  });
  scope.defer(() => sdk.closeAsync());
  return sdk;
}

describe("automatic durable replay through Applesauce", () => {
  test("replays public/personal ciphertext exactly and a native reconnect wakes a bounded retry", async ({
    scope,
  }) => {
    const node = await relay(scope);
    node.writeMode = "reject";
    const failures: Result<WriteReceipt[]>[] = [];
    const sdk = client(scope, [node], {
      offline: {
        autoReplay: {
          retryDelay: 5000,
          maxRetryDelay: 5000,
          onError: (_, result) => failures.push(result),
        },
      },
    });
    expect(
      (await sdk.from("todos").insert({ id: "public", title: "PUBLIC-QUEUE", done: false }).queue())
        .error,
    ).toBeNull();
    expect(
      (
        await sdk.private
          .from("todos")
          .insert({ id: "private", title: "PERSONAL-SECRET", done: false })
          .queue()
      ).error,
    ).toBeNull();
    const signed = (await sdk.offline.list()).map((entry) => entry.event);
    await expect.poll(() => failures.length).toBeGreaterThan(0);
    expect(failures[0]?.meta?.receipts?.length).toBeGreaterThan(0);
    node.writeMode = "accept";
    await expect.poll(() => sdk.pool.relay(node.url).connected).toBe(false);
    expect((await sdk.events.query({ kinds: [1] })).error).toBeNull();
    await expect.poll(async () => (await sdk.offline.list()).length, { timeout: 3000 }).toBe(0);
    for (const event of signed) expect(node.events.get(event.id)).toEqual(event);
    expect(JSON.stringify([...node.events.values()])).not.toContain("PERSONAL-SECRET");
  });

  test("keeps partial receipts and only clears queued events after minWriteAcks", async ({
    scope,
  }) => {
    const accepted = await relay(scope);
    const rejected = await relay(scope);
    rejected.writeMode = "reject";
    const observed: Result<WriteReceipt[]>[] = [];
    const sdk = client(scope, [accepted, rejected], {
      minWriteAcks: 2,
      offline: {
        autoReplay: {
          retryDelay: 40,
          maxRetryDelay: 100,
          onResult: (value) => observed.push(value),
        },
      },
    });
    expect(
      (await sdk.from("todos").insert({ id: "threshold", title: "PARTIAL", done: false }).queue())
        .error,
    ).toBeNull();
    await expect
      .poll(() => observed.some((result) => result.error?.code === "PUBLISH_FAILED"))
      .toBe(true);
    expect(await sdk.offline.list()).toHaveLength(1);
    expect(observed[0]?.data?.[0]?.relays.filter((relay) => relay.ok)).toHaveLength(1);
    rejected.writeMode = "accept";
    await expect.poll(async () => (await sdk.offline.list()).length).toBe(0);
    expect([...accepted.events.keys()]).toEqual([...rejected.events.keys()]);
  });

  test("restores work for the signed-in account only and does not require NIP-44 for public replay", async ({
    scope,
  }) => {
    const node = await relay(scope);
    const adapter = new MemoryPersistenceAdapter();
    const first = client(scope, [node], { offline: { adapter } });
    expect(
      (await first.from("todos").insert({ id: "alice", title: "ALICE", done: false }).queue())
        .error,
    ).toBeNull();
    await first.closeAsync();
    const sdk = client(scope, [node], { signer: bob, offline: { adapter, autoReplay: true } });
    expect(
      (await sdk.from("todos").insert({ id: "bob", title: "BOB", done: false }).queue()).error,
    ).toBeNull();
    await expect.poll(async () => (await sdk.offline.list()).length).toBe(1);
    const aliceKey = await alice.getPublicKey();
    expect([...node.events.values()].every((event) => event.pubkey !== aliceKey)).toBe(true);
    const noEncryption = {
      getPublicKey: () => alice.getPublicKey(),
      signEvent: (event: Parameters<typeof alice.signEvent>[0]) => alice.signEvent(event),
    };
    expect((await sdk.auth.signInWithSigner(noEncryption)).error).toBeNull();
    await expect.poll(async () => (await sdk.offline.list()).length).toBe(0);
    expect(node.events.size).toBe(2);
  });

  test("replays group signed intents and recovers an exact failed envelope using fresh handles", async ({
    scope,
  }) => {
    const node = await relay(scope);
    const adapter = new MemoryGroupStateAdapter();
    scope.defer(() => adapter.close());
    const sdk = client(scope, [node], { groups: { adapter, deviceId: "e".repeat(64) } });
    const group = checked(await sdk.groups.create({ name: "Automatic group queue" }));
    sdk.offline.startAutoReplay({ retryDelay: 40, maxRetryDelay: 100 });
    expect(
      (
        await sdk
          .from("todos")
          .inGroup(group.id)
          .insert({ id: "queued", title: "GROUP-QUEUED", done: false })
          .queue()
      ).error,
    ).toBeNull();
    await expect.poll(async () => await sdk.groups.hasReplayPending()).toBe(false);
    const active = checked(await sdk.groups.get(group.id));
    expect((await active.from("todos").local().eq("id", "queued").single()).data?.title).toBe(
      "GROUP-QUEUED",
    );
    node.writeMode = "reject";
    const failed = await active
      .from("todos")
      .insert({ id: "retry", title: "GROUP-RETRY", done: false });
    expect(failed.error).not.toBeNull();
    const eventId = required(failed.meta?.receipts?.[0]).eventId;
    node.writeMode = "accept";
    await expect
      .poll(async () => await sdk.groups.hasReplayPending(), { timeout: 5000 })
      .toBe(false);
    const restored = checked(await sdk.groups.get(group.id));
    expect((await restored.from("todos").local().eq("id", "retry").single()).data?.title).toBe(
      "GROUP-RETRY",
    );
    const attempts = node.frames
      .filter((frame) => frame[0] === "EVENT" && (frame[1] as { id?: string }).id === eventId)
      .map((frame) => frame[1]);
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(attempts.every((event) => JSON.stringify(event) === JSON.stringify(attempts[0]))).toBe(
      true,
    );
    expect(JSON.stringify([...node.events.values()])).not.toContain("GROUP-QUEUED");
    expect(JSON.stringify([...node.events.values()])).not.toContain("GROUP-RETRY");
  }, 30000);

  test("manual and automatic flushes share queue ownership, and close stops later retries", async ({
    scope,
  }) => {
    const node = await relay(scope);
    node.writeMode = "reject";
    let failures = 0;
    const sdk = client(scope, [node], {
      offline: {
        autoReplay: {
          retryDelay: 100,
          maxRetryDelay: 100,
          onError: () => {
            failures++;
          },
        },
      },
    });
    expect(
      (await sdk.from("todos").insert({ id: "close", title: "CLOSE", done: false }).queue()).error,
    ).toBeNull();
    await expect.poll(() => failures).toBeGreaterThan(0);
    sdk.offline.stopAutoReplay();
    node.writeMode = "accept";
    const results = await Promise.all([sdk.offline.flush(), sdk.offline.flush()]);
    expect(results.flatMap((result) => result.data ?? [])).toHaveLength(1);
    expect(await sdk.offline.list()).toHaveLength(0);
    await sdk.closeAsync();
    expect(sdk.offline.autoReplayStatus.running).toBe(false);
  });

  test("replays through a custom transport without a connected native pool", async ({ scope }) => {
    const transport = new MemoryTransport();
    const sdk = client(scope, [], {
      relays: ["wss://custom.test"],
      transport,
      offline: { autoReplay: true },
    });
    expect(
      (await sdk.from("todos").insert({ id: "custom", title: "CUSTOM", done: false }).queue())
        .error,
    ).toBeNull();
    await expect.poll(async () => (await sdk.offline.list()).length).toBe(0);
    expect(transport.published).toHaveLength(1);
    expect(sdk.pool.relays.size).toBe(0);
  });

  test("stop and close cancel in-flight replay, keep accepted receipts, and prevent later attempts", async ({
    scope,
  }) => {
    for (const close of [false, true]) {
      const accepted = await relay(scope);
      const silent = await relay(scope);
      silent.writeMode = "silence";
      const adapter = new MemoryPersistenceAdapter();
      const sdk = client(scope, [accepted, silent], {
        minWriteAcks: 2,
        offline: { adapter, autoReplay: { retryDelay: 40, maxRetryDelay: 40 } },
      });
      expect(
        (await sdk.from("todos").insert({ id: "pending", title: "PENDING", done: false }).queue())
          .error,
      ).toBeNull();
      await expect.poll(() => accepted.events.size).toBe(1);
      await expect.poll(() => silent.frames.some((frame) => frame[0] === "EVENT")).toBe(true);
      // Give the accepted ACK time to reach Applesauce while the other relay is silent.
      await expect.poll(() => accepted.subscriptions.size).toBe(0);
      if (close) await sdk.closeAsync();
      else sdk.offline.stopAutoReplay();
      await expect.poll(() => sdk.offline.autoReplayStatus.inFlight).toBe(false);
      const queue = await adapter.loadQueue("automatic-replay");
      expect(queue).toHaveLength(1);
      expect(
        queue[0]?.relays.some(
          (receipt) => receipt.url === new URL(accepted.url).toString() && receipt.ok,
        ),
      ).toBe(true);
      const attempts = silent.frames.filter((frame) => frame[0] === "EVENT").length;
      silent.writeMode = "accept";
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(silent.frames.filter((frame) => frame[0] === "EVENT")).toHaveLength(attempts);
      expect(sdk.offline.autoReplayStatus.lastResult).toBeUndefined();
    }
  });

  test("same account and device restart retries a pending Welcome with its saved ciphertext", async ({
    scope,
  }) => {
    const node = await relay(scope);
    const adapter = new MemoryGroupStateAdapter();
    scope.defer(() => adapter.close());
    const groupOptions = { adapter, deviceId: "f".repeat(64) };
    const admin = client(scope, [node], { groups: groupOptions });
    const member = client(scope, [node], { signer: bob });
    const group = checked(await admin.groups.create({ name: "Restart Welcome" }));
    expect(
      (await group.from("todos").insert({ id: "history", title: "RESTART-HISTORY", done: false }))
        .error,
    ).toBeNull();
    expect((await member.groups.publishKeyPackage()).error).toBeNull();
    const before = node.frames.filter((frame) => frame[0] === "EVENT").length;
    node.rejectWriteNumber = before + 2;
    expect((await group.invite(await bob.getPublicKey())).error?.code).toBe("PUBLISH_FAILED");
    const failed = required(
      node.frames.find(
        (frame) => frame[0] === "EVENT" && (frame[1] as { kind?: number }).kind === 1059,
      )?.[1],
    );
    await admin.closeAsync();
    const restored = client(scope, [node], {
      groups: groupOptions,
      offline: { autoReplay: { retryDelay: 40, maxRetryDelay: 100 } },
    });
    await expect
      .poll(() => [...node.events.values()].some((event) => event.kind === 1059))
      .toBe(true);
    await expect.poll(() => restored.groups.hasReplayPending()).toBe(false);
    const attempts = node.frames
      .filter((frame) => frame[0] === "EVENT" && (frame[1] as { kind?: number }).kind === 1059)
      .map((frame) => frame[1]);
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(attempts.every((event) => JSON.stringify(event) === JSON.stringify(failed))).toBe(true);
    const invite = required(checked(await member.groups.invites())[0]);
    const joined = checked(await member.groups.join(invite.id));
    expect((await joined.from("todos").eq("id", "history").single()).data?.title).toBe(
      "RESTART-HISTORY",
    );
  }, 30000);
});

test("get and list wait for device recovery before loading cached group state", async ({
  scope,
}) => {
  const transport = new MemoryTransport();
  const { client: sdk } = scope.client({ transport });
  const group = checked(await sdk.groups.create({ name: "Recovery admission race" }));
  const before = group.info.epoch;
  transport.publishStatuses = [{ url: "wss://relay.test/", ok: false }];
  expect((await group.rotate()).error).not.toBeNull();
  transport.publishStatuses = undefined;
  // Hold the WAL restore boundary while concurrent manager admissions arrive.
  const context = (
    sdk.groups as unknown as {
      context: {
        handles: Map<string, unknown>;
        durability: { recover(): Promise<void> };
      };
    }
  ).context;
  const recover = context.durability.recover.bind(context.durability);
  const entered = deferred();
  const resume = deferred();
  context.durability.recover = async () => {
    entered.resolve();
    await resume.promise;
    return recover();
  };
  const flushing = sdk.groups.flush();
  await entered.promise;
  const opened = sdk.groups.get(group.id);
  const listed = sdk.groups.list();
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(context.handles.has(group.id)).toBe(false);
  } finally {
    resume.resolve();
  }
  expect((await flushing).error).toBeNull();
  expect(checked(await opened).info.epoch).toBe(before + 1n);
  expect(checked(await listed).find((value) => value.id === group.id)?.epoch).toBe(before + 1n);
  expect(checked(await sdk.groups.get(group.id)).info.epoch).toBe(before + 1n);
});

test("automatic group replay restores retained account state after a failed signer replacement", async ({
  scope,
}) => {
  const { client: sdk } = scope.client();
  const group = checked(await sdk.groups.create({ name: "Retained account" }));
  sdk.offline.startAutoReplay({ initial: false, retryDelay: 40, maxRetryDelay: 100 });
  expect(
    (await group.from("todos").insert({ id: "queued", title: "retained", done: false }).queue())
      .error,
  ).toBeNull();
  const identity = deferred<string>();
  const login = sdk.auth.signInWithSigner({
    getPublicKey: () => identity.promise,
    signEvent: (event) => alice.signEvent(event),
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(sdk.offline.autoReplayStatus.lastResult).toBeUndefined();
  identity.reject(new Error("denied"));
  expect((await login).error?.code).toBe("AUTH_FAILED");
  expect((await sdk.auth.getSession()).data?.user.pubkey).toBe(await alice.getPublicKey());
  await expect.poll(() => sdk.groups.hasReplayPending()).toBe(false);
  const restored = checked(await sdk.groups.get(group.id));
  expect((await restored.from("todos").local().eq("id", "queued").single()).data?.title).toBe(
    "retained",
  );
  expect(() => group.info).toThrowError(/no longer active/);
});
