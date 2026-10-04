import type {
  DispositionedIngestResult,
  NostrNetworkInterface,
  StoredKeyPackage,
} from "@internet-privacy/marmot-ts/client";
import {
  createApplicationMessageIntent,
  createChatRumor,
  MarmotClient,
} from "@internet-privacy/marmot-ts/client";
import { InMemoryKeyValueStore } from "@internet-privacy/marmot-ts/extra";
import { Subject } from "rxjs";
import { describe, expect, vi } from "vitest";
import type { NostrEvent } from "../src/types";
import { alice, bob } from "./helpers";
import type { TestScope } from "./support/lifecycle";
import { deferred, required, test } from "./support/lifecycle";

async function fixture(scope: TestScope) {
  const published: NostrEvent[] = [];
  const network: NostrNetworkInterface = {
    request: async () => [],
    subscription: () => new Subject<NostrEvent>(),
    getUserInboxRelays: async () => ["wss://ingress.test"],
    publish: async (relays, event) => {
      published.push(event);
      return Object.fromEntries(relays.map((from) => [from, { from, ok: true }]));
    },
  };
  const states = new InMemoryKeyValueStore<Uint8Array>();
  const rewind = new InMemoryKeyValueStore<Uint8Array>();
  const ingest = new InMemoryKeyValueStore<Uint8Array>();
  const packages = new InMemoryKeyValueStore<StoredKeyPackage>();
  const sender = new MarmotClient({
    signer: alice,
    network,
    groupStateStore: new InMemoryKeyValueStore<Uint8Array>(),
    keyPackageStore: new InMemoryKeyValueStore<StoredKeyPackage>(),
    clientId: "ingress-sender",
  });
  const receiver = () => {
    const engine = new MarmotClient({
      signer: bob,
      network,
      groupStateStore: states,
      rewindStore: rewind,
      ingestStateStore: ingest,
      keyPackageStore: packages,
      clientId: "ingress-receiver",
    });
    scope.defer(() => {
      for (const group of engine.groups.loaded) group.dispose();
    });
    return engine;
  };
  scope.defer(() => {
    for (const group of sender.groups.loaded) group.dispose();
  });
  const reader = receiver();
  const owner = await sender.groups.create("Ingress boundary", {
    relays: ["wss://ingress.test"],
    adminPubkeys: [await alice.getPublicKey()],
  });
  const info = await reader.keyPackages.create({ relays: ["wss://ingress.test"] });
  const keyPackage = required((await reader.keyPackages.get(info.keyPackageRef))?.published?.[0]);
  await sender.groups.invite(owner.idStr, keyPackage);
  await reader.invites.ingestEvents(published.filter((event) => event.kind === 1059));
  await reader.invites.decryptGiftWraps();
  const invite = required((await reader.invites.getUnread())[0]);
  const { group } = await reader.joinGroupFromWelcome({ welcomeRumor: invite });
  const rumor = createChatRumor({ pubkey: await alice.getPublicKey(), content: "durable ingress" });
  await owner.submitIntent(createApplicationMessageIntent(rumor));
  const envelope = required(published.filter((event) => event.kind === 445).at(-1));
  const collect = async (target = group) => {
    const results: DispositionedIngestResult[] = [];
    for await (const result of target.session.ingest([envelope])) results.push(result);
    return results;
  };
  return { group, states, receiver, collect };
}

describe("patched Marmot incoming durability boundary", () => {
  test("awaits the application hook before any durable MLS state write", async ({ scope }) => {
    const f = await fixture(scope);
    const entered = deferred();
    const storage = deferred();
    const writes = vi.spyOn(f.states, "setItem");
    f.group.session.beforeIngestResult = async (result) => {
      if (result.kind !== "processed" || result.result.kind !== "applicationMessage") return;
      entered.resolve();
      await storage.promise;
    };
    const operation = f.collect();
    await entered.promise;
    expect(writes).not.toHaveBeenCalled();
    storage.resolve();
    const results = await operation;
    expect(
      results.some(
        (result) => result.kind === "processed" && result.result.kind === "applicationMessage",
      ),
    ).toBe(true);
    expect(writes).toHaveBeenCalled();
  });

  test("propagates durable-hook failure without state save and permits replay after reload", async ({
    scope,
  }) => {
    const f = await fixture(scope);
    const baseline = new Uint8Array(required(await f.states.getItem(f.group.idStr)));
    const writes = vi.spyOn(f.states, "setItem");
    f.group.session.beforeIngestResult = (result) => {
      if (result.kind === "processed" && result.result.kind === "applicationMessage")
        throw new Error("pending ingress storage failed");
    };
    await expect(f.collect()).rejects.toThrow("pending ingress storage failed");
    expect(writes).not.toHaveBeenCalled();
    expect(await f.states.getItem(f.group.idStr)).toEqual(baseline);
    f.group.dispose();
    const restored = await f.receiver().groups.get(f.group.idStr);
    const results = await f.collect(restored);
    expect(
      results.some(
        (result) => result.kind === "processed" && result.result.kind === "applicationMessage",
      ),
    ).toBe(true);
  });
});
