import { describe, expect, vi } from "vitest";
import type { ChangePayload } from "../src";
import { addressOf, encodeRecord } from "../src/protocol";
import type { TestDB } from "./helpers";
import { alice, bob } from "./helpers";
import { deferred, required, test } from "./support/lifecycle";

/** Fixed-seed orders make a failed arrival-order scenario reproducible. */
function shuffled<T>(input: T[], seed: number): T[] {
  const values = [...input];
  let state = seed;
  for (let i = values.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [values[i], values[j]] = [required(values[j]), required(values[i])];
  }
  return values;
}

describe("record convergence across arrival orders", () => {
  test("replacement, author-scoped tombstones, duplicate echoes and recreation converge", async ({
    scope,
  }) => {
    const signed = async (title: string, timestamp: number) =>
      alice.signEvent(
        encodeRecord("test-app", "todos", "same", { title, done: false }, 10, timestamp),
      );
    const first = await signed("original", 10);
    const old = await signed("updated", 11);
    const recreated = await signed("recreated", 13);
    const tied = await signed("tied", 13);
    const deleted = await alice.signEvent({
      kind: 5,
      created_at: 12,
      content: "",
      tags: [["a", addressOf(first)]],
    });
    const forgedDelete = await bob.signEvent({
      kind: 5,
      created_at: 100,
      content: "",
      tags: [
        ["a", addressOf(first)],
        ["e", recreated.id],
      ],
    });
    const bobRow = await bob.signEvent(
      encodeRecord("test-app", "todos", "same", { title: "Bob's", done: false }, 10, 10),
    );
    const expected = required([recreated, tied].sort((a, b) => (a.id < b.id ? -1 : 1))[0]);
    const values = [first, old, deleted, forgedDelete, recreated, tied, bobRow, recreated];
    for (let seed = 1; seed <= 32; seed++) {
      const { client } = scope.client();
      for (const value of shuffled(values, seed)) client.ingest(value);
      const rows = (await client.from("todos").local()).data;
      expect(rows?.map((row) => row._nostr.eventId).sort(), `arrival seed ${seed}`).toEqual(
        [expected.id, bobRow.id].sort(),
      );
      await client.closeAsync();
    }
  });

  test("e-only deletion of a previous version cannot remove a later version", async ({ scope }) => {
    const { client } = scope.client();
    const first = await alice.signEvent(
      encodeRecord("test-app", "todos", "x", { title: "old", done: false }, 10, 10),
    );
    const newer = await alice.signEvent(
      encodeRecord("test-app", "todos", "x", { title: "new", done: false }, 10, 20),
    );
    client.ingest(first);
    client.ingest(newer);
    client.ingest(
      await alice.signEvent({ kind: 5, created_at: 30, content: "", tags: [["e", first.id]] }),
    );
    client.ingest(first);
    expect((await client.from("todos").local().single()).data?._nostr.eventId).toBe(newer.id);
  });
});

