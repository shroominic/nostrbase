import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { verifyEvent } from "nostr-tools";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createClient, type NostrbaseClient, PrivateKeySigner } from "../../src";
import { scopeTag } from "../../src/protocol";
import { relayOptions } from "../support/relay";
import { UpstreamBlossom } from "./support/blossom-service";
import { livePayload } from "./support/live-payload";
import { type RelayService, startRelayService } from "./support/relay-service";

interface Deployment {
  relay: string;
  blossom: string;
  namespace: string;
  writes: boolean;
  local: boolean;
  signer: PrivateKeySigner;
}
interface RelayInformation {
  software?: string;
  version?: string;
  supported_nips: number[];
  negentropy?: number;
}
function endpoint(
  value: string | undefined,
  name: string,
  protocols: string[],
  origin = false,
): string {
  if (!value)
    throw new Error(
      `Set ${name} explicitly, or set NOSTRBASE_LIVE_LOCAL=1 for isolated local validation.`,
    );
  try {
    const url = new URL(value);
    if (
      !protocols.includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (origin && url.pathname !== "/")
    )
      throw new Error("Invalid endpoint");
    return origin ? url.origin : url.toString();
  } catch {
    throw new Error(
      `${name} must have the required protocol and no credentials, query, or fragment; Blossom requires an origin.`,
    );
  }
}
function flag(name: string): boolean {
  const value = process.env[name];
  if (value !== undefined && value !== "0" && value !== "1")
    throw new Error(`${name} must be 0 or 1.`);
  return value === "1";
}

let localRelay: RelayService | undefined;
let localBlossom: UpstreamBlossom | undefined;
let client: NostrbaseClient | undefined;
let deployment: Deployment;
let information: RelayInformation;
let setupFailure: Error | undefined;
const report: Record<string, unknown> = { started: new Date().toISOString(), checks: {} };
const checks = report.checks as Record<string, unknown>;
const artifact = process.env.NOSTRBASE_LIVE_REPORT_FILE
  ? resolve(process.env.NOSTRBASE_LIVE_REPORT_FILE)
  : resolve("output/environment/live", `compatibility-${Date.now()}-${process.pid}.json`);
const missingHash = "0".repeat(64);
const origin = "https://nostrbase-integration.invalid";

async function configure(): Promise<Deployment> {
  const local = flag("NOSTRBASE_LIVE_LOCAL");
  const writes = flag("NOSTRBASE_LIVE_WRITE");
  if (!["text", "json", "png"].includes(process.env.NOSTRBASE_LIVE_BLOB_FORMAT ?? "text"))
    throw new Error("NOSTRBASE_LIVE_BLOB_FORMAT must be text, json, or png.");
  let relay: string;
  let blossom: string;
  let namespace =
    process.env.NOSTRBASE_LIVE_NAMESPACE ?? `nostrbase-integration-read-${randomUUID()}`;
  let signer = new PrivateKeySigner();
  if (local) {
    if (
      process.env.NOSTRBASE_LIVE_RELAY ||
      process.env.NOSTRBASE_LIVE_BLOSSOM ||
      process.env.NOSTRBASE_LIVE_TEST_KEY ||
      process.env.NOSTRBASE_LIVE_TEST_PUBKEY
    )
      throw new Error("Local validation must not contain external endpoints or identities.");
    localRelay = await startRelayService({ implementation: "strfry" });
    localBlossom = await UpstreamBlossom.start();
    relay = localRelay.url;
    blossom = localBlossom.url;
    namespace = `nostrbase-integration-local-${randomUUID()}`;
    for (const value of [relay, blossom])
      if (new URL(value).hostname !== "127.0.0.1")
        throw new Error("Local services must bind to loopback.");
    report.provenance = {
      relay: "strfry 1.1.3, digest pinned by relay-service helper",
      blossom: "hzrd149/blossom-server 6.4.0, commit 32567afb15255c171817a78ed2861cd9e57bf4de",
    };
  } else {
    relay = endpoint(process.env.NOSTRBASE_LIVE_RELAY, "NOSTRBASE_LIVE_RELAY", ["ws:", "wss:"]);
    blossom = endpoint(
      process.env.NOSTRBASE_LIVE_BLOSSOM,
      "NOSTRBASE_LIVE_BLOSSOM",
      ["http:", "https:"],
      true,
    );
    if (writes) {
      const key = process.env.NOSTRBASE_LIVE_TEST_KEY;
      const pubkey = process.env.NOSTRBASE_LIVE_TEST_PUBKEY;
      if (!key || !/^[0-9a-f]{64}$/.test(key) || !pubkey || !/^[0-9a-f]{64}$/.test(pubkey))
        throw new Error(
          "Writes require NOSTRBASE_LIVE_TEST_KEY and its matching NOSTRBASE_LIVE_TEST_PUBKEY for a dedicated test account.",
        );
      if (
        !process.env.NOSTRBASE_LIVE_NAMESPACE ||
        !/^nostrbase-integration-[a-zA-Z0-9_-]{1,128}$/.test(namespace)
      )
        throw new Error(
          "Writes require a dedicated NOSTRBASE_LIVE_NAMESPACE beginning with nostrbase-integration-.",
        );
      signer = PrivateKeySigner.fromKey(key);
      if ((await signer.getPublicKey()) !== pubkey)
        throw new Error("The configured dedicated test public key does not match its private key.");
    } else if (process.env.NOSTRBASE_LIVE_TEST_KEY || process.env.NOSTRBASE_LIVE_TEST_PUBKEY)
      throw new Error(
        "Read-only mode uses a temporary identity. Remove write identity settings or explicitly enable NOSTRBASE_LIVE_WRITE=1.",
      );
  }
  return { relay, blossom, namespace, writes, local, signer };
}

