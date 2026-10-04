import { PrivateKeySigner } from "applesauce-signers";
import { getEventHash } from "nostr-tools";
import { describe, expect, it, vi } from "vitest";
import type { GroupRecordEntry, GroupRecordRumor } from "../src/group-records";
import {
  GroupRecordJournal,
  groupRecordDeletionTemplate,
  groupRecordRumor,
  groupRecordTemplate,
  parseGroupRecordRumor,
} from "../src/group-records";
import type { GroupStoreScope } from "../src/group-store";
import { EncryptedGroupStore, MemoryGroupStateAdapter } from "../src/group-store";
import type { NostrEvent, Signer, TableDefinition } from "../src/types";

const alice = new PrivateKeySigner(new Uint8Array(32).fill(5));
const bob = new PrivateKeySigner(new Uint8Array(32).fill(6));
const namespace = "shared-app";
const groupId = "a1".repeat(32);
const otherGroup = "b2".repeat(32);
type Todo = { title: string; done: boolean };
const definition = (table: string): TableDefinition<object> | undefined =>
  table === "todos"
    ? {
        validate: (value): value is Todo =>
          typeof value === "object" &&
          value !== null &&
          typeof (value as Todo).title === "string" &&
          typeof (value as Todo).done === "boolean",
      }
    : undefined;
async function proof(
  id = "task",
  updatedAt = 10,
  signer: Signer = alice,
  title = "first",
  group = groupId,
): Promise<NostrEvent> {
  return signer.signEvent(
    groupRecordTemplate(namespace, group, "todos", id, { title, done: false }, 10, updatedAt),
  );
}
async function entry(
  proofs: NostrEvent[],
  options: {
    sender?: Signer;
    type?: GroupRecordEntry["type"];
    tag?: string;
    epoch?: bigint;
    time?: number;
  } = {},
): Promise<GroupRecordEntry> {
  const sender = await (options.sender ?? alice).getPublicKey();
  const type = options.type ?? "record";
  const rumor = groupRecordRumor(namespace, groupId, type, proofs, sender, options.time ?? 100);
  return {
    rumor,
    rumorId: rumor.id,
    sender,
    stateTag: options.tag ?? "root",
    epoch: options.epoch ?? 1n,
    proofs,
    type,
  };
}
async function context(adapter = new MemoryGroupStateAdapter()) {
  const scope: GroupStoreScope = {
    namespace,
    account: await alice.getPublicKey(),
    device: "00".repeat(32),
    bucket: "journal",
  };
  let closed = false;
  const guard = () => {
    if (closed) throw new Error("closed identity");
  };
  const store = new EncryptedGroupStore<GroupRecordEntry>(adapter, scope, alice, guard);
  const journal = new GroupRecordJournal(namespace, groupId, store, definition, guard);
  await journal.ready();
  return {
    journal,
    store,
    adapter,
    invalidate: () => {
      closed = true;
    },
  };
}
const active = (...tags: string[]) => new Set(tags);

