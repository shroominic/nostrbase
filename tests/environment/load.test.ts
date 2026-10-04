import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient, MemoryPersistenceAdapter, type NostrbaseClient } from "../../src";
import { scopeTag, RECORD_KIND } from "../../src/protocol";
import { alice, type TestDB } from "../helpers";
import { relayOptions } from "../support/relay";
import type { RealtimeLoadReport } from "./support/load-workload";
import { type RelayService, relayImages, startRelayService } from "./support/relay-service";

const execute = promisify(execFile);
function setting(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  return value;
}
const duration = setting("NOSTRBASE_LOAD_DURATION_MS", 20000, 1000, 120000);
const rowCount = setting("NOSTRBASE_LOAD_ROWS", 64, 64, 128);
const clients = new Set<NostrbaseClient<TestDB>>();
let relay: RelayService;
function client(namespace: string, adapter = new MemoryPersistenceAdapter()) {
  const sdk = createClient<TestDB>({
    namespace,
    relays: [relay.url],
    signer: alice,
    relayOptions,
    timeout: 10000,
    offline: { adapter, maxEntries: 1000 },
    diagnostics: { capacity: 32 },
  });
  clients.add(sdk);
  return sdk;
}
async function report(name: string, metrics: object): Promise<void> {
  const directory = resolve("output/environment/load");
  await mkdir(directory, { recursive: true });
  const sdkPackage = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
    version: string;
  };
  const relayPackage = JSON.parse(
    await readFile(resolve("node_modules/applesauce-relay/package.json"), "utf8"),
  ) as { version: string };
  await writeFile(
    join(directory, `${name}-${Date.now()}-${randomUUID()}.json`),
    `${JSON.stringify({ relay: relayImages.strfry, sdkVersion: sdkPackage.version, applesauceRelayVersion: relayPackage.version, ...metrics }, null, 2)}\n`,
  );
}
beforeAll(async () => {
  relay = await startRelayService({ implementation: "strfry" });
});
afterEach(async () => {
  vi.useRealTimers();
  const closed = await Promise.allSettled([...clients].map((sdk) => sdk.closeAsync()));
  clients.clear();
  const failures = closed.filter((result) => result.status === "rejected");
  if (failures.length)
    throw new AggregateError(
      failures.map((result) => result.reason),
      "Load client cleanup failed.",
    );
});
afterAll(async () => {
  await relay?.stop();
});

