import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { verifyEvent } from "nostr-tools";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createClient, type NostrbaseClient, type NostrEvent } from "../../src";
import { RECORD_KIND } from "../../src/protocol";
import { alice, bob, type TestDB } from "../helpers";
import { relayOptions } from "../support/relay";
import { type RelayService, relayImages, startRelayService } from "./support/relay-service";

const clients = new Set<NostrbaseClient<TestDB>>();
function client(service: RelayService, namespace: string, signer = alice) {
  const sdk = createClient<TestDB>({
    namespace,
    relays: [service.url],
    signer,
    relayOptions,
    timeout: 5000,
    sync: { timeout: 1500 },
  });
  clients.add(sdk);
  return sdk;
}
afterEach(async () => {
  await Promise.all([...clients].map((sdk) => sdk.closeAsync()));
  clients.clear();
});

for (const implementation of ["nostr-rs", "strfry"] as const) {
  describe(`independent ${implementation} ${relayImages[implementation].version}`, () => {
    let service: RelayService;
    beforeAll(async () => {
      service = await startRelayService({ implementation });
    });
    afterAll(async () => {
      if (service) await service.stop();
    });

    it("keeps only the current addressable version and preserves deletion after SIGKILL", async () => {
      const namespace = `relay-${randomUUID()}`;
      const writer = client(service, namespace);
      const created = await writer
        .from("todos")
        .insert({ id: "one", title: "first version", done: false })
        .select()
        .single();
      expect(created.error).toBeNull();
      const original = writer
        .cachedEvents()
        .find((event) => event.id === created.meta?.receipts?.[0]?.eventId);
      expect(original).toBeDefined();
      const updated = await writer
        .from("todos")
        .update({ title: "current", done: true })
        .eq("id", "one");
      expect(updated.error).toBeNull();
      // Replaying an older, still valid signature must not replace newer relay storage.
      const replay = await writer.events.publishSigned(original as NostrEvent);
      if (implementation === "strfry") {
        expect(replay.error?.code).toBe("PUBLISH_FAILED");
        expect(replay.meta?.relays[0]?.message).toMatch(/^replaced:/);
      } else expect(replay.error).toBeNull();
      const fresh = client(service, namespace);
      expect((await fresh.from("todos").single()).data).toMatchObject({
        title: "current",
        done: true,
      });
      const raw = await fresh.events.query({
        kinds: [RECORD_KIND],
        authors: [await alice.getPublicKey()],
        "#d": [original?.tags.find((tag) => tag[0] === "d")?.[1] as string],
      });
      expect(raw.error).toBeNull();
      expect(raw.data).toHaveLength(1);
      expect(raw.data?.[0]?.id).not.toBe(original?.id);
      await writer.closeAsync();
      await fresh.closeAsync();
      await service.restart();
      const afterCrash = client(service, namespace);
      expect((await afterCrash.from("todos").single()).data?.title).toBe("current");
      expect((await afterCrash.from("todos").delete().eq("id", "one")).error).toBeNull();
      await afterCrash.closeAsync();
      await service.restart();
      expect((await client(service, namespace).from("todos")).data).toEqual([]);
    });

    it("delivers signed record changes between independent SDK clients", async () => {
      const namespace = `live-${randomUUID()}`;
      const writer = client(service, namespace);
      const reader = client(service, namespace);
      const changes: string[] = [];
      reader
        .channel("changes")
        .on("nostr_changes", { table: "todos" }, (payload) => {
          expect(verifyEvent(structuredClone(payload.event))).toBe(true);
          changes.push(payload.eventType);
        })
        .subscribe();
      expect(
        (await writer.from("todos").insert({ id: "live", title: "live record", done: false }))
          .error,
      ).toBeNull();
      await expect.poll(() => changes, { timeout: 5000 }).toEqual(["INSERT"]);
      expect((await writer.from("todos").update({ done: true }).eq("id", "live")).error).toBeNull();
      await expect.poll(() => changes, { timeout: 5000 }).toEqual(["INSERT", "UPDATE"]);
      expect((await writer.from("todos").delete().eq("id", "live")).error).toBeNull();
      await expect.poll(() => changes, { timeout: 5000 }).toEqual(["INSERT", "UPDATE", "DELETE"]);
    });

    it("rejects future timestamps with a real relay receipt and stores no event", async () => {
      const sdk = client(service, `reject-${randomUUID()}`);
      const result = await sdk.events.publish({
        kind: 1,
        content: "policy rejected",
        tags: [],
        created_at: Math.floor(Date.now() / 1000) + 86400,
      });
      expect(result.error?.code).toBe("PUBLISH_FAILED");
      expect(result.meta?.receipts?.[0]?.relays).toEqual([
        expect.objectContaining({ url: service.url, ok: false, message: expect.any(String) }),
      ]);
      const id = result.meta?.receipts?.[0]?.eventId;
      expect(id).toBeDefined();
      expect((await sdk.events.query({ ids: [id as string] })).data).toEqual([]);
    });

    it("rejects an invalid signature on the wire and prevents another author from deleting data", async () => {
      const namespace = `ownership-${randomUUID()}`;
      const owner = client(service, namespace);
      const created = await owner
        .from("todos")
        .insert({ id: "owned", title: "owner", done: false })
        .select();
      expect(created.error).toBeNull();
      const signed = owner
        .cachedEvents()
        .find((event) => event.id === created.meta?.receipts?.[0]?.eventId) as NostrEvent;
      // Bypass SDK validation only to prove upstream software validates signatures itself.
      const tampered = structuredClone(signed);
      tampered.sig = "0".repeat(128);
      const socket = new WebSocket(service.url);
      try {
        await once(socket, "open");
        const acknowledgement = new Promise<unknown[]>((resolveAck, reject) => {
          const timer = setTimeout(
            () => reject(new Error("No invalid-signature acknowledgement.")),
            5000,
          );
          socket.on("message", (bytes) => {
            const frame = JSON.parse(bytes.toString()) as unknown[];
            if (frame[0] === "OK" && frame[1] === tampered.id) {
              clearTimeout(timer);
              resolveAck(frame);
            }
          });
        });
        socket.send(JSON.stringify(["EVENT", tampered]));
        expect((await acknowledgement)[2]).toBe(false);
      } finally {
        socket.terminate();
      }
      const outsider = client(service, namespace, bob);
      const deletion = await outsider.events.publish({
        kind: 5,
        content: "",
        tags: [["e", signed.id]],
        created_at: signed.created_at + 1,
      });
      expect(deletion.error).toBeNull();
      expect((await client(service, namespace).from("todos").single()).data?.id).toBe("owned");
    });

    it("reports actual NIP-77 use or explicit query recovery according to upstream capabilities", async () => {
      const information = await service.information();
      expect(information.software).toMatch(
        implementation === "strfry" ? /strfry/ : /nostr-rs-relay/,
      );
      expect(information.version).toBe(relayImages[implementation].version);
      expect(information.supported_nips.includes(77)).toBe(implementation === "strfry");
      const namespace = `sync-${randomUUID()}`;
      const writer = client(service, namespace);
      expect(
        (await writer.from("todos").insert({ id: "recover", title: "sync recovery", done: false }))
          .error,
      ).toBeNull();
      const reader = client(service, namespace);
      const sync = await reader.sync.table("todos");
      expect(sync.error).toBeNull();
      expect(sync.meta?.sync).toHaveLength(1);
      expect(sync.meta?.sync[0]?.ok).toBe(true);
      expect(sync.meta?.sync[0]?.received).toBeGreaterThan(0);
      expect(sync.meta?.sync[0]?.strategy).toBe(
        implementation === "strfry" ? "negentropy" : "query",
      );
      if (implementation === "strfry") expect(sync.meta?.sync[0]?.fallbackReason).toBeUndefined();
      else expect(sync.meta?.sync[0]?.fallbackReason).toEqual(expect.any(String));
      expect((await reader.from("todos").local().single()).data?.title).toBe("sync recovery");
      const repeated = await reader.sync.table("todos");
      expect(repeated.error).toBeNull();
      if (implementation === "strfry") expect(repeated.meta?.sync[0]?.received).toBe(0);
    });

    it("uses an explicit client text filter when NIP-50 is not available", async () => {
      expect((await service.information()).supported_nips).not.toContain(50);
      const namespace = `search-${randomUUID()}`;
      const writer = client(service, namespace);
      expect(
        (
          await writer.from("todos").insert([
            { id: "match", title: "Find the purple orchid", done: false },
            { id: "other", title: "Yellow sunflower", done: false },
          ])
        ).error,
      ).toBeNull();
      // This filter downloads candidates and matches on the client. It is not NIP-50.
      const result = await client(service, namespace)
        .from("todos")
        .textSearch("title", "purple orchid");
      expect(result.error).toBeNull();
      expect(result.data?.map((row) => row.id)).toEqual(["match"]);
    });
  });
}

