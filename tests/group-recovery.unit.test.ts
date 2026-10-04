import {
  createApplicationMessageIntent,
  createChatRumor,
  MarmotClient,
} from "@internet-privacy/marmot-ts/client";
import type {
  NostrNetworkInterface,
  PublishResponse,
  StoredKeyPackage,
} from "@internet-privacy/marmot-ts/client";
import { deserializeClientState } from "@internet-privacy/marmot-ts/core";
import { GroupHistoryTree } from "@internet-privacy/marmot-ts/engine";
import { Subject } from "rxjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GroupDurability, GroupPublicationPersistenceError } from "../src/group-recovery";
import type { GroupApplicationPublication, GroupPublicationRecord } from "../src/group-recovery";
import { EncryptedGroupStore, MemoryGroupStateAdapter } from "../src/group-store";
import { alice, bob } from "./helpers";
import type { NostrEvent } from "../src/types";

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.restoreAllMocks();
});
async function fixture() {
  const adapter = new MemoryGroupStateAdapter();
  const captured: string[] = [];
  const originalSet = adapter.set.bind(adapter);
  vi.spyOn(adapter, "set").mockImplementation(async (key, value) => {
    captured.push(value);
    await originalSet(key, value);
  });
  const account = await alice.getPublicKey();
  let revoked = false;
  const guard = () => {
    if (revoked) throw new Error("account changed");
  };
  function bucket<T>(name: string) {
    return new EncryptedGroupStore<T>(
      adapter,
      { namespace: "recovery-test", account, device: "1".repeat(64), bucket: name },
      alice,
      guard,
    );
  }
  const stateStore = bucket<Uint8Array>("states");
  const rewindStore = bucket<Uint8Array>("rewind");
  const journal = bucket<GroupPublicationRecord>("journal");
  const keyPackageStore = bucket<StoredKeyPackage>("packages");
  const live = new Subject<NostrEvent>();
  const published: NostrEvent[] = [];
  let crash: "before-ack-ledger" | "after-ack-ledger" | "no-ack" | undefined;
  let application: GroupApplicationPublication | undefined;
  let prepareFailure = false;
  let failedWelcomes = false;
  let durability: GroupDurability;
  const network: NostrNetworkInterface = {
    request: async () => [],
    subscription: () => live,
    getUserInboxRelays: async () => ["wss://r.test"],
    publish: async (relays, event) => {
      published.push(structuredClone(event));
      const response = Object.fromEntries(
        relays.map((from) => [
          from,
          {
            from,
            ok: crash !== "no-ack" && !(failedWelcomes && event.kind === 1059),
          } satisfies PublishResponse,
        ]),
      );
      if (crash === "before-ack-ledger") throw new Error("simulated crash");
      await durability.recordResponse(event, response);
      if (crash === "after-ack-ledger") throw new Error("simulated crash");
      return response;
    },
  };
  const projections: GroupPublicationRecord[] = [];
  durability = new GroupDurability({
    journal,
    stateStore,
    rewindStore,
    network,
    guard,
    onPublication: (record) => {
      projections.push(record);
    },
    application: () => application,
    prepared: async (record) => {
      expect((await journal.getItem(`${record.groupId}/${record.envelope.id}`))?.status).toBe(
        "prepared",
      );
      if (prepareFailure) throw new Error("intent linking unavailable");
    },
  });
  function client() {
    const value = new MarmotClient({
      signer: alice,
      network,
      groupStateStore: stateStore,
      rewindStore,
      ingestStateStore: bucket<Uint8Array>("ingest"),
      keyPackageStore,
      clientId: "test",
    });
    disposers.push(() => {
      for (const group of value.groups.loaded) group.dispose();
    });
    return value;
  }
  const engine = client();
  const group = await engine.groups.create("recovery", { relays: ["wss://r.test"] });
  durability.install(group);
  disposers.push(() => {
    durability.close();
    adapter.close();
  });
  return {
    adapter,
    captured,
    journal,
    stateStore,
    rewindStore,
    network,
    group,
    durability,
    projections,
    published,
    client,
    setCrash: (value: typeof crash) => {
      crash = value;
    },
    revoke: () => {
      revoked = true;
    },
    setApplication: (value: GroupApplicationPublication) => {
      application = value;
    },
    failWelcomes: (value: boolean) => {
      failedWelcomes = value;
    },
    failPrepared: (value: boolean) => {
      prepareFailure = value;
    },
  };
}