describe("bounded load against independent strfry", () => {
  it(
    "sustains broadcast/presence channel turnover and returns explicit resources to baseline",
    async () => {
      const cache = resolve("output/integration-cache");
      await mkdir(cache, { recursive: true });
      const directory = await mkdtemp(join(cache, "load-workload-"));
      const child = join(directory, "workload.mjs");
      try {
        await build({
          entryPoints: [resolve("tests/environment/support/load-workload.ts")],
          outfile: child,
          platform: "node",
          format: "esm",
          bundle: true,
          packages: "external",
          sourcemap: "inline",
        });
        const { stdout } = await execute(
          process.execPath,
          ["--expose-gc", child, relay.url, `load-${randomUUID()}`, String(duration)],
          { timeout: duration + 20000, maxBuffer: 1024 * 1024 },
        );
        const metrics = JSON.parse(stdout) as RealtimeLoadReport;
        await report("realtime", metrics);
        expect(metrics.durationTargetMs).toBe(duration);
        expect(metrics.elapsedMs).toBeGreaterThanOrEqual(duration);
        expect(metrics.cycles).toBeGreaterThan(0);
        expect(metrics.broadcasts).toBe(metrics.cycles + metrics.warmupCycles);
        expect(metrics.joins).toBe(metrics.broadcasts);
        expect(metrics.leaves).toBe(metrics.broadcasts);
        expect(metrics.resources).toMatchObject({
          activeSubscriptions: 0,
          activeIntervals: 0,
          openSockets: 0,
          cachedEvents: 0,
        });
        expect(metrics.resources.maxDiagnosticEntries).toBeLessThanOrEqual(32);
        expect(metrics.memory.map((sample) => sample.point)).toContain("after-close");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    duration + 30000,
  );

  it("drains a substantial queued batch, keeps exact event identities, and pages tied records without duplicates", async () => {
    // Only wall-clock Date is fixed. Real sockets, timer deadlines, and performance.now stay real.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date());
    try {
      const namespace = `batch-${randomUUID()}`;
      const adapter = new MemoryPersistenceAdapter();
      const writer = client(namespace, adapter);
      const rows = Array.from({ length: rowCount }, (_, index) => ({
        id: `record-${index.toString().padStart(4, "0")}`,
        title: `Record ${index}`,
        done: index % 3 === 0,
        priority: index % 7,
        labels: ["batch", index % 2 ? "odd" : "even"],
      }));
      const began = performance.now();
      const queued = await writer.from("todos").insert(rows).queue().select();
      expect(queued.error).toBeNull();
      expect(queued.data).toHaveLength(rowCount);
      const timestampCounts = new Map<number, number>();
      for (const row of queued.data ?? [])
        timestampCounts.set(
          row._nostr.updatedAt,
          (timestampCounts.get(row._nostr.updatedAt) ?? 0) + 1,
        );
      expect(Math.max(...timestampCounts.values())).toBeGreaterThan(31);
      const original = await writer.offline.list();
      expect(original).toHaveLength(rowCount);
      const eventIds = original.map((entry) => entry.event.id).sort();
      for (const entry of [original[0], original[Math.floor(rowCount / 2)], original.at(-1)]) {
        if (!entry) throw new Error("Missing a duplicate enqueue sample.");
        expect((await writer.offline.enqueueSigned(entry.event)).error).toBeNull();
      }
      expect(await writer.offline.list()).toHaveLength(rowCount);
      await writer.closeAsync();
      const reopened = client(namespace, adapter);
      expect((await reopened.offline.list()).map((entry) => entry.event.id).sort()).toEqual(
        eventIds,
      );
      const flushed = await reopened.offline.flush();
      expect(flushed.error).toBeNull();
      expect(flushed.data?.map((receipt) => receipt.eventId).sort()).toEqual(eventIds);
      expect(await reopened.offline.list()).toEqual([]);
      const replayBegan = performance.now();
      for (const entry of original)
        expect((await reopened.events.publishSigned(entry.event)).error).toBeNull();
      expect(await reopened.offline.list()).toEqual([]);
      const reader = client(namespace);
      const observed = await reader.events.query({
        kinds: [RECORD_KIND],
        "#t": [scopeTag(namespace, "todos")],
        limit: 500,
      });
      expect(observed.error).toBeNull();
      expect(observed.data?.map((event) => event.id).sort()).toEqual(eventIds);
      const pageIds: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await reader.from("todos").page(31, { cursor });
        expect(page.error).toBeNull();
        pageIds.push(...(page.data ?? []).map((row) => row.id));
        cursor = page.meta?.nextCursor;
        pages++;
        expect(pages).toBeLessThanOrEqual(Math.ceil(rowCount / 31) + 1);
      } while (cursor);
      expect(new Set(pageIds).size).toBe(rowCount);
      expect(pageIds.sort()).toEqual(rows.map((row) => row.id).sort());
      const filtered = await reader.from("todos").eq("done", true).contains("labels", ["even"]);
      expect(filtered.error).toBeNull();
      expect(filtered.data?.map((row) => row.id).sort()).toEqual(
        rows
          .filter((row) => row.done && row.labels.includes("even"))
          .map((row) => row.id)
          .sort(),
      );
      expect(reopened.diagnostics.list()).toHaveLength(32);
      const snapshot = await reader.dashboard.snapshot();
      expect(snapshot.relays.every((entry) => entry.pendingRequests === 0)).toBe(true);
      await report("queued-batch", {
        node: process.version,
        rowCount,
        pages,
        queuedEventCount: eventIds.length,
        queueStorage: "explicit memory fixture across client reopen",
        elapsedMs: performance.now() - began,
        replayAndReadMs: performance.now() - replayBegan,
        cacheHistoryEvents: reopened.cachedEvents().length,
        queuedEntries: (await reopened.offline.list()).length,
        pendingRequests: snapshot.relays.map((entry) => entry.pendingRequests),
        largestTimestampTie: Math.max(...timestampCounts.values()),
      });
    } finally {
      vi.useRealTimers();
    }
  }, 120000);
});
