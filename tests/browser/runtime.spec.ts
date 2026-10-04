import type { Page } from "@playwright/test";
import { verifyEvent } from "nostr-tools";
import { expect, test } from "./support/fixtures";
import type {} from "./support/entry";

async function openHarness(page: Page, url: string) {
  await page.goto(url);
  await page.waitForFunction(() => window.harnessReady === true);
}
async function createClient(
  page: Page,
  relay: string,
  options: { name?: string; database?: string; namespace?: string; seed?: number } = {},
) {
  await page.evaluate(async (settings) => window.createHarnessClient(settings), {
    name: "main",
    database: "browser-runtime",
    namespace: "browser-app",
    relay,
    ...options,
  });
}

// Risk: the group query API must retain encryption, membership and device state in real browsers.
test("group queries share encrypted records and recover queued intents after a real IndexedDB reload", async ({
  page,
  harness,
}) => {
  await openHarness(page, harness.url);
  const created = await page.evaluate(async (relay) => {
    const { createClient, IndexedDBGroupStateAdapter, PrivateKeySigner } = window.nostrbase;
    const adapter = new IndexedDBGroupStateAdapter("browser-private-groups");
    const owner = createClient({
      namespace: "browser-groups",
      relays: [relay],
      signer: new PrivateKeySigner(new Uint8Array(32).fill(1)),
      groups: { adapter, deviceId: "12".repeat(32) },
      timeout: 10000,
      relayOptions: { keepAlive: 0 },
    });
    const signer = new PrivateKeySigner(new Uint8Array(32).fill(2));
    const member = createClient({
      namespace: "browser-groups",
      relays: [relay],
      signer,
      timeout: 10000,
      relayOptions: { keepAlive: 0 },
    });
    try {
      const prepared = await member.groups.publishKeyPackage();
      if (prepared.error) throw prepared.error;
      const result = await owner.groups.create({ name: "PRIVATE-BROWSER-TEAM" });
      if (result.error || !result.data) throw result.error ?? new Error("Group missing");
      const group = result.data;
      const insert = await owner
        .from("todos")
        .inGroup(group.id)
        .insert({ id: "shared", title: "PRIVATE-BROWSER-SHARED", done: false });
      if (insert.error) throw insert.error;
      const invite = await group.invite(await signer.getPublicKey());
      if (invite.error) throw invite.error;
      const invites = await member.groups.invites();
      if (invites.error || !invites.data?.[0])
        throw invites.error ?? new Error("Invitation missing");
      const joined = await member.groups.join(invites.data[0].id);
      if (joined.error || !joined.data) throw joined.error ?? new Error("Join missing");
      const row = await member.from("todos").inGroup(group.id).select("id, title").single();
      if (row.error) throw row.error;
      const ownerKey = (await owner.auth.getSession()).data?.user.pubkey;
      if (!ownerKey) throw new Error("Owner missing");
      const denied = await member
        .from("todos")
        .inGroup(group.id)
        .update({ done: true })
        .eq("id", "shared")
        .author(ownerKey);
      const queued = await owner
        .from("todos")
        .inGroup(group.id)
        .insert({ id: "queued", title: "PRIVATE-BROWSER-QUEUED", done: false })
        .local()
        .queue();
      if (queued.error) throw queued.error;
      const before = await owner.from("todos").inGroup(group.id).local();
      if (before.error) throw before.error;
      const keys = await adapter.keys();
      const disk = await Promise.all(keys.map((key) => adapter.get(key)));
      return {
        groupId: group.id,
        row: row.data,
        denied: denied.error?.code,
        before: before.data?.map((value) => value.id),
        queued: queued.meta?.receipts?.[0]?.queued,
        disk,
      };
    } finally {
      await Promise.all([owner.closeAsync(), member.closeAsync()]);
      await adapter.close();
    }
  }, harness.relay.url);
  expect(created.row).toEqual({ id: "shared", title: "PRIVATE-BROWSER-SHARED" });
  expect(created.denied).toBe("PERMISSION_DENIED");
  expect(created.before).toEqual(["shared"]);
  expect(created.queued).toBe(true);
  expect(created.disk.length).toBeGreaterThan(0);
  expect(JSON.stringify(created.disk)).not.toContain("PRIVATE-BROWSER-");
  expect(JSON.stringify([...harness.relay.events.values()])).not.toContain("PRIVATE-BROWSER-");

  await page.reload();
  await page.waitForFunction(() => window.harnessReady);
  const recovered = await page.evaluate(
    async ({ relay, groupId }) => {
      const { createClient, IndexedDBGroupStateAdapter, PrivateKeySigner } = window.nostrbase;
      const adapter = new IndexedDBGroupStateAdapter("browser-private-groups");
      const client = createClient({
        namespace: "browser-groups",
        relays: [relay],
        signer: new PrivateKeySigner(new Uint8Array(32).fill(1)),
        groups: { adapter, deviceId: "12".repeat(32) },
        timeout: 10000,
        relayOptions: { keepAlive: 0 },
      });
      try {
        const restored = await client.groups.get(groupId);
        if (restored.error || !restored.data) throw restored.error ?? new Error("Group missing");
        const before = await client.from("todos").inGroup(groupId).local();
        if (before.error) throw before.error;
        const flushed = await restored.data.flush();
        if (flushed.error) throw flushed.error;
        const after = await client.from("todos").inGroup(groupId).local().select("id, title");
        if (after.error) throw after.error;
        const publicRows = await client.from("todos").local();
        if (publicRows.error) throw publicRows.error;
        return {
          before: before.data?.map((value) => value.id),
          after: after.data?.sort((a, b) => a.id.localeCompare(b.id)),
          flushed: flushed.count,
          publicRows: publicRows.data,
        };
      } finally {
        await client.closeAsync();
        await adapter.close();
      }
    },
    { relay: harness.relay.url, groupId: created.groupId },
  );
  expect(recovered.before).toEqual(["shared"]);
  expect(recovered.flushed).toBe(1);
  expect(recovered.after).toEqual([
    { id: "queued", title: "PRIVATE-BROWSER-QUEUED" },
    { id: "shared", title: "PRIVATE-BROWSER-SHARED" },
  ]);
  expect(recovered.publicRows).toEqual([]);
  expect(JSON.stringify([...harness.relay.events.values()])).not.toContain("PRIVATE-BROWSER-");
  await expect.poll(() => harness.relay.activeSubscriptions).toBe(0);
});

