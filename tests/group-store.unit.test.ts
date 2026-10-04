import { PrivateKeySigner } from "applesauce-signers";
import { IDBFactory } from "fake-indexeddb";
import { getEventHash, verifyEvent } from "nostr-tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NostrbaseError } from "../src/errors";
import type { GroupStateAdapter, GroupStoreScope } from "../src/group-store";
import {
  EncryptedGroupStore,
  IndexedDBGroupStateAdapter,
  MemoryGroupStateAdapter,
} from "../src/group-store";
import type { Signer } from "../src/types";

const alice = new PrivateKeySigner(new Uint8Array(32).fill(3));
const bob = new PrivateKeySigner(new Uint8Array(32).fill(4));
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function scope(overrides: Partial<GroupStoreScope> = {}): Promise<GroupStoreScope> {
  return {
    namespace: "my-app",
    account: await alice.getPublicKey(),
    device: "ab".repeat(32),
    bucket: "mls",
    ...overrides,
  };
}
async function store<T>(
  adapter: GroupStateAdapter = new MemoryGroupStateAdapter(),
  overrides: Partial<GroupStoreScope> = {},
  signer: Signer = alice,
) {
  const current = await scope(overrides);
  let active = true;
  const guard = () => {
    if (!active) throw new NostrbaseError("AUTH_FAILED", "The active account changed.");
  };
  const encrypted = new EncryptedGroupStore<T>(adapter, current, signer, guard);
  return {
    adapter,
    encrypted,
    invalidate: () => {
      active = false;
    },
  };
}

