import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChangePayload, NostrbaseClient, NostrEvent } from "../src";
import { createClient, EventStore, NostrbaseError, recordIdentifier, scopeTag } from "../src";
import { encodeRecord } from "../src/protocol";
import type { TestDB } from "./helpers";
import { alice, bob, setup } from "./helpers";

const clients: NostrbaseClient<TestDB>[] = [];
function fixture(options: Parameters<typeof setup>[0] = {}) {
  const result = setup(options);
  clients.push(result.client);
  return result;
}
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  vi.restoreAllMocks();
});

describe("auth and configuration", () => {
  it("validates namespace, relay URLs and acknowledgement policy", () => {
    expect(() => createClient({ namespace: "", relays: [] })).toThrow(NostrbaseError);
    expect(() => createClient({ namespace: "x", relays: ["https://example.com"] })).toThrow(
      /Invalid relay/,
    );
    expect(() =>
      createClient({ namespace: "x", relays: ["wss://r.test"], minWriteAcks: 2 }),
    ).toThrow(/minWriteAcks/);
  });
  it("signs in with Applesauce, emits auth changes and signs out", async () => {
    const { client } = fixture({ signer: undefined });
    const events: string[] = [];
    const { data } = client.auth.onAuthStateChange((event) => events.push(event));
    await Promise.resolve();
    expect((await client.auth.signInWithPrivateKey(new Uint8Array(32).fill(1))).data?.user.id).toBe(
      await alice.getPublicKey(),
    );
    expect((await client.auth.getUser()).data?.pubkey).toBe(await alice.getPublicKey());
    await client.auth.signOut();
    expect((await client.auth.getSession()).data).toBeNull();
    expect(events).toContain("SIGNED_IN");
    expect(events).toContain("SIGNED_OUT");
    data.subscription.unsubscribe();
  });
  it("blocks unauthenticated writes and invalid signers", async () => {
    const { client } = fixture({ signer: undefined });
    expect((await client.from("todos").insert({ title: "x", done: false })).error?.code).toBe(
      "AUTH_REQUIRED",
    );
    expect(
      (
        await client.auth.signInWithSigner({
          getPublicKey: async () => "bad",
          signEvent: alice.signEvent.bind(alice),
        })
      ).error?.code,
    ).toBe("AUTH_FAILED");
  });
  it("does not restore a delayed sign-in after sign-out", async () => {
    let resolve: (pubkey: string) => void = () => {};
    const { client } = fixture({
      signer: {
        getPublicKey: () =>
          new Promise((done) => {
            resolve = done;
          }),
        signEvent: alice.signEvent.bind(alice),
      },
    });
    await client.auth.signOut();
    resolve(await alice.getPublicKey());
    await Promise.resolve();
    expect((await client.auth.getSession()).data).toBeNull();
  });
  it("rejects a signer that changes the event", async () => {
    const { client } = fixture({
      signer: {
        getPublicKey: alice.getPublicKey.bind(alice),
        signEvent: async (template) => alice.signEvent({ ...template, content: "changed" }),
      },
    });
    expect((await client.from("todos").insert({ title: "x", done: false })).error?.code).toBe(
      "AUTH_FAILED",
    );
  });
});

