import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyEvent } from "nostr-tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QueuedEvent } from "../../src";
import type {} from "../browser/support/entry";
import { startBrowserHarness, type BrowserHarness } from "../browser/support/server";
import { startCrashBrowser } from "./support/crash-browser";

declare global {
  interface Window {
    crashGate?: { reached: boolean; committed: boolean; event?: QueuedEvent };
  }
}

describe("abrupt Chromium process recovery with real persistent IndexedDB", () => {
  let harness: BrowserHarness;
  let profile: string;
  let browser: Awaited<ReturnType<typeof startCrashBrowser>> | undefined;
  beforeEach(async () => {
    harness = await startBrowserHarness();
    profile = await mkdtemp(join(tmpdir(), "nostrbase-crash-"));
  });
  afterEach(async () => {
    const errors: unknown[] = [];
    try {
      await browser?.kill();
    } catch (error) {
      errors.push(error);
    }
    browser = undefined;
    try {
      await harness?.close();
    } catch (error) {
      errors.push(error);
    }
    await rm(profile, { recursive: true, force: true });
    if (errors.length) throw new AggregateError(errors, "Crash integration cleanup failed.");
  });
  async function open() {
    browser = await startCrashBrowser(profile, harness.url);
    await browser.page.evaluate(
      async (relay) =>
        window.createHarnessClient({
          name: "main",
          database: "crash-runtime",
          namespace: "crash-app",
          relay,
        }),
      harness.relay.url,
    );
    return browser.page;
  }
  async function crash() {
    const result = await browser?.kill();
    expect(result?.signal).toBe("SIGKILL");
  }

  it("retains committed public/private queues and replays the same signatures after SIGKILL", async () => {
    const page = await open();
    const committed = await page.evaluate(async () => {
      const client = window.clients.get("main");
      if (!client) throw new Error("Missing client.");
      const publicWrite = await client
        .from("todos")
        .insert({ id: "public", title: "public value" })
        .queue();
      const privateWrite = await client.private
        .from("todos")
        .insert({ id: "private", title: "private value" })
        .queue();
      if (publicWrite.error || privateWrite.error) throw publicWrite.error ?? privateWrite.error;
      await client.persistence?.flush();
      return {
        queue: await client.offline.list(),
        disk: await window.adapters.get("main")?.loadEvents("crash-app"),
      };
    });
    expect(committed.queue).toHaveLength(2);
    expect(committed.queue.every((entry) => verifyEvent(structuredClone(entry.event)))).toBe(true);
    expect(JSON.stringify(committed.disk)).not.toContain("private value");
    expect(harness.relay.events.size).toBe(0);
    await crash(); // No SDK close, page close, context close, or browser shutdown precedes this.
    const restoredPage = await open();
    const restored = await restoredPage.evaluate(async () => {
      const client = window.clients.get("main");
      if (!client) throw new Error("Missing client.");
      const queue = await client.offline.list();
      const publicRows = await client.from("todos").local();
      const privateRows = await client.private.from("todos").local();
      const flushed = await client.offline.flush();
      return { queue, publicRows, privateRows, flushed, remaining: await client.offline.list() };
    });
    expect(restored.queue).toEqual(committed.queue);
    expect(restored.publicRows.data?.map((row) => row.title)).toEqual(["public value"]);
    expect(restored.privateRows.data?.map((row) => row.title)).toEqual(["private value"]);
    expect(restored.flushed.error).toBeNull();
    expect(restored.remaining).toEqual([]);
    expect(
      harness.relay.frames.filter((frame) => frame[0] === "EVENT").map((frame) => frame[1]),
    ).toEqual(committed.queue.map((entry) => entry.event));
  });

  it("replays an acknowledged event exactly when killed before durable queue removal", async () => {
    const page = await open();
    const queued = await page.evaluate(async () => {
      const client = window.clients.get("main");
      if (!client) throw new Error("Missing client.");
      const result = await client
        .from("todos")
        .insert({ id: "accepted", title: "accepted" })
        .queue();
      if (result.error) throw result.error;
      await client.persistence?.flush();
      const queue = await client.offline.list();
      const adapter = client.offline.adapter;
      const remove = adapter.removeQueue.bind(adapter);
      window.crashGate = { reached: false, committed: false };
      // A deterministic pause at the real ACK -> removeQueue boundary, without throwing.
      adapter.removeQueue = async (id, namespace) => {
        if (!window.crashGate) throw new Error("Missing crash gate.");
        window.crashGate.reached = true;
        await new Promise<void>(() => {});
        await remove(id, namespace);
      };
      void client.offline.flush();
      return queue;
    });
    await page.waitForFunction(() => window.crashGate?.reached);
    expect(harness.relay.events.has(queued[0]?.event.id ?? "")).toBe(true);
    expect(
      harness.relay.frames.filter((frame) => frame[0] === "EVENT").map((frame) => frame[1]),
    ).toEqual(queued.map((entry) => entry.event));
    await crash();
    const reopened = await open();
    const recovered = await reopened.evaluate(async () => {
      const client = window.clients.get("main");
      if (!client) throw new Error("Missing client.");
      const queue = await client.offline.list();
      const flushed = await client.offline.flush();
      return { queue, flushed, remaining: await client.offline.list() };
    });
    expect(recovered.queue.map((entry) => entry.event)).toEqual(queued.map((entry) => entry.event));
    expect(recovered.queue[0]?.attempts).toBe(1);
    expect(recovered.flushed.error).toBeNull();
    expect(recovered.remaining).toEqual([]);
    const attempts = harness.relay.frames
      .filter((frame) => frame[0] === "EVENT")
      .map((frame) => frame[1]);
    expect(attempts).toEqual([queued[0]?.event, queued[0]?.event]);
    expect(harness.relay.events.size).toBe(1);
  });

  it("retains committed deletion tombstones without resurrecting cached older records", async () => {
    const page = await open();
    const before = await page.evaluate(async () => {
      const client = window.clients.get("main");
      if (!client) throw new Error("Missing client.");
      const created = await client
        .from("todos")
        .insert([
          { id: "gone", title: "old" },
          { id: "live", title: "live" },
        ])
        .queue();
      const deleted = await client.from("todos").delete().eq("id", "gone").queue();
      if (created.error || deleted.error) throw created.error ?? deleted.error;
      await client.persistence?.flush();
      return {
        queue: await client.offline.list(),
        events: await window.adapters.get("main")?.loadEvents("crash-app"),
      };
    });
    expect(before.events?.some((event) => event.kind === 5)).toBe(true);
    await crash();
    const reopened = await open();
    const recovered = await reopened.evaluate(async () => {
      const client = window.clients.get("main");
      if (!client) throw new Error("Missing client.");
      return {
        rows: await client.from("todos").local(),
        queue: await client.offline.list(),
        events: await window.adapters.get("main")?.loadEvents("crash-app"),
      };
    });
    expect(recovered.queue).toEqual(before.queue);
    expect(recovered.events).toEqual(before.events);
    expect(recovered.rows.data?.map((row) => row.id)).toEqual(["live"]);
    expect(harness.relay.frames).toEqual([]);
  });

  it("excludes a real queue write whose IndexedDB transaction had not committed at SIGKILL", async () => {
    const page = await open();
    await page.evaluate(() => {
      const original = IDBDatabase.prototype.transaction;
      window.crashGate = { reached: false, committed: false };
      IDBDatabase.prototype.transaction = function (...args) {
        const tx = original.apply(this, args);
        if (args[0] === "queue" && args[1] === "readwrite") {
          const store = tx.objectStore("queue");
          tx.addEventListener("complete", () => {
            if (window.crashGate) window.crashGate.committed = true;
          });
          // Keep the SDK's actual transaction active by chaining real IDB requests.
          const keepAlive = () => {
            const request = store.getAll();
            request.onsuccess = () => {
              const entry = request.result[0]?.entry as QueuedEvent | undefined;
              if (entry && window.crashGate) {
                window.crashGate.event = entry;
                window.crashGate.reached = true;
              }
              keepAlive();
            };
          };
          keepAlive();
        }
        return tx;
      };
      const client = window.clients.get("main");
      if (!client) throw new Error("Missing client.");
      void Promise.resolve(
        client.from("todos").insert({ id: "uncommitted", title: "uncommitted" }).queue(),
      );
    });
    await page.waitForFunction(() => window.crashGate?.reached);
    const held = await page.evaluate(() => window.crashGate);
    expect(held?.committed).toBe(false);
    expect(held?.event && verifyEvent(structuredClone(held.event.event))).toBe(true);
    await crash();
    const reopened = await open();
    const recovered = await reopened.evaluate(async () => {
      const client = window.clients.get("main");
      if (!client) throw new Error("Missing client.");
      return {
        queue: await client.offline.list(),
        rows: await client.from("todos").local(),
        events: await window.adapters.get("main")?.loadEvents("crash-app"),
      };
    });
    expect(recovered.queue).toEqual([]);
    expect(recovered.rows.data).toEqual([]);
    expect(recovered.events).toEqual([]);
    expect(harness.relay.frames).toEqual([]);
  });
});