describe("shared group signed record journal", () => {
  it("stores encrypted proofs before exposing rows, retains author metadata, and handles duplicate rumor admissions", async () => {
    const setup = await context();
    const signed = await proof();
    const admitted = await entry([signed]);
    expect(await setup.journal.admit(admitted)).toBe(true);
    expect(await setup.journal.admit(admitted)).toBe(false);
    expect(setup.journal.has(admitted.rumorId)).toBe(true);
    expect(setup.journal.rows<Todo>("todos", active("root"))).toEqual([
      {
        id: "task",
        title: "first",
        done: false,
        _nostr: { pubkey: signed.pubkey, eventId: signed.id, createdAt: 10, updatedAt: 10 },
      },
    ]);
    expect(setup.journal.proof(signed.id)?.id).toBe(signed.id);
    const storedKey = (await setup.adapter.keys())[0];
    if (!storedKey) throw new Error("No journal key");
    expect(await setup.adapter.get(storedKey)).not.toContain("first");
  });
  it("keeps a failed durable admission invisible", async () => {
    const setup = await context();
    const admitted = await entry([await proof()]);
    vi.spyOn(setup.store, "setItem").mockRejectedValue(new Error("quota failed"));
    await expect(setup.journal.admit(admitted)).rejects.toThrow("quota failed");
    expect(setup.journal.has(admitted.rumorId)).toBe(false);
    expect(setup.journal.rows("todos", active("root"))).toEqual([]);
  });
  it("rejects a tampered proof and a valid proof signed by another direct sender", async () => {
    const setup = await context();
    const signed = await proof();
    await expect(
      setup.journal.admit(await entry([{ ...signed, content: "forged" }])),
    ).rejects.toMatchObject({ code: "INVALID_RECORD" });
    await expect(setup.journal.admit(await entry([signed], { sender: bob }))).rejects.toMatchObject(
      { code: "PERMISSION_DENIED" },
    );
    expect(await setup.store.keys()).toEqual([]);
  });
  it("validates snapshots atomically while preserving original record authors", async () => {
    const setup = await context();
    const aliceProof = await proof("alice");
    const bobProof = await proof("bob", 11, bob, "bob row");
    await expect(
      setup.journal.admit(
        await entry([aliceProof, { ...bobProof, sig: "00".repeat(64) }], {
          sender: bob,
          type: "snapshot",
        }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_RECORD" });
    expect(setup.journal.rows("todos", active("root"))).toEqual([]);
    await setup.journal.admit(
      await entry([aliceProof, bobProof], { sender: bob, type: "snapshot" }),
    );
    expect(
      setup.journal
        .rows("todos", active("root"))
        .map((row) => row._nostr.pubkey)
        .sort(),
    ).toEqual([aliceProof.pubkey, bobProof.pubkey].sort());
  });
  it("selects latest timestamps and the lowest event ID on version ties without losing history", async () => {
    const setup = await context();
    const old = await proof("task", 10);
    const newer = await proof("task", 11, alice, "newer");
    const tied = await proof("task", 11, alice, "tie");
    await setup.journal.admit(await entry([old]));
    await setup.journal.admit(await entry([newer], { time: 101 }));
    await setup.journal.admit(await entry([tied], { time: 102 }));
    const winner = [newer, tied].sort((a, b) => a.id.localeCompare(b.id))[0];
    expect(setup.journal.rows("todos", active("root"))[0]?._nostr.eventId).toBe(winner?.id);
    expect(setup.journal.proofs(active("root"))).toHaveLength(3);
  });
  it("applies author-scoped deletes and allows a newer replacement after an address tombstone", async () => {
    const setup = await context();
    const aliceProof = await proof();
    const bobProof = await proof("task", 10, bob, "bob");
    await setup.journal.admit(await entry([aliceProof]));
    await setup.journal.admit(await entry([bobProof], { sender: bob, time: 101 }));
    const deletion = await alice.signEvent(
      groupRecordDeletionTemplate(namespace, groupId, "todos", [aliceProof], 11),
    );
    await setup.journal.admit(await entry([deletion], { time: 102 }));
    expect(setup.journal.rows("todos", active("root")).map((row) => row._nostr.pubkey)).toEqual([
      bobProof.pubkey,
    ]);
    await setup.journal.admit(
      await entry([await proof("task", 12, alice, "recreated")], { time: 103 }),
    );
    expect(setup.journal.rows("todos", active("root"))).toHaveLength(2);
  });
  it("does not let another author's event-pointer deletion erase an owner's row", async () => {
    const setup = await context();
    const signed = await proof();
    await setup.journal.admit(await entry([signed]));
    const borrowed = groupRecordDeletionTemplate(namespace, groupId, "todos", [signed], 11);
    borrowed.tags = borrowed.tags.filter((tag) => tag[0] !== "a");
    const deletion = await bob.signEvent(borrowed);
    await setup.journal.admit(await entry([deletion], { sender: bob, time: 101 }));
    expect(setup.journal.rows("todos", active("root"))).toHaveLength(1);
    const invalidAddress = await bob.signEvent(
      groupRecordDeletionTemplate(namespace, groupId, "todos", [signed], 11),
    );
    await expect(
      setup.journal.admit(await entry([invalidAddress], { sender: bob, time: 102 })),
    ).rejects.toMatchObject({ code: "INVALID_RECORD" });
  });
  it("projects only canonical ancestry and can select an identical rumor admitted on another fork", async () => {
    const setup = await context();
    const root = await entry([await proof()], { tag: "root" });
    const left = await entry([await proof("task", 11, alice, "left")], {
      tag: "left",
      epoch: 2n,
      time: 101,
    });
    const right = await entry([await proof("task", 12, alice, "right")], {
      tag: "right",
      epoch: 2n,
      time: 102,
    });
    await setup.journal.admit(root);
    await setup.journal.admit(left);
    await setup.journal.admit(right);
    expect(setup.journal.rows<Todo>("todos", active("root", "left"))[0]?.title).toBe("left");
    expect(setup.journal.rows<Todo>("todos", active("root", "right"))[0]?.title).toBe("right");
    const duplicateOnRight = { ...left, stateTag: "right", epoch: 2n };
    expect(setup.journal.has(left.rumorId, "right")).toBe(false);
    expect(setup.journal.has(left.rumorId)).toBe(true);
    expect(await setup.journal.admit(duplicateOnRight)).toBe(true);
    expect(setup.journal.has(left.rumorId, "right")).toBe(true);
    expect(setup.journal.proofs(active("right"))).toHaveLength(2);
  });
  it("restores complete version and deletion history after restart without requiring current author membership", async () => {
    const adapter = new MemoryGroupStateAdapter();
    const setup = await context(adapter);
    const signed = await proof();
    const deletion = await alice.signEvent(
      groupRecordDeletionTemplate(namespace, groupId, "todos", [signed], 11),
    );
    const admitted = await entry([signed]);
    await setup.journal.admit(admitted);
    await setup.journal.admit(await entry([deletion], { time: 101 }));
    setup.journal.close();
    const restarted = await context(adapter);
    expect(restarted.journal.has(admitted.rumorId)).toBe(true);
    expect(restarted.journal.proof(signed.id)?.id).toBe(signed.id);
    expect(restarted.journal.proofs(active("root"))).toHaveLength(2);
    expect(restarted.journal.rows("todos", active("root"))).toEqual([]);
    restarted.journal.close();
    await expect(restarted.journal.ready()).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
  });
  it("rejects foreign group/namespace proofs, schema mismatches, and multi-table direct records", async () => {
    const setup = await context();
    await expect(
      setup.journal.admit(await entry([await proof("foreign", 10, alice, "foreign", otherGroup)])),
    ).rejects.toMatchObject({ code: "INVALID_RECORD" });
    const wrongNamespace = await alice.signEvent(
      groupRecordTemplate(
        "other-app",
        groupId,
        "todos",
        "ns",
        { title: "ns", done: false },
        10,
        10,
      ),
    );
    await expect(setup.journal.admit(await entry([wrongNamespace]))).rejects.toMatchObject({
      code: "INVALID_RECORD",
    });
    const invalidData = await alice.signEvent(
      groupRecordTemplate(namespace, groupId, "todos", "bad", { title: 1 }, 10, 10),
    );
    await expect(setup.journal.admit(await entry([invalidData]))).rejects.toMatchObject({
      code: "INVALID_RECORD",
    });
    const project = await alice.signEvent(
      groupRecordTemplate(namespace, groupId, "projects", "p", { name: "p" }, 10, 10),
    );
    await expect(setup.journal.admit(await entry([await proof(), project]))).rejects.toMatchObject({
      code: "INVALID_RECORD",
    });
    expect(await setup.store.keys()).toEqual([]);
  });
  it("normalizes rejecting schema callbacks to INVALID_RECORD before admitting any snapshot proof", async () => {
    const setup = await context();
    const journal = new GroupRecordJournal(namespace, groupId, setup.store, () => {
      throw new Error("schema callback rejected table");
    });
    await journal.ready();
    await expect(
      journal.admit(await entry([await proof()], { type: "snapshot" })),
    ).rejects.toMatchObject({ code: "INVALID_RECORD" });
    expect(journal.proofs(active("root"))).toEqual([]);
    expect(await setup.store.keys()).toEqual([]);
    journal.close();
  });
  it("rejects noncanonical rumor fields/hash and cap overflow, and parses canonical payloads for parent admission", async () => {
    const signed = await proof();
    const admitted = await entry([signed]);
    expect(parseGroupRecordRumor(admitted.rumor, namespace, groupId)?.proofs[0]?.id).toBe(
      signed.id,
    );
    expect(
      parseGroupRecordRumor({ ...admitted.rumor, sig: "forbidden" } as GroupRecordRumor),
    ).toBeNull();
    expect(parseGroupRecordRumor({ ...admitted.rumor, content: "tampered" })).toBeNull();
    expect(parseGroupRecordRumor(admitted.rumor, namespace, otherGroup)).toBeNull();
    const envelope = JSON.parse(admitted.rumor.content);
    envelope.proofs = Array(1001).fill(signed);
    const rumor = { ...admitted.rumor, content: JSON.stringify(envelope) };
    rumor.id = getEventHash(rumor);
    expect(parseGroupRecordRumor(rumor)).toBeNull();
  });
  it("does not expose durable state after the account/lifetime guard changes or allow caller mutation", async () => {
    const setup = await context();
    const admitted = await entry([await proof()]);
    const original = setup.store.setItem.bind(setup.store);
    vi.spyOn(setup.store, "setItem").mockImplementation(async (...args) => {
      const result = await original(...args);
      setup.invalidate();
      return result;
    });
    await expect(setup.journal.admit(admitted)).rejects.toThrow("closed identity");
    expect(() => setup.journal.rows("todos", active("root"))).toThrow("closed identity");
    const normal = await context();
    await normal.journal.admit(admitted);
    const rows = normal.journal.rows<Todo>("todos", active("root"));
    if (rows[0]) rows[0].title = "changed";
    const proofs = normal.journal.proofs(active("root"));
    if (proofs[0]) proofs[0].content = "changed";
    expect(normal.journal.rows<Todo>("todos", active("root"))[0]?.title).toBe("first");
  });
});
