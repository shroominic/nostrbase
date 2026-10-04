import { verifyEvent } from "nostr-tools";
import { expect, test } from "./support/fixtures";
import type {} from "./support/entry";

test("password backup restores identity after page reload and wrong passwords retain the session", async ({
  page,
  harness,
}) => {
  await page.goto(harness.url);
  await page.waitForFunction(() => window.harnessReady);
  const saved = await page.evaluate(async (relay) => {
    const db = window.nostrbase.createClient({
      namespace: "key-browser",
      relays: [relay],
      signer: new window.nostrbase.PrivateKeySigner(new Uint8Array(32).fill(3)),
    });
    try {
      const before = await db.auth.getSession();
      const backup = await db.auth.exportKey("browser recovery password", { logn: 10 });
      if (backup.error || !backup.data) throw backup.error ?? new Error("No backup");
      return { backup: backup.data, pubkey: before.data?.user.pubkey };
    } finally {
      await db.closeAsync();
    }
  }, harness.relay.url);
  expect(saved.backup).toMatch(/^ncryptsec1/);
  await page.reload();
  await page.waitForFunction(() => window.harnessReady);
  const restored = await page.evaluate(
    async ({ backup, relay }) => {
      const db = window.nostrbase.createClient({ namespace: "key-browser", relays: [relay] });
      try {
        const recovered = await db.auth.signInWithEncryptedKey(backup, "browser recovery password");
        const wrong = await db.auth.signInWithEncryptedKey(backup, "wrong password");
        const retained = await db.auth.getSession();
        const write = await db
          .from("tasks")
          .insert({ id: "restored", title: "signed by restored identity" })
          .queue();
        const queue = await db.offline.list();
        return {
          pubkey: recovered.data?.user.pubkey,
          error: recovered.error?.code,
          wrong: wrong.error?.code,
          retained: retained.data?.user.pubkey,
          write: write.error?.code,
          queue,
        };
      } finally {
        await db.closeAsync();
      }
    },
    { backup: saved.backup, relay: harness.relay.url },
  );
  expect(restored.error).toBeUndefined();
  expect(restored.pubkey).toBe(saved.pubkey);
  expect(restored.retained).toBe(saved.pubkey);
  expect(restored.wrong).toBe("AUTH_FAILED");
  expect(restored.write).toBeUndefined();
  expect(restored.queue).toHaveLength(1);
  const restoredEvent = restored.queue[0]?.event;
  if (!restoredEvent) throw new Error("No restored event");
  expect(verifyEvent(structuredClone(restoredEvent))).toBe(true);
  expect(restored.queue[0]?.event.pubkey).toBe(saved.pubkey);
  expect(harness.relay.events.size).toBe(0);
});

test("automatic replay restores IndexedDB work, retains rejected events, and sends exact saved signatures", async ({
  page,
  harness,
}) => {
  await page.goto(harness.url);
  await page.waitForFunction(() => window.harnessReady);
  const saved = await page.evaluate(async (relay) => {
    await window.createHarnessClient({
      name: "queued",
      namespace: "replay-browser",
      database: "replay-browser",
      relay,
    });
    const db = window.clients.get("queued");
    if (!db) throw new Error("No client");
    try {
      const publicWrite = await db.from("tasks").insert({ id: "one", title: "public" }).queue();
      const privateWrite = await db.private
        .from("tasks")
        .insert({ id: "two", title: "private" })
        .queue();
      if (publicWrite.error || privateWrite.error) throw publicWrite.error ?? privateWrite.error;
      return await db.offline.list();
    } finally {
      await db.closeAsync();
    }
  }, harness.relay.url);
  expect(saved).toHaveLength(2);
  harness.relay.writeMode = "reject";
  await page.reload();
  await page.waitForFunction(() => window.harnessReady);
  await page.evaluate(async (relay) => {
    const adapter = new window.nostrbase.IndexedDBPersistenceAdapter("replay-browser");
    const db = window.nostrbase.createClient({
      namespace: "replay-browser",
      relays: [relay],
      signer: new window.nostrbase.PrivateKeySigner(new Uint8Array(32).fill(1)),
      persistence: { adapter },
      offline: { autoReplay: { retryDelay: 60000, maxRetryDelay: 60000 } },
      timeout: 10000,
      relayOptions: { keepAlive: 0 },
    });
    window.clients.set("replayed", db);
    await db.ready();
  }, harness.relay.url);
  await expect
    .poll(() =>
      page.evaluate(() => window.clients.get("replayed")?.offline.autoReplayStatus.failures),
    )
    .toBe(1);
  const rejected = await page.evaluate(async () => {
    const db = window.clients.get("replayed");
    if (!db) throw new Error("No client");
    db.offline.stopAutoReplay();
    return await db.offline.list();
  });
  expect(rejected.map((entry) => entry.event)).toEqual(saved.map((entry) => entry.event));
  expect(harness.relay.events.size).toBe(0);
  harness.relay.writeMode = "accept";
  await page.evaluate(() => window.clients.get("replayed")?.offline.startAutoReplay());
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.clients.get("replayed")?.offline.list())?.length),
    )
    .toBe(0);
  await page.evaluate(async () => window.clients.get("replayed")?.closeAsync());
  const published = harness.relay.frames
    .filter((frame) => frame[0] === "EVENT")
    .map((frame) => frame[1]);
  for (const entry of saved) {
    expect(
      published.filter((event) => JSON.stringify(event) === JSON.stringify(entry.event)).length,
    ).toBeGreaterThanOrEqual(2);
    expect(harness.relay.events.get(entry.event.id)).toEqual(entry.event);
  }
  // Durable queue removal must survive another page reload.
  await page.reload();
  await page.waitForFunction(() => window.harnessReady);
  const remaining = await page.evaluate(async (relay) => {
    await window.createHarnessClient({
      name: "final",
      namespace: "replay-browser",
      database: "replay-browser",
      relay,
    });
    const db = window.clients.get("final");
    try {
      return await db?.offline.list();
    } finally {
      await db?.closeAsync();
    }
  }, harness.relay.url);
  expect(remaining).toEqual([]);
});
