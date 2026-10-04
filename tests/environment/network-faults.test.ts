import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createClient,
  MemoryPersistenceAdapter,
  type ClientOptions,
  type NostrbaseClient,
} from "../../src";
import { alice, type TestDB } from "../helpers";
import { relayOptions } from "../support/relay";
import { UpstreamBlossom } from "./support/blossom-service";
import { HttpFaultProxy, RelayFaultProxy } from "./support/fault-proxy";
import { type RelayService, startRelayService } from "./support/relay-service";

const clients = new Set<NostrbaseClient<TestDB>>();
const proxies = new Set<{ close(): Promise<void> }>();
function client(url: string, namespace: string, options: Partial<ClientOptions<TestDB>> = {}) {
  const sdk = createClient<TestDB>({
    namespace,
    relays: [url],
    signer: alice,
    relayOptions,
    timeout: 5000,
    ...options,
  });
  clients.add(sdk);
  return sdk;
}
afterEach(async () => {
  const closedClients = await Promise.allSettled([...clients].map((sdk) => sdk.closeAsync()));
  clients.clear();
  const closedProxies = await Promise.allSettled([...proxies].map((proxy) => proxy.close()));
  proxies.clear();
  const failures = [...closedClients, ...closedProxies].filter(
    (result) => result.status === "rejected",
  );
  if (failures.length)
    throw new AggregateError(
      failures.map((result) => result.reason),
      "Network test cleanup failed.",
    );
});