// Risk: persisted queues must preserve signatures, ciphertext and ownership across a real reload.
test("reload restores public/private signed queues and replays the exact committed events", async ({
  page,
  harness,
}) => {
  await openHarness(page, harness.url);
  await createClient(page, harness.relay.url);
  const committed = await page.evaluate(async () => {
    const client = window.clients.get("main");
    if (!client) throw new Error("Missing client");
    const publicWrite = await client
      .from("todos")
      .insert({ id: "public", title: "public task" })
      .queue()
      .select();
    const privateWrite = await client.private
      .from("todos")
      .insert({ id: "private", title: "secret task" })
      .queue()
      .select();
    if (publicWrite.error || privateWrite.error) throw publicWrite.error ?? privateWrite.error;
    await client.persistence?.flush();
    const queue = await client.offline.list();
    const disk = await window.adapters.get("main")?.loadEvents("browser-app");
    await client.closeAsync();
    return { queue, disk };
  });
  expect(committed.queue).toHaveLength(2);
  expect(committed.queue.every((entry) => verifyEvent(structuredClone(entry.event)))).toBe(true);
  const ciphertext = committed.disk?.find((event) =>
    event.tags.some((tag) => tag[0] === "encryption"),
  );
  expect(ciphertext).toBeDefined();
  expect(ciphertext?.content).not.toContain("secret task");
  expect(harness.relay.events.size).toBe(0);
  await page.reload();
  await page.waitForFunction(() => window.harnessReady);
  await createClient(page, harness.relay.url);
  const restored = await page.evaluate(async () => {
    const client = window.clients.get("main");
    if (!client) throw new Error("Missing client");
    const queue = await client.offline.list();
    const publicRows = await client.from("todos").local();
    const privateRows = await client.private.from("todos").local();
    const flushed = await client.offline.flush();
    const remaining = await client.offline.list();
    await client.closeAsync();
    return { queue, publicRows, privateRows, flushed, remaining };
  });
  expect(restored.queue).toEqual(committed.queue);
  expect(restored.publicRows.data?.map((row) => row.title)).toEqual(["public task"]);
  expect(restored.privateRows.data?.map((row) => row.title)).toEqual(["secret task"]);
  expect(restored.flushed.error).toBeNull();
  expect(restored.flushed.count).toBe(2);
  expect(restored.remaining).toEqual([]);
  expect(
    harness.relay.frames.filter((frame) => frame[0] === "EVENT").map((frame) => frame[1]),
  ).toEqual(committed.queue.map((entry) => entry.event));
});