it("preserves partial write receipts when an independent relay enforces its author allowlist", async () => {
  const allowed = await startRelayService({ allowedPubkeys: [await alice.getPublicKey()] });
  let open: RelayService | undefined;
  try {
    open = await startRelayService({ implementation: "strfry" });
    const sdk = createClient<TestDB>({
      namespace: `allowlist-${randomUUID()}`,
      relays: [open.url, allowed.url],
      signer: bob,
      relayOptions,
      minWriteAcks: 2,
      timeout: 5000,
    });
    clients.add(sdk);
    const result = await sdk.from("todos").insert({ title: "denied author", done: false }).select();
    expect(result.error?.code).toBe("PUBLISH_FAILED");
    expect(result.data).toHaveLength(1);
    expect(result.meta?.partial).toBe(true);
    expect(result.meta?.receipts?.[0]?.relays).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ url: allowed.url, ok: false }),
        expect.objectContaining({ url: open.url, ok: true }),
      ]),
    );
    expect((await client(allowed, sdk.namespace).from("todos")).data).toEqual([]);
    expect((await client(open, sdk.namespace).from("todos")).data).toHaveLength(1);
  } finally {
    await Promise.all([allowed.stop(), open?.stop()]);
  }
});

it("exposes protected-event auth rejection and succeeds after explicit Applesauce NIP-42 authentication", async () => {
  const service = await startRelayService({ implementation: "strfry", requireAuth: true });
  try {
    const namespace = `auth-${randomUUID()}`;
    const sdk = client(service, namespace);
    const relay = sdk.pool.relay(service.url);
    const protectedEvent = await alice.signEvent({
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      content: "protected event",
      tags: [["-"]],
    });
    const denied = await sdk.events.publishSigned(protectedEvent);
    expect(denied.error?.code).toBe("PUBLISH_FAILED");
    expect(denied.data).toBeNull();
    expect(denied.meta?.relays[0]?.message).toMatch(/^auth-required:/);
    await expect.poll(() => relay.challenge, { timeout: 5000 }).toEqual(expect.any(String));
    expect(relay.authenticated).toBe(false);
    const authentication = await relay.authenticate(alice);
    expect(authentication.ok).toBe(true);
    expect(relay.authenticatedAs).toBe(await alice.getPublicKey());
    const created = await sdk.events.publishSigned(protectedEvent);
    expect(created.error).toBeNull();
    expect(
      (await sdk.events.query({ ids: [protectedEvent.id] })).data?.map((event) => event.id),
    ).toEqual([protectedEvent.id]);
    const anonymous = client(service, namespace);
    const another = await alice.signEvent({
      kind: 1,
      tags: [["-"]],
      content: "another protected event",
      created_at: protectedEvent.created_at + 1,
    });
    expect((await anonymous.events.publishSigned(another)).error?.code).toBe("PUBLISH_FAILED");
  } finally {
    await service.stop();
  }
});