function sdk() {
  if (!client) throw new Error("Live compatibility setup did not complete.");
  return client;
}
async function http(path: string, options: RequestInit = {}) {
  return fetch(`${deployment.blossom}${path}`, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
}

describe("explicit deployment compatibility: read-only unless writes are separately enabled", () => {
  beforeAll(async () => {
    try {
      deployment = await configure();
      report.mode = deployment.writes ? "opt-in-writes" : "read-only";
      report.environment = deployment.local ? "isolated-local" : "explicit-external";
      report.endpoints = { relay: deployment.relay, blossom: deployment.blossom };
      const url = new URL(deployment.relay);
      url.protocol = url.protocol === "wss:" ? "https:" : "http:";
      const response = await fetch(url, {
        headers: { Accept: "application/nostr+json" },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      expect(response.ok).toBe(true);
      information = (await response.json()) as RelayInformation;
      expect(Array.isArray(information.supported_nips)).toBe(true);
      expect(information.supported_nips.every((nip) => Number.isSafeInteger(nip) && nip >= 0)).toBe(
        true,
      );
      report.relay = {
        software: information.software ?? "undeclared",
        version: information.version ?? "undeclared",
        supportedNips: information.supported_nips,
        negentropy: information.negentropy ?? "undeclared",
      };
      client = createClient({
        namespace: deployment.namespace,
        relays: [deployment.relay],
        signer: deployment.signer,
        relayOptions: { ...relayOptions, keepAlive: deployment.local ? 0 : 30_000 },
        timeout: 10_000,
        sync: { timeout: 5000 },
        storage: {
          timeout: 10_000,
          fetch: async (input, options) => {
            const response = await fetch(input, options);
            if (!response.ok) {
              const body = (await response.clone().text())
                .slice(0, 1000)
                .replace(/Nostr\s+[A-Za-z0-9_+/-]+={0,2}/gi, "Nostr [redacted]");
              report.storageErrors ??= [];
              const errors = report.storageErrors as unknown[];
              errors.push({
                method: options?.method ?? "GET",
                status: response.status,
                reason: response.headers.get("x-reason"),
                body,
              });
            }
            return response;
          },
        },
      });
      report.setup = { ok: true };
    } catch (error) {
      setupFailure = error instanceof Error ? error : new Error("Live compatibility setup failed.");
      report.setup = { ok: false, message: setupFailure.message };
    }
  });
  beforeEach(() => {
    if (setupFailure) throw setupFailure;
  });
  afterAll(async () => {
    try {
      await client?.closeAsync();
      await Promise.all([localRelay?.stop(), localBlossom?.close()]);
    } finally {
      report.finished = new Date().toISOString();
      await mkdir(resolve(artifact, ".."), { recursive: true });
      await writeFile(artifact, JSON.stringify(report, null, 2));
    }
  });

  it("completes bounded NIP-01 reads and verifies every returned signature", async () => {
    const result = await sdk().events.query({ kinds: [0], limit: 3 });
    checks.nip01 = {
      completed: result.error === null,
      returned: result.count,
      error: result.error?.code ?? null,
      relays: result.meta?.relays ?? result.error?.details,
    };
    expect(result.error).toBeNull();
    expect(result.meta?.relays).toEqual([
      expect.objectContaining({ url: deployment.relay, ok: true }),
    ]);
    expect(result.meta?.partial).toBe(false);
    expect(
      result.data?.every((event) => event.kind === 0 && verifyEvent(structuredClone(event))),
    ).toBe(true);
  });

  it("tests declared NIP-50 and NIP-77 support and records undeclared extensions explicitly", async () => {
    if (information.supported_nips.includes(50)) {
      const result = await sdk().events.search(process.env.NOSTRBASE_LIVE_SEARCH ?? "nostr", {
        kinds: [1],
        limit: 3,
      });
      expect(result.error).toBeNull();
      expect(result.meta?.relays.every((relay) => relay.ok)).toBe(true);
      checks.nip50 = {
        declared: true,
        completed: true,
        returned: result.count,
        semantics: "No seeded result: completion only.",
      };
    } else {
      expect(information.supported_nips).not.toContain(50);
      checks.nip50 = {
        declared: false,
        exercised: false,
        reason: "Server does not declare NIP-50.",
      };
    }
    if (information.supported_nips.includes(77) || information.negentropy === 1) {
      const result = await sdk().sync.pull({
        kinds: [30078],
        "#t": [scopeTag(deployment.namespace, "live_checks")],
      });
      checks.nip77 = {
        declared: true,
        completed: result.error === null,
        received: result.count,
        results: result.meta?.sync,
      };
      expect(result.error).toBeNull();
      expect(result.meta?.sync).toEqual([
        expect.objectContaining({ ok: true, strategy: "negentropy" }),
      ]);
      expect(result.data?.every((event) => verifyEvent(structuredClone(event)))).toBe(true);
      checks.nip77 = {
        declared: true,
        completed: true,
        received: result.count,
        strategy: result.meta?.sync[0]?.strategy,
      };
    } else {
      expect(information.supported_nips).not.toContain(77);
      const result = await sdk().sync.pull(
        { kinds: [30078], "#t": [scopeTag(deployment.namespace, "live_checks")] },
        { strategy: "query" },
      );
      expect(result.error).toBeNull();
      expect(result.meta?.sync[0]?.strategy).toBe("query");
      checks.nip77 = { declared: false, exercised: false, queryCompleted: true };
    }
  });

  it("checks Blossom read routes, list authorization mapping, and browser preflight headers", async () => {
    const probeHash = process.env.NOSTRBASE_LIVE_BLOB_SHA256 ?? missingHash;
    if (!/^[0-9a-f]{64}$/.test(probeHash))
      throw new Error("NOSTRBASE_LIVE_BLOB_SHA256 must be a lowercase SHA-256 hash.");
    const head = await http(`/${probeHash}`, { method: "HEAD", headers: { Origin: origin } });
    expect([200, 401, 403, 404]).toContain(head.status);
    expect(["*", origin]).toContain(head.headers.get("access-control-allow-origin"));
    report.blossom = {
      server: head.headers.get("server") ?? "undeclared",
      blobHeadStatus: head.status,
      existingBlobConfigured: probeHash !== missingHash,
    };
    const downloaded = await sdk().storage.from(deployment.blossom).download(probeHash);
    if (process.env.NOSTRBASE_LIVE_BLOB_SHA256) expect(downloaded.error).toBeNull();
    else if (head.status === 404) expect(downloaded.error?.code).toBe("NOT_FOUND");
    else if ([401, 403].includes(head.status))
      expect(downloaded.error?.code).toBe("PERMISSION_DENIED");
    else expect(downloaded.error).toBeNull();
    const pubkey = await deployment.signer.getPublicKey();
    const unauthenticated = await http(`/list/${pubkey}`, { headers: { Origin: origin } });
    expect([200, 401, 403, 404, 405]).toContain(unauthenticated.status);
    const listed = await sdk().storage.from(deployment.blossom).list();
    if ([404, 405].includes(unauthenticated.status)) expect(listed.error).not.toBeNull();
    else if (listed.error) expect(listed.error.code).toBe("PERMISSION_DENIED");
    else expect(Array.isArray(listed.data)).toBe(true);
    checks.blossomList = {
      unauthenticatedStatus: unauthenticated.status,
      authenticatedResult: listed.error?.code ?? "completed",
      returned: listed.data?.length,
    };
    for (const [method, path] of [
      ["PUT", "/upload"],
      ["DELETE", `/${probeHash}`],
    ] as const) {
      const preflight = await http(path, {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": method,
          "Access-Control-Request-Headers": "authorization,content-type,x-sha-256",
        },
      });
      expect(preflight.ok).toBe(true);
      expect(["*", origin]).toContain(preflight.headers.get("access-control-allow-origin"));
      expect(
        preflight.headers
          .get("access-control-allow-methods")
          ?.split(",")
          .map((value) => value.trim()),
      ).toContain(method);
      const headers =
        preflight.headers
          .get("access-control-allow-headers")
          ?.toLowerCase()
          .split(",")
          .map((value) => value.trim()) ?? [];
      for (const header of ["authorization", "content-type", "x-sha-256"])
        expect(headers.includes(header) || headers.includes("*")).toBe(true);
    }
    checks.blossomCors = { uploadPreflight: true, deletePreflight: true };
  });

  it("retrieves an opt-in synthetic kind-1 note through a declared NIP-50 search index", async () => {
    if (!deployment.writes || !information.supported_nips.includes(50)) {
      checks.nip50SeededSearch = {
        exercised: false,
        reason: !deployment.writes ? "Read-only mode." : "Server does not declare NIP-50.",
      };
      return;
    }
    const term = `nostrbase${randomUUID().replaceAll("-", "")}`;
    const signed = await sdk().sign({
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["t", scopeTag(deployment.namespace, "live_checks")]],
      content: `Synthetic nostrbase SDK integration check ${term}`,
    });
    checks.searchSeedAttempt = { eventId: signed.id };
    try {
      const note = await sdk().events.publishSigned(signed);
      checks.searchSeed = { error: note.error?.code ?? null, relays: note.meta?.relays };
      expect(note.error).toBeNull();
      let found = false;
      for (let attempt = 0; attempt < 10 && !found; attempt++) {
        const searched = await sdk().events.search(term, {
          kinds: [1],
          authors: [await deployment.signer.getPublicKey()],
          limit: 5,
        });
        expect(searched.error).toBeNull();
        found = searched.data?.some((event) => event.id === signed.id) ?? false;
        if (!found) await delay(500);
      }
      checks.nip50SeededSearch = { exercised: true, found, attemptsBound: 10 };
      expect(found).toBe(true);
    } finally {
      const deleted = await sdk().events.publish({
        kind: 5,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["e", signed.id],
          ["k", "1"],
        ],
        content: "Remove synthetic SDK integration note",
      });
      checks.searchSeedCleanup = {
        error: deleted.error?.code ?? null,
        relays: deleted.meta?.relays,
      };
      expect(deleted.error).toBeNull();
    }
  });

  it("enforces the selected mode and performs a scoped write round trip only with explicit opt-in", async () => {
    if (!deployment.writes) {
      expect(process.env.NOSTRBASE_LIVE_WRITE).not.toBe("1");
      checks.writes = { enabled: false, performed: false };
      return;
    }
    expect(process.env.NOSTRBASE_LIVE_WRITE).toBe("1");
    const id = randomUUID();
    const marker = `nostrbase integration ${id}`;
    checks.writes = {
      enabled: true,
      namespace: deployment.namespace,
      pubkey: await deployment.signer.getPublicKey(),
    };
    checks.recordAttempt = { namespace: deployment.namespace, recordId: id };
    try {
      const created = await sdk().from("live_checks").insert({ id, marker }).select().single();
      checks.recordWrite = {
        error: created.error?.code ?? null,
        relays: created.meta?.receipts?.[0]?.relays,
        eventId: created.meta?.receipts?.[0]?.eventId,
        recordId: id,
      };
      expect(created.error).toBeNull();
      expect(created.meta?.receipts?.[0]?.relays.some((relay) => relay.ok)).toBe(true);
      if (information.supported_nips.includes(77) || information.negentropy === 1) {
        const reader = createClient({
          namespace: deployment.namespace,
          relays: [deployment.relay],
          relayOptions: { ...relayOptions, keepAlive: deployment.local ? 0 : 30_000 },
          timeout: 10000,
          sync: { timeout: 5000 },
        });
        try {
          const reconciled = await reader.sync.pull({
            kinds: [30078],
            authors: [await deployment.signer.getPublicKey()],
            "#t": [scopeTag(deployment.namespace, "live_checks")],
          });
          checks.recordRecovery = {
            completed: reconciled.error === null,
            received: reconciled.count,
            results: reconciled.meta?.sync,
            retrievedWrittenRecord: reconciled.data?.some(
              (event) => event.id === created.meta?.receipts?.[0]?.eventId,
            ),
          };
          expect(reconciled.error).toBeNull();
          expect(reconciled.meta?.sync[0]?.ok).toBe(true);
          expect(
            reconciled.data?.some((event) => event.id === created.meta?.receipts?.[0]?.eventId),
          ).toBe(true);
        } finally {
          await reader.closeAsync();
        }
      }
      expect((await sdk().from("live_checks").eq("id", id).select().single()).data?.marker).toBe(
        marker,
      );
      Object.assign(checks.writes as Record<string, unknown>, { relayAcknowledged: true });
    } finally {
      const deleted = await sdk().from("live_checks").delete().eq("id", id);
      checks.recordCleanup = {
        error: deleted.error?.code ?? null,
        relays: deleted.meta?.receipts?.flatMap((receipt) => receipt.relays),
        eventIds: deleted.meta?.receipts?.map((receipt) => receipt.eventId),
      };
      expect(deleted.error).toBeNull();
    }
    expect((await sdk().from("live_checks").eq("id", id).select()).data).toEqual([]);
    // A relay deletion request is not a guarantee that every remote copy is erased.
  });
  it("performs an opt-in Blossom upload, read, list, and deletion independently of relay write policy", async () => {
    if (!deployment.writes) {
      checks.blossomWrites = { enabled: false, performed: false };
      return;
    }
    const payload = livePayload(
      process.env.NOSTRBASE_LIVE_BLOB_FORMAT ?? "text",
      `Synthetic nostrbase integration ${randomUUID()}`,
    );
    const { bytes, type: mime } = payload;
    const blobHash = createHash("sha256").update(bytes).digest("hex");
    checks.blobAttempt = { sha256: blobHash, mime, bytes: bytes.length };
    try {
      const uploaded = await sdk()
        .storage.from(deployment.blossom)
        .upload(payload.name, new Blob([new Uint8Array(bytes)], { type: mime }));
      checks.blobUpload = {
        error: uploaded.error?.code ?? null,
        message: uploaded.error?.message,
        sha256: blobHash,
        mime,
        bytes: bytes.length,
      };
      expect(uploaded.error).toBeNull();
      expect(uploaded.data?.sha256).toBe(blobHash);
      if (uploaded.data && !deployment.local) {
        let target = new URL(uploaded.data.url);
        const hops: { url: string; status: number }[] = [];
        try {
          for (let hop = 0; hop < 4; hop++) {
            if (
              !["http:", "https:"].includes(target.protocol) ||
              target.username ||
              target.password
            )
              throw new Error("Invalid unauthenticated CDN target.");
            const response = await fetch(target, {
              method: "GET",
              credentials: "omit",
              redirect: "manual",
              signal: AbortSignal.timeout(10000),
            });
            hops.push({ url: target.origin + target.pathname, status: response.status });
            if ([301, 302, 303, 307, 308].includes(response.status)) {
              const location = response.headers.get("location");
              await response.body?.cancel();
              if (!location) throw new Error("Redirect supplied no Location header.");
              target = new URL(location, target);
              continue;
            }
            if (!response.ok) throw new Error(`CDN returned HTTP ${response.status}.`);
            const retrieved = Buffer.from(await response.arrayBuffer());
            const matches =
              retrieved.equals(bytes) &&
              createHash("sha256").update(retrieved).digest("hex") === blobHash;
            checks.descriptorDownload = {
              completed: true,
              hops,
              bytes: retrieved.length,
              exactBytesAndHash: matches,
            };
            expect(matches).toBe(true);
            break;
          }
          if (!checks.descriptorDownload) throw new Error("CDN redirect limit reached.");
        } catch (error) {
          checks.descriptorDownload = {
            completed: false,
            hops,
            message: error instanceof Error ? error.message : "CDN diagnostic failed.",
          };
        }
      }
      const downloaded = await sdk().storage.from(deployment.blossom).download(blobHash);
      expect(downloaded.error).toBeNull();
      expect(downloaded.data && Buffer.from(await downloaded.data.arrayBuffer())).toEqual(bytes);
      expect(
        (await sdk().storage.from(deployment.blossom).list()).data?.some(
          (blob) => blob.sha256 === blobHash,
        ),
      ).toBe(true);
      checks.blossomWrites = { enabled: true, roundTrip: true };
    } finally {
      const removed = await sdk().storage.from(deployment.blossom).remove([blobHash]);
      checks.blobCleanup = {
        error: removed.error?.code ?? null,
        results: removed.data?.map((result) => ({
          ok: result.ok,
          error: result.error?.code ?? null,
          message: result.error?.message,
        })),
      };
      expect(removed.error).toBeNull();
    }
  });
});