// Risk: deletion markers must survive closing a page and prevent old records from returning.
test("page reopen retains the newest version and tombstones without resurrecting deleted rows", async ({
  page,
  context,
  harness,
}) => {
  await openHarness(page, harness.url);
  await createClient(page, harness.relay.url);
  await page.evaluate(async () => {
    const client = window.clients.get("main");
    if (!client) throw new Error("Missing client");
    const writes = [
      await client
        .from("todos")
        .insert([
          { id: "live", title: "old" },
          { id: "gone", title: "deleted" },
        ])
        .queue()
        .select(),
      await client.from("todos").update({ title: "new" }).eq("id", "live").queue().select(),
      await client.from("todos").delete().eq("id", "gone").queue().select(),
    ];
    for (const write of writes) if (write.error) throw write.error;
    await client.closeAsync();
  });
  await page.close();
  const reopened = await context.newPage();
  await openHarness(reopened, harness.url);
  await createClient(reopened, harness.relay.url);
  const restored = await reopened.evaluate(async () => {
    const client = window.clients.get("main");
    if (!client) throw new Error("Missing client");
    const firstRead = await client.from("todos").local();
    const events = await window.adapters.get("main")?.loadEvents("browser-app");
    await client.closeAsync();
    return { firstRead, events };
  });
  expect(restored.firstRead.error).toBeNull();
  expect(restored.firstRead.data?.map((row) => [row.id, row.title])).toEqual([["live", "new"]]);
  expect(restored.events?.some((event) => event.kind === 5)).toBe(true);
  expect(harness.relay.frames).toEqual([]);
});

// Risk: browser profile reuse must not turn a signer change into private data or queue ownership.
test("another account cannot decrypt or deliver the previous account's durable private queue", async ({
  page,
  harness,
}) => {
  await openHarness(page, harness.url);
  await createClient(page, harness.relay.url);
  const queuedId = await page.evaluate(async () => {
    const client = window.clients.get("main");
    if (!client) throw new Error("Missing client");
    const result = await client.private
      .from("todos")
      .insert({ id: "private", title: "previous account secret" })
      .queue()
      .select();
    if (result.error) throw result.error;
    await client.closeAsync();
    return result.meta?.receipts?.[0]?.eventId;
  });
  await page.reload();
  await page.waitForFunction(() => window.harnessReady);
  await createClient(page, harness.relay.url, { seed: 2 });
  const otherAccount = await page.evaluate(async () => {
    const client = window.clients.get("main");
    if (!client) throw new Error("Missing client");
    const rows = await client.private.from("todos").local();
    const flushed = await client.offline.flush();
    const queue = await client.offline.list();
    await client.closeAsync();
    return { rows, flushed, queue };
  });
  expect(otherAccount.rows.data).toEqual([]);
  expect(otherAccount.flushed.error).toBeNull();
  expect(otherAccount.flushed.count).toBe(0);
  expect(otherAccount.queue.map((entry) => entry.event.id)).toEqual([queuedId]);
  expect(otherAccount.queue[0]?.attempts).toBe(0);
  expect(harness.relay.frames).toEqual([]);
  await page.reload();
  await page.waitForFunction(() => window.harnessReady);
  await createClient(page, harness.relay.url);
  const originalAccount = await page.evaluate(async () => {
    const client = window.clients.get("main");
    if (!client) throw new Error("Missing client");
    const rows = await client.private.from("todos").local();
    const flushed = await client.offline.flush();
    await client.closeAsync();
    return { rows, flushed };
  });
  expect(originalAccount.rows.data?.map((row) => row.title)).toEqual(["previous account secret"]);
  expect(originalAccount.flushed.error).toBeNull();
  expect(originalAccount.flushed.data?.map((receipt) => receipt.eventId)).toEqual([queuedId]);
});

