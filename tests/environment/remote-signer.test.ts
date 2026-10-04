import { randomUUID } from "node:crypto";
import { RelayPool } from "applesauce-relay";
import { NostrConnectSigner } from "applesauce-signers";
import { verifyEvent } from "nostr-tools";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createClient, type NostrbaseClient, type NostrEvent } from "../../src";
import type { TestDB } from "../helpers";
import { relayOptions } from "../support/relay";
import { type RelayService, startRelayService } from "./support/relay-service";
import { startRemoteSigner } from "./support/remote-signer";

describe("real NIP-46 signer process over independent relay software", () => {
  let relay: RelayService;
  let provider: Awaited<ReturnType<typeof startRemoteSigner>> | undefined;
  let signer: NostrConnectSigner | undefined;
  const pools: RelayPool[] = [];
  const clients: NostrbaseClient<TestDB>[] = [];
  beforeAll(async () => {
    relay = await startRelayService();
  });
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.closeAsync()));
    await signer?.close();
    signer = undefined;
    for (const pool of pools.splice(0)) pool.close();
    await provider?.close();
    provider = undefined;
  });
  afterAll(async () => {
    if (relay) await relay.stop();
  });
  async function service() {
    provider = await startRemoteSigner(relay.url);
    expect(provider.pid).not.toBe(process.pid);
    expect(provider.version).toBe("6.2.3");
    const pool = new RelayPool(relayOptions);
    pools.push(pool);
    const uri = NostrConnectSigner.parseBunkerURI(provider.uri);
    signer = new NostrConnectSigner({ ...uri, pool });
    return { provider, pool, signer };
  }
  function sdk(remote: NostrConnectSigner, namespace = `signer-${randomUUID()}`) {
    const client = createClient<TestDB>({
      namespace,
      relays: [relay.url],
      signer: remote,
      relayOptions,
      timeout: 5000,
    });
    clients.push(client);
    return client;
  }

  it("requires connection approval and preserves denial of signing or NIP-44 permissions", async () => {
    const { provider, signer } = await service();
    await provider.policy({ connect: "deny" });
    await expect(signer.connect()).rejects.toThrow(/denied|rejected/i);
    expect(signer.isConnected).toBe(false);
    await provider.policy({ connect: "allow" });
    await signer.connect();
    const client = sdk(signer);
    expect((await client.auth.getUser()).data?.pubkey).toBe(provider.pubkey);
    await provider.policy({ sign: "deny" });
    const rejected = await client
      .from("todos")
      .insert({ id: "denied", title: "denied", done: false })
      .select();
    expect(rejected.error?.code).toBe("AUTH_FAILED");
    expect(rejected.count).toBe(0);
    expect(rejected.meta?.receipts).toEqual([]);
    expect((await client.from("todos").select()).data).toEqual([]);
    await provider.policy({ sign: "allow", encrypt: "deny" });
    const encrypted = await client.private
      .from("todos")
      .insert({ id: "private-denied", title: "private-denied", done: false });
    expect(encrypted.error).not.toBeNull();
    expect(client.cachedEvents().filter((event) => event.kind === 30078)).toEqual([]);
  });

  it("signs public records and performs private CRUD without plaintext in relay events", async () => {
    const { provider, signer, pool } = await service();
    const wire: NostrEvent[] = [];
    const wireSubscription = pool
      .subscription([relay.url], { kinds: [24133], "#p": [signer.clientPubkey] })
      .subscribe((event) => wire.push(event));
    await signer.connect(undefined, [
      "sign_event:30078",
      "sign_event:5",
      "nip44_encrypt",
      "nip44_decrypt",
    ]);
    const client = sdk(signer);
    const created = await client
      .from("todos")
      .insert({ id: "public", title: "visible", done: false })
      .select()
      .single();
    expect(created.error).toBeNull();
    const record = client
      .cachedEvents()
      .find((event) => event.id === created.meta?.receipts?.[0]?.eventId);
    expect(record?.pubkey).toBe(provider.pubkey);
    expect(record && verifyEvent(record)).toBe(true);
    const secret = `never-public-${randomUUID()}`;
    const privateCreated = await client.private
      .from("todos")
      .insert({ id: "secret", title: secret, done: false })
      .select()
      .single();
    expect(privateCreated.error).toBeNull();
    const privateEvent = client
      .cachedEvents()
      .find((event) => event.id === privateCreated.meta?.receipts?.[0]?.eventId);
    expect(privateEvent && verifyEvent(privateEvent)).toBe(true);
    expect(privateEvent?.content).not.toContain(secret);
    // A fresh SDK instance must decrypt bytes read from the relay through remote NIP-44.
    const reader = sdk(signer, client.namespace);
    expect((await reader.private.from("todos").select().single()).data?.title).toBe(secret);
    const updated = await reader.private
      .from("todos")
      .update({ done: true })
      .eq("id", "secret")
      .select()
      .single();
    expect(updated.error).toBeNull();
    expect(updated.data?.done).toBe(true);
    expect(wire.length).toBeGreaterThan(3);
    expect(wire.every(verifyEvent)).toBe(true);
    expect(JSON.stringify(wire)).not.toContain(secret);
    expect(JSON.stringify(wire)).not.toContain('"result"');
    wireSubscription.unsubscribe();
    await provider.policy({ decrypt: "deny" });
    const deniedReader = sdk(signer, client.namespace);
    if (!privateEvent) throw new Error("Expected the private signed event.");
    await expect(signer.nip44Decrypt(provider.pubkey, privateEvent.content)).rejects.toThrow(
      /denied|rejected/i,
    );
    const unreadable = await deniedReader.private.from("todos").select();
    // Private reads omit unreadable ciphertext, including an explicit permission denial.
    expect(unreadable.error).toBeNull();
    expect(unreadable.data).toEqual([]);
    await provider.policy({ decrypt: "allow" });
    const deleted = await reader.private.from("todos").delete().eq("id", "secret");
    expect(deleted.error).toBeNull();
    expect(deleted.count).toBe(1);
    const fresh = sdk(signer, client.namespace);
    expect((await fresh.private.from("todos").select()).data).toEqual([]);
    expect((await fresh.from("todos").select().single()).data?.title).toBe("visible");
  });

  it("rejects a real delayed signer response after signout before publishing it", async () => {
    const { provider, signer } = await service();
    await signer.connect();
    const client = sdk(signer);
    await client.auth.getSession();
    await provider.policy({ sign: "hold" });
    const pending = Promise.resolve(
      client.from("todos").insert({ id: "late", title: "late", done: false }).select(),
    );
    const approval = await provider.nextApproval("sign");
    await client.auth.signOut();
    await provider.release(approval.id, true);
    const result = await pending;
    expect(result.error?.code).toBe("AUTH_FAILED");
    expect(result.meta?.receipts).toEqual([]);
    expect(client.cachedEvents().filter((event) => event.kind === 30078)).toEqual([]);
    expect((await client.from("todos").select()).data).toEqual([]);
  });

  it("reconnects the same signer after the provider and transport subscriptions stop", async () => {
    const { provider, signer } = await service();
    await signer.connect();
    expect(await signer.ping()).toBe("pong");
    await signer.close();
    expect(signer.listening).toBe(false);
    expect(signer.isConnected).toBe(false);
    expect((await provider.stop()).listening).toBe(false);
    expect((await provider.start()).listening).toBe(true);
    await signer.connect();
    expect(await signer.getPublicKey()).toBe(provider.pubkey);
    expect(await signer.ping()).toBe("pong");
    const client = sdk(signer);
    const result = await client
      .from("todos")
      .insert({ id: "reconnected", title: "reconnected", done: false })
      .select()
      .single();
    expect(result.error).toBeNull();
    expect(result.data?._nostr.pubkey).toBe(provider.pubkey);
  });
});