describe("typed tables and Nostr record semantics", () => {
  it("inserts, selects, updates, upserts and deletes one record", async () => {
    const { client, transport } = fixture();
    const inserted = await client
      .from("todos")
      .insert({ id: "one", title: "Build it", done: false })
      .select()
      .single();
    expect(inserted.error).toBeNull();
    expect(inserted.data?.id).toBe("one");
    const first = inserted.data?._nostr;
    expect(transport.published[0]?.kind).toBe(30078);
    expect(transport.published[0]?.tags).toContainEqual([
      "d",
      recordIdentifier("test-app", "todos", "one"),
    ]);
    const changed = await client
      .from("todos")
      .update({ done: true })
      .eq("id", "one")
      .select()
      .single();
    expect(changed.data?.title).toBe("Build it");
    expect(changed.data?.done).toBe(true);
    expect(changed.data?._nostr.createdAt).toBe(first?.createdAt);
    expect(changed.data?._nostr.updatedAt).toBeGreaterThan(first?.updatedAt ?? 0);
    expect((await client.from("todos").eq("done", false)).data).toEqual([]);
    expect((await client.from("todos").eq("id", "one")).data).toHaveLength(1);
    const upsert = await client
      .from("todos")
      .upsert({ id: "one", title: "Replaced", done: false })
      .select()
      .single();
    expect(upsert.data?.title).toBe("Replaced");
    const deleted = await client.from("todos").delete().eq("id", "one").select();
    expect(deleted.count).toBe(1);
    expect(transport.published.at(-1)?.kind).toBe(5);
    expect((await client.from("todos").select()).data).toEqual([]);
  });
  it("filters latest versions before applying fields, sort, range and projection", async () => {
    const { client } = fixture();
    await client.from("todos").insert([
      { id: "1", title: "a", done: false, priority: 1, labels: ["work"] },
      { id: "2", title: "b", done: true, priority: 2, labels: ["work", "fun"] },
      { id: "3", title: "c", done: false, priority: 3 },
    ]);
    const result = await client
      .from("todos")
      .select("id, title")
      .gte("priority", 1)
      .in("id", ["1", "2"])
      .contains("labels", ["work"])
      .order("priority", { ascending: false })
      .range(0, 0);
    expect(result.data).toEqual([{ id: "2", title: "b" }]);
    expect((await client.from("todos").match({ done: false }).limit(1)).data).toHaveLength(1);
    expect(
      (await client.from("todos").neq("done", true).lt("priority", 3)).data?.map((row) => row.id),
    ).toEqual(["1"]);
  });
  it("uses author plus id for identity and rejects writes to other authors", async () => {
    const { client, transport } = fixture();
    await client.from("todos").insert({ id: "shared", title: "Alice", done: false });
    const { client: other } = fixture({ signer: bob, transport });
    await other.from("todos").insert({ id: "shared", title: "Bob", done: false });
    expect((await client.from("todos").eq("id", "shared").single()).error?.code).toBe(
      "MULTIPLE_ROWS",
    );
    expect(
      (
        await client
          .from("todos")
          .author(await alice.getPublicKey())
          .eq("id", "shared")
          .single()
      ).data?.title,
    ).toBe("Alice");
    expect(
      (
        await client
          .from("todos")
          .update({ done: true })
          .author(await bob.getPublicKey())
          .eq("id", "shared")
      ).error?.code,
    ).toBe("PERMISSION_DENIED");
    await client.from("todos").update({ done: true }).eq("id", "shared");
    expect(
      (
        await other
          .from("todos")
          .author(await bob.getPublicKey())
          .eq("id", "shared")
          .single()
      ).data?.done,
    ).toBe(false);
  });
  it("rejects duplicate insert ids, invalid JSON, reserved fields and schema violations before publishing", async () => {
    const { client, transport } = fixture();
    expect(
      (
        await client.from("todos").insert([
          { id: "same", title: "a", done: false },
          { id: "same", title: "b", done: false },
        ])
      ).error?.code,
    ).toBe("CONFLICT");
    expect(transport.published).toHaveLength(0);
    expect(
      (await client.from("todos").insert({ title: "bad", done: "no" } as never)).error?.code,
    ).toBe("INVALID_RECORD");
    expect(
      (await client.from("todos").insert({ title: "x", done: false, priority: Number.NaN })).error
        ?.code,
    ).toBe("INVALID_RECORD");
    expect(
      (await client.from("todos").insert({ title: "x", done: false, _nostr: {} } as never)).error
        ?.code,
    ).toBe("INVALID_RECORD");
    await client.from("todos").insert({ id: "existing", title: "x", done: false });
    expect(
      (await client.from("todos").insert({ id: "existing", title: "y", done: false })).error?.code,
    ).toBe("CONFLICT");
  });
  it("requires an explicit filter or all() for broad mutations", async () => {
    const { client } = fixture();
    expect((await client.from("todos").update({ done: true })).error?.code).toBe("INVALID_QUERY");
    expect((await client.from("todos").delete()).error?.code).toBe("INVALID_QUERY");
    await client.from("todos").insert({ title: "x", done: false });
    expect((await client.from("todos").update({ done: true }).all()).count).toBe(1);
  });
  it("supports empty, single, maybeSingle, error throwing and immutable query branches", async () => {
    const { client } = fixture();
    expect((await client.from("todos").single()).error?.code).toBe("NOT_FOUND");
    expect(await client.from("todos").maybeSingle()).toMatchObject({ data: null, error: null });
    await expect(
      Promise.resolve(client.from("todos").single().throwOnError()),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await client.from("todos").insert([
      { title: "a", done: true },
      { title: "b", done: false },
    ]);
    const base = client.from("todos");
    expect((await base.eq("done", true)).data).toHaveLength(1);
    expect((await base).data).toHaveLength(2);
    expect((await client.from("todos").limit(-1)).error?.code).toBe("INVALID_QUERY");
    expect((await client.from("todos").range(3, 1)).error?.code).toBe("INVALID_QUERY");
  });
  it("executes an awaited mutation once and serializes concurrent updates", async () => {
    const { client, transport } = fixture();
    const query = client.from("todos").insert({ id: "one", title: "a", done: false });
    await query;
    await query;
    expect(transport.published).toHaveLength(1);
    await Promise.all([
      Promise.resolve(client.from("todos").update({ title: "b" }).eq("id", "one")),
      Promise.resolve(client.from("todos").update({ done: true }).eq("id", "one")),
    ]);
    expect((await client.from("todos").single()).data).toMatchObject({ title: "b", done: true });
  });
  it("ignores invalid signatures, foreign namespaces and malformed records", async () => {
    const { client, transport } = fixture();
    const now = Math.floor(Date.now() / 1000);
    const valid = await alice.signEvent(
      encodeRecord("test-app", "todos", "one", { title: "valid", done: false }, now, now),
    );
    transport.events.push(
      { ...valid, content: "tampered" },
      await alice.signEvent(
        encodeRecord("other-app", "todos", "two", { title: "other", done: false }, now, now),
      ),
      await alice.signEvent({
        kind: 30078,
        created_at: now,
        tags: [
          ["t", scopeTag("test-app", "todos")],
          ["d", "wrong"],
        ],
        content: "{}",
      }),
    );
    expect((await client.from("todos")).data).toEqual([]);
    transport.events.push(valid);
    expect((await client.from("todos")).data?.map((row) => row.title)).toEqual(["valid"]);
  });
  it("honors external NIP-09 deletes and rejects unauthorized deletes", async () => {
    const { client, transport } = fixture();
    const result = await client
      .from("todos")
      .insert({ id: "one", title: "x", done: false })
      .select()
      .single();
    const row = result.data;
    const pointer = `30078:${await alice.getPublicKey()}:${recordIdentifier("test-app", "todos", "one")}`;
    transport.events.push(
      await bob.signEvent({
        kind: 5,
        created_at: (row?._nostr.updatedAt ?? 0) + 1,
        tags: [["a", pointer]],
        content: "",
      }),
    );
    expect((await client.from("todos")).data).toHaveLength(1);
    transport.events.push(
      await alice.signEvent({
        kind: 5,
        created_at: (row?._nostr.updatedAt ?? 0) + 1,
        tags: [["a", pointer]],
        content: "",
      }),
    );
    expect((await client.from("todos")).data).toEqual([]);
  });
  it("resolves replacement timestamp ties using the lowest event id", async () => {
    const { client, transport } = fixture();
    const now = Math.floor(Date.now() / 1000);
    const events = await Promise.all(
      ["a", "b"].map((title) =>
        alice.signEvent(encodeRecord("test-app", "todos", "tie", { title, done: false }, now, now)),
      ),
    );
    transport.events.push(...events.sort((a, b) => b.id.localeCompare(a.id)));
    expect((await client.from("todos").single()).data?._nostr.eventId).toBe(
      [...events].sort((a, b) => a.id.localeCompare(b.id))[0]?.id,
    );
  });
});

describe("relay failure and lifecycle", () => {
  it("returns relay read errors instead of a false empty table", async () => {
    const { client, transport } = fixture();
    transport.readFailure = true;
    expect((await client.from("todos")).error?.code).toBe("RELAY_ERROR");
  });
  it("reports partial reads and writes with acknowledgements", async () => {
    const { client, transport } = fixture({ relays: ["wss://one.test", "wss://two.test"] });
    const statuses = [
      { url: "wss://one.test/", ok: true },
      { url: "wss://two.test/", ok: false, message: "offline" },
    ];
    transport.publishStatuses = statuses;
    transport.readStatuses = statuses;
    const result = await client.from("todos").insert({ title: "x", done: false }).select();
    expect(result.error).toBeNull();
    expect(result.meta?.partial).toBe(true);
    expect(result.meta?.receipts?.[0]?.relays).toEqual(statuses);
    expect((await client.from("todos")).meta?.partial).toBe(true);
  });
  it("keeps committed data and receipts when the acknowledgement threshold fails", async () => {
    const { client, transport } = fixture({
      relays: ["wss://one.test", "wss://two.test"],
      minWriteAcks: 2,
    });
    transport.publishStatuses = [
      { url: "wss://one.test/", ok: true },
      { url: "wss://two.test/", ok: false },
    ];
    const result = await client.from("todos").insert({ title: "x", done: false }).select();
    expect(result.error?.code).toBe("PUBLISH_FAILED");
    expect(result.data).toHaveLength(1);
    expect(result.meta?.partial).toBe(true);
  });
  it("returns precise partial batch results and does not cache rejected writes", async () => {
    const { client, transport } = fixture();
    transport.failPublishAt = 2;
    const result = await client
      .from("todos")
      .insert([
        { id: "1", title: "a", done: false },
        { id: "2", title: "b", done: false },
        { id: "3", title: "c", done: false },
      ])
      .select();
    expect(result.error?.code).toBe("PUBLISH_FAILED");
    expect(result.data?.map((row) => row.id)).toEqual(["1"]);
    expect(result.meta?.receipts).toHaveLength(2);
    expect(transport.published).toHaveLength(2);
    expect((await client.from("todos")).data?.map((row) => row.id)).toEqual(["1"]);
  });
  it("supports cancellation and closes owned resources", async () => {
    const { client } = fixture();
    const controller = new AbortController();
    controller.abort();
    expect((await client.from("todos").abortSignal(controller.signal)).error?.code).toBe("ABORTED");
    const query = client.from("todos");
    client.close();
    expect((await query).error?.code).toBe("CLIENT_CLOSED");
    expect(() => client.from("todos")).toThrow(/closed/);
  });
  it("preserves an injected event store on close", () => {
    const eventStore = new EventStore();
    const dispose = vi.spyOn(eventStore, "dispose");
    const { client } = fixture({ eventStore });
    client.close();
    expect(dispose).not.toHaveBeenCalled();
    eventStore.dispose();
  });
});

describe("channels and native Nostr events", () => {
  it("delivers INSERT, UPDATE and DELETE without duplicate messages", async () => {
    const { client, transport } = fixture();
    const changes: ChangePayload<TestDB["todos"]>[] = [];
    const channel = client
      .channel("todos")
      .on("nostr_changes", { table: "todos", event: "*" }, (payload) => changes.push(payload))
      .subscribe();
    await client.from("todos").insert({ id: "one", title: "x", done: false });
    transport.live.next(transport.published[0] as NostrEvent);
    await client.from("todos").update({ done: true }).eq("id", "one");
    await client.from("todos").delete().eq("id", "one");
    expect(changes.map((change) => change.eventType)).toEqual(["INSERT", "UPDATE", "DELETE"]);
    expect(changes[1]?.old?.done).toBe(false);
    expect(changes[1]?.new?.done).toBe(true);
    expect(changes[2]?.old?.id).toBe("one");
    expect(changes[2]?.new).toBeNull();
    await client.removeChannel(channel);
    expect(transport.activeSubscriptions).toBe(0);
  });
  it("supports the postgres_changes alias and filtered transitions", async () => {
    const { client } = fixture();
    const events: string[] = [];
    client
      .channel("pending")
      .on("postgres_changes", { table: "todos", filter: "done=eq.false" }, (payload) =>
        events.push(payload.eventType),
      )
      .subscribe();
    await client.from("todos").insert({ id: "one", title: "x", done: false });
    await client.from("todos").update({ done: true }).eq("id", "one");
    expect(events).toEqual(["INSERT", "UPDATE"]);
  });
  it("publishes and queries standard Nostr kinds and verifies subscriptions", async () => {
    const { client, transport } = fixture();
    const received: NostrEvent[] = [];
    const subscription = client.events.subscribe({ kinds: [1] }, (event) => received.push(event));
    const result = await client.events.publish({
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: "hello nostr",
    });
    expect(result.error).toBeNull();
    expect(received).toHaveLength(1);
    transport.live.next({ ...(result.data as NostrEvent), content: "tampered" });
    expect(received).toHaveLength(1);
    expect((await client.events.query({ kinds: [1] })).data?.[0]?.content).toBe("hello nostr");
    expect(
      (await client.events.publishSigned({ ...(result.data as NostrEvent), content: "tampered" }))
        .error?.code,
    ).toBe("INVALID_RECORD");
    subscription.unsubscribe();
    expect(transport.activeSubscriptions).toBe(0);
  });
  it("closes all channel and raw-event subscriptions with the client", () => {
    const { client, transport } = fixture();
    client
      .channel("x")
      .on("nostr_changes", { table: "todos" }, () => {})
      .subscribe();
    client.events.subscribe({ kinds: [1] }, () => {});
    expect(transport.activeSubscriptions).toBe(2);
    client.close();
    expect(transport.activeSubscriptions).toBe(0);
  });
});

describe("record and subscription regression cases", () => {
  it("creates a deleted id again, including from a fresh client", async () => {
    const { client, transport } = fixture();
    await client.from("todos").insert({ id: "reused", title: "old", done: false });
    await client.from("todos").delete().eq("id", "reused");
    const deletionTime = transport.published.at(-1)?.created_at ?? 0;
    const { client: fresh } = fixture({ transport });
    const recreated = await fresh
      .from("todos")
      .insert({ id: "reused", title: "new", done: false })
      .select()
      .single();
    expect(recreated.error).toBeNull();
    expect(recreated.data?._nostr.updatedAt).toBeGreaterThan(deletionTime);
    expect((await client.from("todos").single()).data?.title).toBe("new");
  });
  it("honors e-only deletion requests when stale events arrive again", async () => {
    const { client, transport } = fixture();
    const inserted = await client
      .from("todos")
      .insert({ id: "one", title: "x", done: false })
      .select()
      .single();
    const row = inserted.data;
    transport.events.push(
      await alice.signEvent({
        kind: 5,
        created_at: (row?._nostr.updatedAt ?? 0) + 1,
        tags: [["e", row?._nostr.eventId ?? ""]],
        content: "",
      }),
    );
    expect((await client.from("todos")).data).toEqual([]);
    expect((await client.from("todos")).data).toEqual([]);
  });
  it("keeps the newest deletion timestamp when deletes arrive out of order", async () => {
    const { client, transport } = fixture();
    const now = Math.floor(Date.now() / 1000);
    const record = await alice.signEvent(
      encodeRecord("test-app", "todos", "one", { title: "stale", done: false }, now, now + 2),
    );
    const tags = [
      ["a", `30078:${await alice.getPublicKey()}:${recordIdentifier("test-app", "todos", "one")}`],
    ];
    transport.events.push(
      record,
      await alice.signEvent({ kind: 5, created_at: now + 3, tags, content: "" }),
      await alice.signEvent({ kind: 5, created_at: now + 1, tags, content: "" }),
    );
    expect((await client.from("todos")).data).toEqual([]);
    expect((await client.from("todos")).data).toEqual([]);
  });
  it("preserves receipts if single() is applied to a committed batch", async () => {
    const { client } = fixture();
    const result = await client
      .from("todos")
      .insert([
        { title: "a", done: false },
        { title: "b", done: false },
      ])
      .select()
      .single();
    expect(result.error?.code).toBe("MULTIPLE_ROWS");
    expect(result.meta?.receipts).toHaveLength(2);
    expect(result.count).toBe(2);
  });
  it("rejects a signer that mutates its input before signing", async () => {
    const { client, transport } = fixture({
      signer: {
        getPublicKey: alice.getPublicKey.bind(alice),
        signEvent: async (template) => {
          template.content = "changed";
          return alice.signEvent(template);
        },
      },
    });
    expect((await client.from("todos").insert({ title: "x", done: false })).error?.code).toBe(
      "AUTH_FAILED",
    );
    expect(transport.published).toHaveLength(0);
  });
  it("can unsubscribe from inside the subscription status callback", () => {
    const { client, transport } = fixture();
    const channel = client.channel("close").on("nostr_changes", { table: "todos" }, () => {});
    expect(() =>
      channel.subscribe((status) => {
        if (status === "SUBSCRIBED") channel.unsubscribe();
      }),
    ).not.toThrow();
    expect(transport.activeSubscriptions).toBe(0);
  });
  it("supports a browser NIP-07 signer through Applesauce", async () => {
    vi.stubGlobal("window", { nostr: alice });
    try {
      const { client } = fixture({ signer: undefined });
      expect((await client.auth.signInWithExtension()).error).toBeNull();
      expect(
        (await client.from("todos").insert({ title: "extension", done: false })).error,
      ).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