// Risk: browser transactions from separate tabs must not overwrite independent queue entries.
test("two tabs commit to one database and a third tab hydrates both writes", async ({
  page,
  context,
  harness,
}) => {
  const second = await context.newPage();
  await Promise.all([openHarness(page, harness.url), openHarness(second, harness.url)]);
  await Promise.all([
    createClient(page, harness.relay.url),
    createClient(second, harness.relay.url),
  ]);
  const enqueue = (tab: Page, id: string) =>
    tab.evaluate(async (id) => {
      const client = window.clients.get("main");
      if (!client) throw new Error("Missing client");
      const write = await client.from("todos").insert({ id, title: id }).queue().select();
      if (write.error) throw write.error;
      await client.persistence?.flush();
      return write.meta?.receipts?.[0]?.eventId;
    }, id);
  const ids = await Promise.all([enqueue(page, "one"), enqueue(second, "two")]);
  expect(new Set(ids).size).toBe(2);
  const reader = await context.newPage();
  await openHarness(reader, harness.url);
  await createClient(reader, harness.relay.url);
  const restored = await reader.evaluate(async () => {
    const client = window.clients.get("main");
    if (!client) throw new Error("Missing client");
    return { rows: await client.from("todos").local(), queue: await client.offline.list() };
  });
  expect(restored.rows.data?.map((row) => row.id).sort()).toEqual(["one", "two"]);
  expect(restored.queue.map((entry) => entry.event.id).sort()).toEqual(ids.sort());
  await Promise.all(
    [page, second, reader].map((tab) =>
      tab.evaluate(async () => {
        await window.clients.get("main")?.closeAsync();
      }),
    ),
  );
});

// Risk: shared browser origin must not mix applications or explicit profile databases.
test("namespaces share a database safely and profile databases keep private records separate", async ({
  page,
  harness,
}) => {
  await openHarness(page, harness.url);
  await createClient(page, harness.relay.url, { name: "app-a", namespace: "app-a" });
  await createClient(page, harness.relay.url, { name: "app-b", namespace: "app-b" });
  await createClient(page, harness.relay.url, {
    name: "profile-b",
    namespace: "app-a",
    database: "profile-b",
    seed: 2,
  });
  const result = await page.evaluate(async () => {
    const first = window.clients.get("app-a");
    const second = window.clients.get("app-b");
    const profile = window.clients.get("profile-b");
    if (!first || !second || !profile) throw new Error("Missing clients");
    const a = await first.private
      .from("todos")
      .insert({ id: "same", title: "a private" })
      .queue()
      .select();
    const b = await second.from("todos").insert({ id: "same", title: "b public" }).queue().select();
    if (a.error || b.error) throw a.error ?? b.error;
    await Promise.all([first.persistence?.flush(), second.persistence?.flush()]);
    const queues = await Promise.all([
      first.offline.list(),
      second.offline.list(),
      profile.offline.list(),
    ]);
    const profileRows = await profile.private.from("todos").local();
    const aDisk = await window.adapters.get("app-a")?.loadEvents("app-a");
    const bDisk = await window.adapters.get("app-b")?.loadEvents("app-b");
    for (const client of window.clients.values()) await client.closeAsync();
    return { queues, profileRows, aDisk, bDisk };
  });
  expect(result.queues.map((queue) => queue.length)).toEqual([1, 1, 0]);
  expect(result.profileRows.data).toEqual([]);
  expect(result.aDisk?.map((event) => event.id)).toEqual(
    result.queues[0]?.map((entry) => entry.event.id),
  );
  expect(result.bDisk?.map((event) => event.id)).toEqual(
    result.queues[1]?.map((entry) => entry.event.id),
  );
});

// Risk: SDK-held connections must release a browser version upgrade rather than block other tabs.
test("external version changes close SDK connections and incompatible versions fail explicitly", async ({
  page,
  context,
  harness,
}) => {
  await openHarness(page, harness.url);
  await createClient(page, harness.relay.url);
  const upgradePage = await context.newPage();
  await openHarness(upgradePage, harness.url);
  const upgraded = await upgradePage.evaluate(
    async () =>
      new Promise<number>((resolve, reject) => {
        const request = indexedDB.open("browser-runtime", 2);
        request.onblocked = () => reject(new Error("SDK failed to close its version 1 connection"));
        request.onerror = () => reject(request.error);
        request.onupgradeneeded = () => request.result.createObjectStore("future-version");
        request.onsuccess = () => {
          const version = request.result.version;
          request.result.close();
          resolve(version);
        };
      }),
  );
  expect(upgraded).toBe(2);
  const failures = await page.evaluate(async () => {
    const adapter = window.adapters.get("main");
    const existing = await adapter?.loadEvents("browser-app").then(
      () => "unexpected success",
      (error: Error) => error.name,
    );
    const reopened = new window.nostrbase.IndexedDBPersistenceAdapter("browser-runtime");
    const open = await reopened.loadEvents().then(
      () => "unexpected success",
      (error: Error) => error.name,
    );
    await window.clients.get("main")?.closeAsync();
    return { existing, open };
  });
  expect(failures).toEqual({ existing: "InvalidStateError", open: "VersionError" });
});