describe("mutation interruption and channel consistency", () => {
  for (const privateTable of [false, true]) {
    test(`pre-aborted ${privateTable ? "private" : "public"} cache reads perform no work`, async ({
      scope,
    }) => {
      const { client, transport } = scope.client();
      const controller = new AbortController();
      controller.abort();
      const table = privateTable ? client.private.from("todos") : client.from("todos");
      const result = await table.local().abortSignal(controller.signal);
      expect(result.error?.code).toBe("ABORTED");
      expect(result.data).toBeNull();
      expect(transport.requests).toEqual([]);
    });
  }

  test("an aborted batch retains the first acknowledged record and receipt, then releases the write lock", async ({
    scope,
  }) => {
    const { client, transport } = scope.client();
    const controller = new AbortController();
    const publish = transport.publish.bind(transport);
    vi.spyOn(transport, "publish").mockImplementation(async (relays, event) => {
      const receipt = await publish(relays, event);
      controller.abort();
      return receipt;
    });
    const result = await client
      .from("todos")
      .insert([
        { id: "a", title: "a", done: false },
        { id: "b", title: "b", done: false },
      ])
      .select()
      .abortSignal(controller.signal);
    expect(result.error?.code).toBe("ABORTED");
    expect(result.data?.map((row) => row.id)).toEqual(["a"]);
    expect(result.count).toBe(1);
    expect(result.meta?.receipts).toHaveLength(1);
    expect(result.meta?.partial).toBe(true);
    expect(transport.published).toHaveLength(1);
    expect(
      (await client.from("todos").insert({ id: "c", title: "c", done: false })).error,
    ).toBeNull();
  });

  test("a failed middle deletion preserves precise receipts and leaves later targets intact", async ({
    scope,
  }) => {
    const { client, transport } = scope.client();
    await client.from("todos").insert([
      { id: "a", title: "a", done: false },
      { id: "b", title: "b", done: false },
      { id: "c", title: "c", done: false },
    ]);
    transport.failPublishAt = 5;
    const result = await client.from("todos").delete().all().order("id").select();
    expect(result.error?.code).toBe("PUBLISH_FAILED");
    expect(result.data?.map((row) => row.id)).toEqual(["a"]);
    expect(result.meta?.receipts?.map((receipt) => [receipt.id, receipt.relays[0]?.ok])).toEqual([
      ["a", true],
      ["b", false],
    ]);
    expect((await client.from("todos").local()).data?.map((row) => row.id).sort()).toEqual([
      "b",
      "c",
    ]);
  });

  test("a delayed native signed publish uses an immutable event snapshot", async ({ scope }) => {
    const { client, transport } = scope.client();
    await client.ready();
    const signed = await alice.signEvent({
      kind: 1,
      created_at: 10,
      tags: [],
      content: "original",
    });
    const expected = structuredClone(signed);
    const pending = client.events.publishSigned(signed);
    signed.content = "changed by caller";
    const result = await pending;
    expect(result.error).toBeNull();
    expect(transport.published.map((value) => structuredClone(value))).toEqual([expected]);
    expect(structuredClone(result.data)).toEqual(expected);
  });

  test("a stale delete cannot emit a phantom DELETE after a newer version was read into the shared cache", async ({
    scope,
  }) => {
    const { client, transport } = scope.client();
    const old = await alice.signEvent(
      encodeRecord("test-app", "todos", "x", { title: "old", done: false }, 10, 10),
    );
    const newer = await alice.signEvent(
      encodeRecord("test-app", "todos", "x", { title: "new", done: false }, 10, 20),
    );
    const deletion = await alice.signEvent({
      kind: 5,
      created_at: 15,
      content: "",
      tags: [["a", addressOf(old)]],
    });
    const seen: string[] = [];
    const seeded = deferred();
    client.ingest(old);
    client
      .channel("shared-cache")
      .on("nostr_changes", { table: "todos" }, (change) => {
        seen.push(change.eventType);
        seeded.resolve();
      })
      .subscribe();
    await seeded.promise;
    // Simulate a completed relay read which updates the shared cache before this channel sees it.
    client.eventStore.add(newer);
    transport.live.next(deletion);
    expect(seen).toEqual(["INSERT"]);
    expect((await client.from("todos").local().single()).data?.title).toBe("new");
  });

  test("one table observer cannot alter the next observer's payload or future change history", async ({
    scope,
  }) => {
    const { client, transport } = scope.client();
    const received: ChangePayload<TestDB["todos"]>[] = [];
    client
      .channel("observers")
      .on("nostr_changes", { table: "todos" }, (change) => {
        if (change.new) change.new.title = "observer mutation";
      })
      .on("nostr_changes", { table: "todos" }, (change) => received.push(structuredClone(change)))
      .subscribe();
    const first = await alice.signEvent(
      encodeRecord("test-app", "todos", "x", { title: "first", done: false }, 10, 10),
    );
    transport.live.next(first);
    transport.live.next(
      await alice.signEvent(
        encodeRecord("test-app", "todos", "x", { title: "second", done: true }, 10, 11),
      ),
    );
    expect(received.map((change) => change.new?.title)).toEqual(["first", "second"]);
    expect(received[1]?.old?.title).toBe("first");
    expect((await client.from("todos").local().single()).data?.title).toBe("second");
  });

  test("sign-out during NIP-44 encryption prevents signing or queueing any ciphertext", async ({
    scope,
  }) => {
    const entered = deferred();
    const release = deferred<string>();
    const signer = {
      getPublicKey: alice.getPublicKey.bind(alice),
      signEvent: vi.fn(alice.signEvent.bind(alice)),
      nip44: {
        encrypt: async () => {
          entered.resolve();
          return release.promise;
        },
        decrypt: alice.nip44.decrypt.bind(alice.nip44),
      },
    };
    const { client, transport } = scope.client({ signer });
    scope.defer(() => release.resolve("unused ciphertext"));
    const pending = Promise.resolve(
      client.private.from("todos").insert({ title: "secret", done: false }).queue().select(),
    );
    await entered.promise;
    await client.auth.signOut();
    release.resolve("unused ciphertext");
    const result = await pending;
    expect(result.error?.code).toBe("AUTH_REQUIRED");
    expect(result.data).toEqual([]);
    expect(signer.signEvent).not.toHaveBeenCalled();
    expect(transport.published).toEqual([]);
    expect(await client.offline.list()).toEqual([]);
  });
});