describe("relay transport faults against independent strfry", () => {
  let relay: RelayService;
  beforeAll(async () => {
    relay = await startRelayService({ implementation: "strfry" });
  });
  afterAll(async () => {
    await relay?.stop();
  });
  async function proxy() {
    const result = await RelayFaultProxy.start(relay.url);
    proxies.add(result);
    return result;
  }

  it("retains an uncertain queued write and replays its exact signature after a lost ACK and server restart", async () => {
    const wire = await proxy();
    const namespace = `uncertain-${randomUUID()}`;
    // Queue storage is explicitly a memory fixture. The upstream LMDB restart is real.
    const adapter = new MemoryPersistenceAdapter();
    const sdk = client(wire.url, namespace, { offline: { adapter } });
    const signed = structuredClone(
      await alice.signEvent({
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: `lost acknowledgement ${namespace}`,
      }),
    );
    expect((await sdk.offline.enqueueSigned(signed)).error).toBeNull();
    wire.hold = (frame) => frame[0] === "OK" && frame[1] === signed.id;
    const controller = new AbortController();
    const uncertain = sdk.offline.flush({ signal: controller.signal });
    const accepted = await wire.traffic.wait(
      (entry) =>
        entry.direction === "server" && entry.frame[0] === "OK" && entry.frame[1] === signed.id,
    );
    expect(accepted.frame[2]).toBe(true);
    controller.abort();
    expect((await uncertain).error?.code).toBe("ABORTED");
    const retained = await sdk.offline.list();
    expect(retained).toHaveLength(1);
    expect(retained[0]).toMatchObject({ event: signed, attempts: 1 });
    await sdk.closeAsync();
    wire.cutConnections();
    await relay.restart();
    const direct = client(relay.url, namespace);
    expect(
      (await direct.events.query({ ids: [signed.id] })).data?.map((event) =>
        structuredClone(event),
      ),
    ).toEqual([signed]);
    const reopened = client(wire.url, namespace, { offline: { adapter } });
    expect((await reopened.offline.list())[0]?.event).toEqual(signed);
    let finished = false;
    const replay = reopened.offline.flush().finally(() => {
      finished = true;
    });
    const replayAck = await wire.traffic.wait(
      (entry) =>
        entry.direction === "server" &&
        entry.connection > accepted.connection &&
        entry.frame[0] === "OK" &&
        entry.frame[1] === signed.id,
    );
    expect(replayAck.frame[2]).toBe(true);
    expect(finished).toBe(false);
    // The retained ACK is released only after an actual duplicate acceptance is observed.
    wire.releaseFrames();
    expect((await replay).error).toBeNull();
    expect(await reopened.offline.list()).toEqual([]);
    const attempts = wire.traffic.entries.filter(
      (entry) => entry.direction === "client" && entry.frame[0] === "EVENT",
    );
    expect(attempts.map((entry) => entry.frame[1])).toEqual([signed, signed]);
    expect((await direct.events.query({ ids: [signed.id] })).data).toHaveLength(1);
  });

  it("ignores delayed events after a read is aborted and closes its wire subscription", async () => {
    const namespace = `cancel-${randomUUID()}`;
    const writer = client(relay.url, namespace);
    const created = await writer
      .from("todos")
      .insert({ id: "late", title: "must not enter cancelled cache", done: false });
    expect(created.error).toBeNull();
    const id = created.meta?.receipts?.[0]?.eventId;
    const wire = await proxy();
    wire.hold = (frame) => frame[0] === "EVENT" || frame[0] === "EOSE";
    const reader = client(wire.url, namespace);
    const controller = new AbortController();
    const pending = Promise.resolve(reader.from("todos").abortSignal(controller.signal));
    const delayed = await wire.traffic.wait(
      (entry) =>
        entry.direction === "server" &&
        entry.frame[0] === "EVENT" &&
        (entry.frame[2] as { id: string }).id === id,
    );
    controller.abort();
    expect((await pending).error?.code).toBe("ABORTED");
    await wire.traffic.wait(
      (entry) =>
        entry.direction === "client" &&
        entry.frame[0] === "CLOSE" &&
        entry.frame[1] === delayed.frame[1],
    );
    expect(reader.cachedEvents()).toEqual([]);
    wire.releaseFrames();
    // A completed later REQ is an ordered drain boundary for the released old frames.
    expect((await reader.events.query({ ids: ["0".repeat(64)] })).error).toBeNull();
    expect(reader.cachedEvents()).toEqual([]);
    expect((await reader.from("todos").local()).data).toEqual([]);
  });

  it("recovers missed records and tombstones after a real socket cut and explicit reconnection gate", async () => {
    const namespace = `reconnect-${randomUUID()}`;
    const writer = client(relay.url, namespace);
    expect(
      (await writer.from("todos").insert({ id: "removed", title: "initial", done: false })).error,
    ).toBeNull();
    const wire = await proxy();
    const reader = client(wire.url, namespace, {
      sync: { tables: ["todos"], reconnect: true, timeout: 5000 },
    });
    expect((await reader.from("todos").single()).data?.id).toBe("removed");
    const seen: string[] = [];
    const previousReqIds = new Set(
      wire.traffic.entries
        .filter((entry) => entry.direction === "client" && entry.frame[0] === "REQ")
        .map((entry) => entry.frame[1]),
    );
    reader
      .channel("recover")
      .on("nostr_changes", { table: "todos" }, (payload) => seen.push(payload.eventType))
      .subscribe();
    const liveReq = await wire.traffic.wait(
      (entry) =>
        entry.direction === "client" &&
        entry.frame[0] === "REQ" &&
        !previousReqIds.has(entry.frame[1]),
    );
    await wire.traffic.wait(
      (entry) =>
        entry.direction === "server" &&
        entry.frame[0] === "EOSE" &&
        entry.frame[1] === liveReq.frame[1],
    );
    const before = wire.connections.entries.at(-1) ?? 0;
    wire.paused = true;
    wire.cutConnections();
    // Downstream reconnects are accepted, but no upstream frame can pass until release.
    await wire.connections.wait((number) => number > before);
    expect((await writer.from("todos").delete().eq("id", "removed")).error).toBeNull();
    expect(
      (
        await writer
          .from("todos")
          .insert({ id: "missed", title: "written while disconnected", done: false })
      ).error,
    ).toBeNull();
    wire.resumeConnections();
    await expect
      .poll(async () => (await reader.from("todos").local()).data?.map((row) => row.id), {
        timeout: 10000,
      })
      .toEqual(["missed"]);
    const updated = await writer.from("todos").update({ done: true }).eq("id", "missed");
    expect(updated.error).toBeNull();
    await expect
      .poll(async () => (await reader.from("todos").local().single()).data?.done, {
        timeout: 10000,
      })
      .toBe(true);
    expect(seen).toContain("UPDATE");
    const recovery = wire.traffic.entries.filter(
      (entry) =>
        entry.connection > before && entry.direction === "client" && entry.frame[0] === "NEG-OPEN",
    );
    expect(recovery.length).toBeGreaterThan(0);
  });
});