describe("EncryptedGroupStore", () => {
  it("round-trips real NIP-44 encrypted nested bytes, bigint, undefined, and colliding user property names", async () => {
    const setup = await store<unknown>();
    const value = {
      secret: "application plaintext must not reach the adapter",
      bytes: new Uint8Array([0, 1, 128, 255]),
      epoch: 18446744073709551615n,
      array: [undefined, { bytes: new Uint8Array([7, 8]), value: -20n }],
      $type: "bytes",
      __codec: { type: "bigint", value: "not encoded" },
      nan: Number.NaN,
      negativeZero: -0,
    };
    const set = vi.spyOn(setup.adapter, "set");
    expect(await setup.encrypted.setItem("group:one", value)).toEqual(value);
    expect(await setup.encrypted.getItem("group:one")).toEqual(value);
    const saved = set.mock.calls[0]?.[1] ?? "";
    expect(saved).not.toContain(value.secret);
    expect(saved).not.toContain("18446744073709551615");
    expect(saved).not.toContain("application plaintext");
    const envelope = JSON.parse(saved);
    expect(envelope).toMatchObject({ v: 1, encryption: "nip44-self" });
    expect(envelope.chunks).toHaveLength(1);
    expect(await setup.encrypted.getItem("missing")).toBeNull();
  });
  it("drops verification symbols only from valid signed Nostr events stored by Marmot", async () => {
    const setup = await store<unknown>();
    const event = await alice.signEvent({
      kind: 443,
      created_at: 10,
      content: "real signed keypackage metadata",
      tags: [],
    });
    expect(verifyEvent(event)).toBe(true);
    expect(Object.getOwnPropertySymbols(event).length).toBeGreaterThan(0);
    await setup.encrypted.setItem("keypackage", { published: event });
    const reopened = (await setup.encrypted.getItem("keypackage")) as { published: typeof event };
    expect(reopened.published).toEqual(structuredClone(event));
    expect(Object.getOwnPropertySymbols(reopened.published)).toHaveLength(0);
    await expect(
      setup.encrypted.setItem("unknown-symbol", { value: 1, [Symbol("secret")]: "unsupported" }),
    ).rejects.toMatchObject({ code: "INVALID_RECORD" });
    await expect(
      setup.encrypted.setItem("tampered-signed-event", { ...event, content: "tampered" }),
    ).rejects.toMatchObject({ code: "INVALID_RECORD" });
  });
  it("drops cache symbols from canonical unsigned Welcome rumors without accepting forged rumors or added fields", async () => {
    const setup = await store<unknown>();
    const rumor = {
      id: "",
      pubkey: await alice.getPublicKey(),
      kind: 444,
      created_at: 10,
      tags: [["p", await bob.getPublicKey()]],
      content: "serialized welcome",
    };
    rumor.id = getEventHash(rumor);
    const decorated = { ...rumor, [Symbol("wrap_id")]: "cache metadata" };
    await setup.encrypted.setItem("unread-invite", { rumor: decorated });
    expect(await setup.encrypted.getItem("unread-invite")).toEqual({ rumor });
    await expect(
      setup.encrypted.setItem("bad-rumor", { ...decorated, content: "tampered" }),
    ).rejects.toMatchObject({ code: "INVALID_RECORD" });
    await expect(
      setup.encrypted.setItem("extra-rumor-fields", { ...decorated, unbound: "metadata" }),
    ).rejects.toMatchObject({ code: "INVALID_RECORD" });
  });
  it("chunks large states below NIP-44's plaintext limit and preserves Unicode", async () => {
    const setup = await store<{ bytes: Uint8Array; text: string }>();
    const value = { bytes: new Uint8Array(70000).fill(25), text: "ไทย 🌱".repeat(3000) };
    const encrypt = vi.spyOn(alice.nip44, "encrypt");
    await setup.encrypted.setItem("large", value);
    expect(encrypt.mock.calls.length).toBeGreaterThan(1);
    expect(
      encrypt.mock.calls.every(([, plain]) => new TextEncoder().encode(plain).length < 65535),
    ).toBe(true);
    expect(await setup.encrypted.getItem("large")).toEqual(value);
  });
  it("partitions keys across namespace, account, device, and bucket on one adapter", async () => {
    const adapter = new MemoryGroupStateAdapter();
    const contexts = [
      await store<string>(adapter),
      await store<string>(adapter, { namespace: "other-app" }),
      await store<string>(adapter, { account: await bob.getPublicKey() }, bob),
      await store<string>(adapter, { device: "cd".repeat(32) }),
      await store<string>(adapter, { bucket: "application-log" }),
    ];
    for (const [index, setup] of contexts.entries())
      await setup.encrypted.setItem("same-key", `value-${index}`);
    expect(await adapter.keys()).toHaveLength(5);
    for (const [index, setup] of contexts.entries()) {
      expect(await setup.encrypted.keys()).toEqual(["same-key"]);
      expect(await setup.encrypted.getItem("same-key")).toBe(`value-${index}`);
    }
    await contexts[0]?.encrypted.clear();
    expect(await contexts[0]?.encrypted.keys()).toEqual([]);
    expect(await contexts[1]?.encrypted.getItem("same-key")).toBe("value-1");
  });
  it("rejects ciphertext moved to a different key or bucket", async () => {
    const adapter = new MemoryGroupStateAdapter();
    const setup = await store<string>(adapter);
    const other = await store<string>(adapter, { bucket: "queue" });
    await setup.encrypted.setItem("original", "bound-secret");
    const ciphertext = await adapter.get(setup.encrypted.prefix + encodeURIComponent("original"));
    if (!ciphertext) throw new Error("Missing ciphertext fixture");
    await adapter.set(setup.encrypted.prefix + encodeURIComponent("moved"), ciphertext);
    await adapter.set(other.encrypted.prefix + encodeURIComponent("original"), ciphertext);
    await expect(setup.encrypted.getItem("moved")).rejects.toMatchObject({
      code: "INVALID_RECORD",
    });
    await expect(other.encrypted.getItem("original")).rejects.toMatchObject({
      code: "INVALID_RECORD",
    });
  });
  it("rejects tampered ciphertext and chunk mixtures between different writes", async () => {
    const adapter = new MemoryGroupStateAdapter();
    const setup = await store<string>(adapter);
    const storageKey = `${setup.encrypted.prefix}large`;
    await setup.encrypted.setItem("large", "first-version".repeat(8000));
    const first = JSON.parse((await adapter.get(storageKey)) ?? "{}");
    await setup.encrypted.setItem("large", "second-value!".repeat(8000));
    const second = JSON.parse((await adapter.get(storageKey)) ?? "{}");
    second.chunks[1] = first.chunks[1];
    await adapter.set(storageKey, JSON.stringify(second));
    await expect(setup.encrypted.getItem("large")).rejects.toMatchObject({
      code: "INVALID_RECORD",
    });
    second.chunks[0] = "not-ciphertext";
    await adapter.set(storageKey, JSON.stringify(second));
    await expect(setup.encrypted.getItem("large")).rejects.toThrow();
  });
  it("does not persist after an account change while encryption is delayed", async () => {
    const pause = deferred<void>();
    const entered = deferred<void>();
    const original = alice.nip44.encrypt.bind(alice.nip44);
    const signer: Signer = {
      getPublicKey: () => alice.getPublicKey(),
      signEvent: (event) => alice.signEvent(event),
      nip44: {
        encrypt: async (...args) => {
          entered.resolve();
          await pause.promise;
          return original(...args);
        },
        decrypt: (...args) => alice.nip44.decrypt(...args),
      },
    };
    const setup = await store<string>(undefined, {}, signer);
    const operation = setup.encrypted.setItem("key", "must not be saved");
    await entered.promise;
    setup.invalidate();
    pause.resolve();
    await expect(operation).rejects.toMatchObject({ code: "AUTH_FAILED" });
    expect(await setup.adapter.keys()).toEqual([]);
  });
  it("does not expose plaintext after an account change while decryption is delayed", async () => {
    const adapter = new MemoryGroupStateAdapter();
    const writer = await store<string>(adapter);
    await writer.encrypted.setItem("key", "must not escape");
    const pause = deferred<void>();
    const entered = deferred<void>();
    const original = alice.nip44.decrypt.bind(alice.nip44);
    const signer: Signer = {
      getPublicKey: () => alice.getPublicKey(),
      signEvent: (event) => alice.signEvent(event),
      nip44: {
        encrypt: (...args) => alice.nip44.encrypt(...args),
        decrypt: async (...args) => {
          entered.resolve();
          await pause.promise;
          return original(...args);
        },
      },
    };
    const setup = await store<string>(adapter, {}, signer);
    const operation = setup.encrypted.getItem("key");
    await entered.promise;
    setup.invalidate();
    pause.resolve();
    await expect(operation).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });
  it("rejects a signer from a different account and stale guard after adapter reads", async () => {
    const setup = await store<string>(undefined, {}, bob);
    await expect(setup.encrypted.setItem("key", "wrong account")).rejects.toMatchObject({
      code: "AUTH_FAILED",
    });
    expect(await setup.adapter.keys()).toEqual([]);
    const current = await store<string>();
    const get = current.adapter.get.bind(current.adapter);
    vi.spyOn(current.adapter, "get").mockImplementation(async (key) => {
      const value = await get(key);
      current.invalidate();
      return value;
    });
    await expect(current.encrypted.getItem("missing")).rejects.toMatchObject({
      code: "AUTH_FAILED",
    });
  });
  it("propagates durability failures without returning state as committed", async () => {
    const setup = await store<string>();
    vi.spyOn(setup.adapter, "set").mockRejectedValue(new Error("disk quota exceeded"));
    await expect(setup.encrypted.setItem("key", "uncommitted secret")).rejects.toThrow(
      "disk quota exceeded",
    );
    expect(await setup.encrypted.getItem("key")).toBeNull();
    vi.spyOn(setup.adapter, "remove").mockRejectedValue(new Error("delete failed"));
    await expect(setup.encrypted.removeItem("key")).rejects.toThrow("delete failed");
  });
  it("snapshots caller values before delayed encryption and refuses unsupported or cyclic values", async () => {
    const setup = await store<unknown>();
    const value = { bytes: new Uint8Array([1]), name: "original" };
    const operation = setup.encrypted.setItem("key", value);
    value.name = "modified";
    value.bytes[0] = 8;
    expect(await operation).toEqual({ bytes: new Uint8Array([1]), name: "original" });
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    await expect(setup.encrypted.setItem("cycle", cycle)).rejects.toMatchObject({
      code: "INVALID_RECORD",
    });
    await expect(setup.encrypted.setItem("date", new Date())).rejects.toMatchObject({
      code: "INVALID_RECORD",
    });
    await expect(setup.encrypted.setItem("function", () => 0)).rejects.toMatchObject({
      code: "INVALID_RECORD",
    });
  });
});