// Risk: a real unmanaged tab can block an upgrade; closing that tab must release the request.
test("blocked upgrades identify the blocker and complete after its connection closes", async ({
  page,
  context,
  harness,
}) => {
  await openHarness(page, harness.url);
  await createClient(page, harness.relay.url);
  const blocker = await context.newPage();
  await openHarness(blocker, harness.url);
  await blocker.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("browser-runtime", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    // Deliberately retain this unmanaged connection through a versionchange event.
    db.onversionchange = () => {};
    Object.assign(window, { upgradeBlocker: db });
  });
  const upgrader = await context.newPage();
  await openHarness(upgrader, harness.url);
  await upgrader.evaluate(() => {
    const state = { blocked: false, completed: false, error: "" };
    Object.assign(window, { upgradeState: state });
    const request = indexedDB.open("browser-runtime", 2);
    request.onblocked = () => {
      state.blocked = true;
    };
    request.onerror = () => {
      state.error = request.error?.name ?? "unknown";
    };
    request.onsuccess = () => {
      state.completed = true;
      request.result.close();
    };
  });
  await upgrader.waitForFunction(
    () => (window as unknown as { upgradeState: { blocked: boolean } }).upgradeState.blocked,
  );
  expect(
    await upgrader.evaluate(
      () => (window as unknown as { upgradeState: { completed: boolean } }).upgradeState.completed,
    ),
  ).toBe(false);
  await blocker.close();
  await upgrader.waitForFunction(
    () => (window as unknown as { upgradeState: { completed: boolean } }).upgradeState.completed,
  );
  expect(
    await upgrader.evaluate(
      () => (window as unknown as { upgradeState: { error: string } }).upgradeState.error,
    ),
  ).toBe("");
  await page.evaluate(async () => window.clients.get("main")?.closeAsync());
});

// Risk: cancellation and close must release actual browser sockets/subscriptions and durable handles.
test("abort and close cancel pending wire reads, release subscriptions and keep local abort semantics", async ({
  page,
  harness,
}) => {
  harness.relay.readMode = "silence";
  await openHarness(page, harness.url);
  await createClient(page, harness.relay.url);
  await page.evaluate(() => {
    const client = window.clients.get("main");
    if (!client) throw new Error("Missing client");
    window.readController = new AbortController();
    window.pendingRead = (async () =>
      client.from("todos").abortSignal(window.readController?.signal as AbortSignal))();
  });
  await expect.poll(() => harness.relay.activeSubscriptions).toBe(1);
  const cancelled = await page.evaluate(async () => {
    window.readController?.abort();
    const result = await window.pendingRead;
    const local = await window.clients
      .get("main")
      ?.from("todos")
      .local()
      .abortSignal(window.readController?.signal as AbortSignal);
    return { code: result?.error?.code, localCode: local?.error?.code };
  });
  expect(cancelled).toEqual({ code: "ABORTED", localCode: "ABORTED" });
  await expect.poll(() => harness.relay.activeSubscriptions).toBe(0);
  await page.evaluate(() => {
    const client = window.clients.get("main");
    if (!client) throw new Error("Missing client");
    window.pendingRead = (async () => client.from("todos"))();
  });
  await expect.poll(() => harness.relay.activeSubscriptions).toBe(1);
  const closed = await page.evaluate(async () => {
    const client = window.clients.get("main");
    await client?.closeAsync();
    await client?.closeAsync();
    return (await window.pendingRead)?.error?.code;
  });
  expect(closed).toBe("ABORTED");
  await expect.poll(() => harness.relay.activeSubscriptions).toBe(0);
  await expect.poll(() => harness.relay.subscriptions.size).toBe(0);
  await createClient(page, harness.relay.url, { name: "reopened" });
  expect(
    await page.evaluate(
      async () => (await window.clients.get("reopened")?.from("todos").local())?.data,
    ),
  ).toEqual([]);
  await page.evaluate(async () => window.clients.get("reopened")?.closeAsync());
});
