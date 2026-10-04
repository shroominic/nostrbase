import { PrivateKeySigner } from "applesauce-signers";
import { describe, expect, vi } from "vitest";
import type { ClientOptions, NostrbaseClient, Result, Row } from "../src";
import { createClient, scopeTag } from "../src";
import { MemoryGroupStateAdapter } from "../src/group-store";
import type { QueryState } from "../src/query";
import type { TestDB } from "./helpers";
import { alice, bob } from "./helpers";
import type { TestScope } from "./support/lifecycle";
import { deferred, required, test } from "./support/lifecycle";
import { relayOptions, WireRelay } from "./support/relay";

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
  options: Partial<ClientOptions<TestDB>> = {},
): NostrbaseClient<TestDB> {
  const sdk = createClient<TestDB>({
    namespace: "groups-api",
    relays: [node.url],
    signer: alice,
    timeout: 1500,
    relayOptions,
    schema: { todos: {}, projects: {} },
    ...options,
  });
  scope.defer(() => sdk.closeAsync());
  return sdk;
}

describe("Supabase query routing to stored Marmot groups", () => {
  test("isolates equal IDs across public, personal private, and two groups through CRUD, projection, and queued replay", async ({
    scope,
  }) => {
    const node = await relay(scope);
    const sdk = client(scope, node);
    const first = checked(await sdk.groups.create({ name: "First" }));
    const second = checked(await sdk.groups.create({ name: "Second" }));
    expect(checked(await sdk.groups.get(first.id))).toBe(first);
    const listed = await sdk.groups.list();
    expect(
      checked(listed)
        .map((group) => group.id)
        .sort(),
    ).toEqual([first.id, second.id].sort());
    expect(listed.count).toBe(2);

    expect(
      (await sdk.from("todos").insert({ id: "same", title: "public", done: false })).error,
    ).toBeNull();
    expect(
      (await sdk.private.from("todos").insert({ id: "same", title: "PERSONAL-ONLY", done: false }))
        .error,
    ).toBeNull();
    expect(
      (
        await sdk
          .from("todos")
          .inGroup(second.id)
          .insert({ id: "same", title: "SECOND-GROUP", done: false })
      ).error,
    ).toBeNull();
    const inserted: Result<Row<TestDB["todos"]> | null> = await sdk
      .from("todos")
      .inGroup(first.id)
      .insert({ id: "same", title: "FIRST-GROUP", done: false, priority: 1 })
      .select()
      .single();
    expect(required(checked(inserted)).title).toBe("FIRST-GROUP");
    const projected: Result<Pick<Row<TestDB["todos"]>, "id" | "title"> | null> = await sdk
      .from("todos")
      .eq("done", false)
      .inGroup(first.id)
      .eq("priority", 1)
      .select("id, title")
      .single();
    expect(checked(projected)).toEqual({ id: "same", title: "FIRST-GROUP" });
    expect(
      (await sdk.from("todos").inGroup(first.id).update({ done: true }).eq("id", "same")).error,
    ).toBeNull();
    const replaced = await sdk
      .from("todos")
      .inGroup(first.id)
      .upsert({ id: "same", title: "FIRST-REPLACED", done: true })
      .select("id, title, done")
      .single();
    expect(checked(replaced)).toEqual({ id: "same", title: "FIRST-REPLACED", done: true });

    const frames = node.frames.length;
    const queued = await sdk
      .from("todos")
      .inGroup(first.id)
      .insert({ id: "queued", title: "GROUP-QUEUE", done: false })
      .queue()
      .local()
      .select()
      .single();
    expect(checked(queued).title).toBe("GROUP-QUEUE");
    expect(queued.meta?.queued).toBe(true);
    expect(queued.meta?.receipts?.[0]?.queued).toBe(true);
    expect(node.frames.length).toBe(frames);
    expect(checked(await sdk.from("todos").inGroup(first.id).eq("id", "queued").local())).toEqual(
      [],
    );
    expect(checked(await first.flush())).toHaveLength(1);
    expect(
      checked(await sdk.from("todos").inGroup(first.id).eq("id", "queued").single()).title,
    ).toBe("GROUP-QUEUE");
    expect(await sdk.offline.list()).toEqual([]);

    const routedState: QueryState = {
      operation: "select",
      groupId: first.id,
      local: true,
      predicates: [{ field: "id", op: "eq", value: "same" }],
      order: [],
      allowAll: false,
      returning: true,
    };
    expect(
      checked(await sdk.execute<TestDB["todos"]>("todos", routedState)).map((row) => row.title),
    ).toEqual(["FIRST-REPLACED"]);
    const foreignState: QueryState = {
      ...routedState,
      groupId: second.id,
      operation: "insert",
      queue: true,
      values: [{ id: "host-escape", title: "FORBIDDEN-HOST-WRITE", done: false }],
    };
    expect((await first.execute("todos", foreignState)).error?.code).toBe("INVALID_QUERY");
    expect((await sdk.private.execute("todos", foreignState)).error?.code).toBe("INVALID_QUERY");
    expect((await sdk.executeInGroup(first.id, "todos", foreignState)).error?.code).toBe(
      "INVALID_QUERY",
    );
    expect(
      checked(await sdk.from("todos").inGroup(second.id).eq("id", "host-escape").local()),
    ).toEqual([]);

    expect((await sdk.from("todos").inGroup(first.id).delete().eq("id", "same")).error).toBeNull();
    expect(checked(await sdk.from("todos").inGroup(first.id).eq("id", "same"))).toEqual([]);
    expect(checked(await sdk.from("todos").eq("id", "same").single()).title).toBe("public");
    expect(checked(await sdk.private.from("todos").eq("id", "same").single()).title).toBe(
      "PERSONAL-ONLY",
    );
    expect(
      checked(await sdk.from("todos").inGroup(second.id).eq("id", "same").single()).title,
    ).toBe("SECOND-GROUP");
    const wire = JSON.stringify([...node.events.values()]);
    for (const secret of [
      "PERSONAL-ONLY",
      "FIRST-GROUP",
      "FIRST-REPLACED",
      "SECOND-GROUP",
      "GROUP-QUEUE",
    ])
      expect(wire).not.toContain(secret);
  }, 30000);

  test("cancels group resolution and rejects an account change while encrypted storage is pending", async ({
    scope,
  }) => {
    const node = await relay(scope);
    const adapter = new MemoryGroupStateAdapter();
    scope.defer(() => adapter.close());
    const options = { groups: { adapter, deviceId: "ac".repeat(32) } };
    const original = client(scope, node, options);
    const group = checked(await original.groups.create({ name: "Resolution race" }));
    await original.closeAsync();
    for (const mode of ["abort", "auth"] as const) {
      const reopened = client(scope, node, options);
      const entered = deferred();
      const release = deferred();
      scope.defer(() => release.resolve());
      const get = adapter.get.bind(adapter);
      let blocked = false;
      const read = vi.spyOn(adapter, "get").mockImplementation(async (key) => {
        if (!blocked) {
          blocked = true;
          entered.resolve();
          await release.promise;
        }
        return get(key);
      });
      scope.defer(() => read.mockRestore());
      const controller = new AbortController();
      const pending = reopened
        .from("todos")
        .inGroup(group.id)
        .insert({ id: mode, title: "RACE-MUST-NOT-WRITE", done: false })
        .abortSignal(controller.signal)
        .then((result) => result);
      await entered.promise;
      if (mode === "abort") controller.abort();
      else expect((await reopened.auth.signInWithSigner(bob)).error).toBeNull();
      release.resolve();
      const result = await pending;
      expect(result.data).toBeNull();
      expect(result.error?.code).toBe(mode === "abort" ? "ABORTED" : "AUTH_FAILED");
      read.mockRestore();
      await reopened.closeAsync();
    }
    expect(node.frames).toEqual([]);
    const restored = client(scope, node, options);
    expect(checked(await restored.from("todos").inGroup(group.id).local())).toEqual([]);
  });

  test("cancels a live group backfill and closes its silent relay subscription before the relay timeout", async ({
    scope,
  }) => {
    const node = await relay(scope);
    const sdk = client(scope, node, { timeout: 30000 });
    const group = checked(await sdk.groups.create({ name: "Cancelled backfill" }));
    node.readMode = "silence";
    const controller = new AbortController();
    const pending = sdk
      .from("todos")
      .inGroup(group.id)
      .abortSignal(controller.signal)
      .then((result) => result);
    await expect.poll(() => node.activeSubscriptions).toBe(1);
    const started = performance.now();
    controller.abort();
    const result = await pending;
    expect(result.data).toBeNull();
    expect(result.error?.code).toBe("ABORTED");
    await expect.poll(() => node.activeSubscriptions).toBe(0);
    expect(performance.now() - started).toBeLessThan(5000);
    const request = required(node.frames.find((frame) => frame[0] === "REQ"));
    expect(node.frames).toContainEqual(["CLOSE", request[1]]);
    expect(node.frames.some((frame) => frame[0] === "EVENT")).toBe(false);
    expect(checked(await sdk.from("todos").inGroup(group.id).local())).toEqual([]);
  });

  test("does not store an intent or publish when a queued mutation is cancelled while the signer is pending", async ({
    scope,
  }) => {
    const node = await relay(scope);
    const adapter = new MemoryGroupStateAdapter();
    scope.defer(() => adapter.close());
    const signer = new PrivateKeySigner(new Uint8Array(32).fill(8));
    const sdk = client(scope, node, { signer, groups: { adapter, deviceId: "ad".repeat(32) } });
    const group = checked(await sdk.groups.create({ name: "Cancelled signature" }));
    const entered = deferred();
    const release = deferred();
    scope.defer(() => release.resolve());
    const signEvent = signer.signEvent.bind(signer);
    const sign = vi.spyOn(signer, "signEvent").mockImplementation(async (template) => {
      entered.resolve();
      await release.promise;
      return signEvent(template);
    });
    scope.defer(() => sign.mockRestore());
    const controller = new AbortController();
    const pending = sdk
      .from("todos")
      .inGroup(group.id)
      .insert({ id: "cancelled", title: "CANCELLED-SIGNED-INTENT", done: false })
      .queue()
      .local()
      .select()
      .single()
      .abortSignal(controller.signal)
      .then((result) => result);
    await entered.promise;
    controller.abort();
    release.resolve();
    const result = await pending;
    expect(result.data).toBeNull();
    expect(result.error?.code).toBe("ABORTED");
    expect(result.meta?.receipts).toEqual([]);
    expect(sign).toHaveBeenCalledOnce();
    sign.mockRestore();
    expect((await adapter.keys()).some((key) => key.includes(":intents:"))).toBe(false);
    expect(node.frames).toEqual([]);
    expect(checked(await group.flush())).toEqual([]);
    expect(node.frames.some((frame) => frame[0] === "EVENT")).toBe(false);
    expect(checked(await sdk.from("todos").inGroup(group.id).local())).toEqual([]);
  });

  test("keeps group-only queries out of public initial sync and registers a public table when its query executes", async ({
    scope,
  }) => {
    const node = await relay(scope);
    const sdk = client(scope, node, { sync: { initial: true } });
    const group = checked(await sdk.groups.create({ name: "Private sync routing" }));
    expect(checked(await sdk.from("todos").inGroup(group.id).local())).toEqual([]);
    expect(node.frames).toEqual([]);
    const unregistered = await sdk.sync.pull(undefined, { strategy: "query" });
    expect(unregistered.data).toEqual([]);
    expect(unregistered.error?.code).toBe("INVALID_QUERY");
    expect(node.frames).toEqual([]);
    expect(checked(await sdk.from("projects").local())).toEqual([]);
    expect((await sdk.sync.pull(undefined, { strategy: "query" })).error).toBeNull();
    const filters = node.frames
      .filter((frame) => frame[0] === "REQ")
      .flatMap((frame) => frame.slice(2)) as { "#t"?: string[] }[];
    expect(
      filters.some((filter) => filter["#t"]?.includes(scopeTag("groups-api", "projects"))),
    ).toBe(true);
    expect(filters.some((filter) => filter["#t"]?.includes(scopeTag("groups-api", "todos")))).toBe(
      false,
    );
  });

  test("returns errors for invalid, missing, unsigned, cancelled, and closed requests without writing to another scope", async ({
    scope,
  }) => {
    const node = await relay(scope);
    const sdk = client(scope, node);
    const group = checked(await sdk.groups.create({ name: "Error contracts" }));
    const missing = "ff".repeat(32);
    for (const invalid of ["", "ABC", "a".repeat(63)]) {
      expect((await sdk.groups.get(invalid)).error?.code).toBe("INVALID_QUERY");
      expect((await sdk.groups.join(invalid)).error?.code).toBe("INVALID_QUERY");
      expect(
        (await sdk.from("todos").inGroup(invalid).insert({ id: "bad", title: "bad", done: false }))
          .error?.code,
      ).toBe("INVALID_QUERY");
    }
    expect((await sdk.groups.create({ name: " " })).error?.code).toBe("INVALID_QUERY");
    expect((await sdk.groups.get(missing)).error?.code).toBe("NOT_FOUND");
    const unknownInvite = await sdk.groups.join(missing);
    expect(unknownInvite.data).toBeNull();
    expect(unknownInvite.error?.code).toBe("NOT_FOUND");
    expect(unknownInvite.meta?.partial).toBe(false);
    expect(
      (await sdk.from("todos").inGroup(missing).insert({ title: "missing", done: false })).error
        ?.code,
    ).toBe("NOT_FOUND");
    await expect(sdk.from("todos").inGroup(missing).local().throwOnError()).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const abort = new AbortController();
    abort.abort();
    expect(
      (
        await sdk
          .from("todos")
          .inGroup(group.id)
          .insert({ id: "cancelled", title: "cancelled", done: false })
          .abortSignal(abort.signal)
      ).error?.code,
    ).toBe("ABORTED");
    expect(node.frames).toEqual([]);

    const unsigned = client(scope, node, { signer: undefined });
    const unsignedResults = await Promise.all([
      unsigned.groups.create({ name: "Unsigned" }),
      unsigned.groups.get(group.id),
      unsigned.groups.list(),
      unsigned.groups.invites(),
      unsigned.groups.join(missing),
      unsigned.from("todos").inGroup(group.id).local(),
    ]);
    for (const result of unsignedResults) {
      expect(result.data).toBeNull();
      expect(result.error?.code).toBe("AUTH_REQUIRED");
    }
    expect(checked(await sdk.from("todos").local())).toEqual([]);
    expect(checked(await sdk.private.from("todos").local())).toEqual([]);
    expect(checked(await sdk.from("todos").inGroup(group.id).local())).toEqual([]);
    const closedQuery = sdk.from("todos").inGroup(group.id).local();
    await sdk.closeAsync();
    const closedResults = await Promise.all([
      sdk.groups.create({ name: "Closed" }),
      sdk.groups.get(group.id),
      sdk.groups.list(),
      sdk.groups.invites(),
      sdk.groups.join(missing),
      closedQuery,
    ]);
    for (const result of closedResults) {
      expect(result.data).toBeNull();
      expect(result.error?.code).toBe("CLIENT_CLOSED");
    }
  });
});