describe("IndexedDBGroupStateAdapter", () => {
  it("commits encrypted state, closes and reopens without plaintext on disk", async () => {
    const factory = new IDBFactory();
    let adapter = new IndexedDBGroupStateAdapter("durable-groups", factory);
    const setup = await store<{ epoch: bigint; bytes: Uint8Array }>(adapter);
    const value = { epoch: 99n, bytes: new Uint8Array([1, 9, 5]) };
    await setup.encrypted.setItem("group", value);
    const key = (await adapter.keys())[0];
    if (!key) throw new Error("Missing stored key");
    expect(await adapter.get(key)).not.toContain("epoch");
    await adapter.close();
    await expect(adapter.get(key)).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    adapter = new IndexedDBGroupStateAdapter("durable-groups", factory);
    cleanups.push(() => adapter.close());
    const reopened = await store<typeof value>(adapter);
    expect(await reopened.encrypted.getItem("group")).toEqual(value);
    await reopened.encrypted.removeItem("group");
    expect(await adapter.keys()).toEqual([]);
  });
  it("fails closed when close races with initial open", async () => {
    const adapter = new IndexedDBGroupStateAdapter("early-close", new IDBFactory());
    const closing = adapter.close();
    await expect(adapter.set("key", "cipher")).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    await expect(closing).resolves.toBeUndefined();
  });
  it("reports open and transaction failures instead of falling back to memory", async () => {
    const factory = new IDBFactory();
    vi.spyOn(factory, "open").mockImplementation(() => {
      throw new Error("open unavailable");
    });
    const failure = new IndexedDBGroupStateAdapter("failed-open", factory);
    await expect(failure.get("key")).rejects.toThrow("open unavailable");
    await expect(failure.close()).rejects.toThrow("open unavailable");
    const working = new IndexedDBGroupStateAdapter("failed-commit", new IDBFactory());
    cleanups.push(() => working.close());
    await working.set("one", "encrypted-string");
    // Invalid IDB keys must fail a transaction, rather than report a successful write.
    await expect(working.set(undefined as unknown as string, "encrypted-string")).rejects.toThrow();
    expect(await working.keys()).toEqual(["one"]);
  });
});