describe("Marmot durable publication recovery", () => {
  it("recovers an acknowledged own commit from its staged child because its envelope cannot reconstruct that child", async () => {
    const f = await fixture();
    const parentEpoch = f.group.state.groupContext.epoch;
    f.setCrash("after-ack-ledger");
    await expect(f.group.selfUpdate()).rejects.toThrow();
    const records = await f.durability.list();
    expect(records).toHaveLength(1);
    const record = records[0];
    if (!record) throw new Error("Expected publication record");
    expect(record.status).toBe("published");
    expect(record.pending?.newState).toBeInstanceOf(Uint8Array);
    expect(
      deserializeClientState((await f.stateStore.getItem(f.group.idStr)) as Uint8Array).groupContext
        .epoch,
    ).toBe(parentEpoch);
    f.group.dispose();
    const unrecovered = f.client();
    const old = await unrecovered.groups.get(f.group.idStr);
    const results = [];
    for await (const result of old.ingest([record.envelope])) results.push(result);
    expect(old.state.groupContext.epoch).toBe(parentEpoch);
    expect(
      results.some((result) => result.kind === "processed" && result.result.kind === "newState"),
    ).toBe(false);
    old.dispose();
    f.setCrash(undefined);
    await f.durability.recover();
    expect(f.published).toHaveLength(1); // Known ACKs are not republished.
    const restored = await f.client().groups.get(f.group.idStr);
    expect(restored.state.groupContext.epoch).toBe(parentEpoch + 1n);
    const tree = await GroupHistoryTree.load(f.rewindStore, f.group.idStr);
    const childTag = Array.from(restored.state.confirmationTag, (value) =>
      value.toString(16).padStart(2, "0"),
    ).join("");
    expect(tree?.path(childTag)).toHaveLength(2);
    expect(await tree?.ownCommitStampOf(childTag)).toBeDefined();
    expect(f.projections).toHaveLength(1);
    expect((await f.durability.list())[0]?.status).toBe("applied");
  });
  it("retries the exact signed envelope when a crash leaves acknowledgement uncertain", async () => {
    const f = await fixture();
    f.setCrash("before-ack-ledger");
    await expect(f.group.selfUpdate()).rejects.toThrow();
    expect((await f.durability.list())[0]?.status).toBe("prepared");
    f.group.dispose();
    f.setCrash(undefined);
    await f.durability.recover();
    expect(f.published).toHaveLength(2);
    expect(f.published[1]).toEqual(f.published[0]);
    expect((await f.durability.list())[0]?.status).toBe("applied");
    await f.durability.recover();
    expect(f.published).toHaveLength(2);
    expect(f.projections).toHaveLength(1);
  });
  it("retains local application proof and consumed ratchet state without exposing unconfirmed projection", async () => {
    const f = await fixture();
    const rumor = createChatRumor({
      pubkey: await alice.getPublicKey(),
      content: "private application secret",
    });
    const stateTag = Array.from(f.group.state.confirmationTag, (value) =>
      value.toString(16).padStart(2, "0"),
    ).join("");
    f.setApplication({ rumor, stateTag, epoch: f.group.state.groupContext.epoch });
    f.setCrash("after-ack-ledger");
    await expect(f.group.submitIntent(createApplicationMessageIntent(rumor))).rejects.toThrow();
    const record = (await f.durability.list())[0];
    if (!record) throw new Error("Expected application WAL");
    expect(record.application?.rumor).toEqual(rumor);
    expect(record.baselineState).not.toEqual(record.postState);
    expect(await f.stateStore.getItem(f.group.idStr)).toEqual(record.postState);
    expect(f.projections).toEqual([]);
    expect(f.captured.join("\n")).not.toContain("private application secret");
    f.group.dispose();
    f.setCrash(undefined);
    await f.durability.recover();
    expect(f.projections[0]?.application?.rumor).toEqual(rumor);
    expect(f.published).toHaveLength(1);
    expect((await f.durability.list())[0]?.status).toBe("applied");
  });
  it("keeps no-ACK publications pending and blocks a new operation before cryptographic preparation", async () => {
    const f = await fixture();
    f.setCrash("no-ack");
    await expect(f.group.selfUpdate()).rejects.toThrow();
    expect((await f.durability.list())[0]?.status).toBe("prepared");
    expect(f.projections).toEqual([]);
    await expect(f.group.selfUpdate()).rejects.toThrow(/Recover/);
    expect(f.published).toHaveLength(1);
    f.group.dispose();
    f.setCrash(undefined);
    await f.durability.recover();
    expect(f.published).toHaveLength(2);
    expect(f.published[1]).toEqual(f.published[0]);
  });
  it("journals work before linking caller intents and can recover after link persistence fails", async () => {
    const f = await fixture();
    f.failPrepared(true);
    await expect(f.group.selfUpdate()).rejects.toThrow("intent linking unavailable");
    const record = (await f.durability.list())[0];
    expect(record?.status).toBe("prepared");
    expect(f.published).toEqual([]);
    await expect(f.group.selfUpdate()).rejects.toThrow(/Recover/);
    f.group.dispose();
    await f.durability.recover();
    expect(f.published).toEqual([record?.envelope]);
    expect((await f.durability.list())[0]?.status).toBe("applied");
    const group = await f.client().groups.get(f.group.idStr);
    expect(group.state.groupContext.epoch).toBe(1n);
  });
  it("captures the leave facade baseline and restores an acknowledged self-remove proposal", async () => {
    const f = await fixture();
    f.setCrash("after-ack-ledger");
    const effects = await f.group.session.leave(await alice.getPublicKey());
    await expect(f.group.runtime.publishEffects(effects)).rejects.toThrow();
    const record = (await f.durability.list())[0];
    if (!record?.pending) throw new Error("Expected leave proposal WAL");
    expect(record.kind).toBe("proposal");
    expect(record.status).toBe("published");
    expect(record.baselineState).toBeInstanceOf(Uint8Array);
    expect(await f.stateStore.getItem(f.group.idStr)).toEqual(record.baselineState);
    f.group.dispose();
    f.setCrash(undefined);
    await f.durability.recover();
    expect(f.published).toHaveLength(1);
    expect(await f.stateStore.getItem(f.group.idStr)).toEqual(record.pending.newState);
    expect((await f.durability.list())[0]?.status).toBe("applied");
  });
  it("persists failed Welcome fanout and retries it without republishing an irreversible invite commit", async () => {
    const f = await fixture();
    const account = await bob.getPublicKey();
    function bucket<T>(name: string) {
      return new EncryptedGroupStore<T>(
        f.adapter,
        { namespace: "recovery-test", account, device: "2".repeat(64), bucket: name },
        bob,
        () => {},
      );
    }
    const invitee = new MarmotClient({
      signer: bob,
      network: f.network,
      groupStateStore: bucket<Uint8Array>("states"),
      keyPackageStore: bucket<StoredKeyPackage>("packages"),
      clientId: "bob",
    });
    const packageInfo = await invitee.keyPackages.create({ relays: ["wss://r.test"] });
    const keyPackage = (await invitee.keyPackages.get(packageInfo.keyPackageRef))?.published?.[0];
    if (!keyPackage) throw new Error("Expected key package event");
    f.failWelcomes(true);
    // Get the already installed object through a minimal manager-free send; the
    // existing group's engine prepares the real Add and Welcome.
    const { createInviteIntent } = await import("@internet-privacy/marmot-ts/client");
    await f.group.submitIntent(
      createInviteIntent({ keyPackageEvent: keyPackage, actorPubkey: await alice.getPublicKey() }),
    );
    expect(await f.durability.pendingWelcomes()).toHaveLength(1);
    expect((await f.durability.deliverWelcomes(f.group))[0]?.kind).toBe("failed");
    f.failWelcomes(false);
    expect((await f.durability.deliverWelcomes(f.group))[0]?.kind).toBe("succeeded");
    expect(await f.durability.pendingWelcomes()).toEqual([]);
    expect(f.published.filter((event) => event.kind === 445)).toHaveLength(1);
  });
  it("writes only ciphertext values and guards recovery before network access", async () => {
    const f = await fixture();
    f.setCrash("before-ack-ledger");
    await expect(f.group.selfUpdate()).rejects.toThrow();
    expect(f.captured.every((value) => JSON.parse(value).encryption === "nip44-self")).toBe(true);
    expect(f.captured.join("\n")).not.toContain("recovery-test");
    f.revoke();
    await expect(f.durability.recover()).rejects.toThrow("account changed");
    expect(f.published).toHaveLength(1);
  });
  it("reports accepted publication persistence failures without exposing the private WAL", async () => {
    const f = await fixture();
    const originalSet = f.journal.setItem.bind(f.journal);
    vi.spyOn(f.journal, "setItem").mockImplementation(async (key, value) => {
      if (value.result) throw new Error("storage unavailable");
      return originalSet(key, value);
    });
    const error = await f.group.selfUpdate().catch((value) => value);
    expect(error).toBeInstanceOf(GroupPublicationPersistenceError);
    expect(error.publications[0].response["wss://r.test"].ok).toBe(true);
    expect(JSON.stringify(error)).not.toContain("newState");
    expect(JSON.stringify(error)).not.toContain("postState");
    expect((await f.durability.list())[0]?.status).toBe("published");
    vi.restoreAllMocks();
    await f.durability.recover();
    expect(f.published).toHaveLength(1);
  });
});