describe("HTTP stream faults against independent Blossom", () => {
  let server: UpstreamBlossom;
  beforeAll(async () => {
    server = await UpstreamBlossom.start();
  });
  afterAll(async () => {
    await server?.close();
  });
  async function proxy() {
    const result = await HttpFaultProxy.start(server.url);
    proxies.add(result);
    return result;
  }

  for (const stage of ["headers", "body"] as const) {
    it(`rejects a download cut at ${stage} and succeeds on a complete retry`, async () => {
      const namespace = `download-${stage}-${randomUUID()}`;
      const direct = client("ws://127.0.0.1:1/", namespace);
      const bytes = new TextEncoder().encode(`${namespace}|`.repeat(600));
      const uploaded = await direct.storage
        .from(server.url)
        .upload("download.txt", new Blob([bytes], { type: "text/plain" }));
      expect(uploaded.error).toBeNull();
      const hash = uploaded.data?.sha256 as string;
      const transport = await proxy();
      let headersReceived = () => {};
      const headersBoundary = new Promise<void>((resolve) => {
        headersReceived = resolve;
      });
      const sdk = client("ws://127.0.0.1:1/", namespace, {
        storage: {
          fetch: async (input, init) => {
            const response = await fetch(input, init);
            headersReceived();
            return response;
          },
        },
      });
      const bucket = sdk.storage.from(transport.url);
      const fault = transport.arm("GET", `/${hash}`, stage);
      const pending = bucket.download(hash);
      expect(await fault.observed).toEqual({
        status: 200,
        bytesForwarded: stage === "body" ? 1 : 0,
      });
      if (stage === "body") await headersBoundary;
      fault.cut();
      const failed = await pending;
      expect(failed.error?.code).toBe("RELAY_ERROR");
      expect(failed.data).toBeNull();
      const retry = await bucket.download(hash);
      expect(retry.error).toBeNull();
      expect(new Uint8Array(await (retry.data as Blob).arrayBuffer())).toEqual(bytes);
      expect((await direct.storage.from(server.url).remove([hash])).error).toBeNull();
    });
  }

  it("reports an aborted upload with unknown outcome and safely repeats the same content-addressed object", async () => {
    const namespace = `upload-${randomUUID()}`;
    const text = `committed before lost response ${namespace}`;
    const blob = new Blob([text], { type: "text/plain" });
    const hash = createHash("sha256").update(text).digest("hex");
    const transport = await proxy();
    const sdk = client("ws://127.0.0.1:1/", namespace);
    const direct = sdk.storage.from(server.url);
    const bucket = sdk.storage.from(transport.url);
    const fault = transport.arm("PUT", "/upload", "headers");
    const controller = new AbortController();
    const pending = bucket.upload("uncertain.txt", blob, { signal: controller.signal });
    const accepted = await fault.observed;
    expect(accepted.status).toBeGreaterThanOrEqual(200);
    expect(accepted.status).toBeLessThan(300);
    expect((await direct.list()).data?.some((entry) => entry.sha256 === hash)).toBe(true);
    controller.abort();
    const uncertain = await pending;
    expect(uncertain.error?.code).toBe("ABORTED");
    expect(uncertain.data).toBeNull();
    const retry = await bucket.upload("uncertain.txt", blob);
    expect(retry.error).toBeNull();
    expect(retry.data?.sha256).toBe(hash);
    expect((await direct.list()).data?.filter((entry) => entry.sha256 === hash)).toHaveLength(1);
    expect(await (await bucket.download(hash)).data?.text()).toBe(text);
    expect((await direct.remove([hash])).error).toBeNull();
  });
});
