import { verifyEvent } from "nostr-tools";
import type {} from "../browser/support/entry";
import { developmentPubkey, expect, promptFor, signIn, test } from "./fixtures";

// Risk: denial in a real extension must not create an authenticated SDK session.
test("denied extension sign-in returns AUTH_FAILED and leaves the client signed out", async ({
  signer,
  harness,
}) => {
  const result = await promptFor(
    signer,
    () =>
      signer.page.evaluate(async () => {
        const client = window.clients.get("extension");
        if (!client) throw new Error("Missing client.");
        const result = await client.auth.signInWithExtension();
        return { error: result.error?.code, user: (await client.auth.getUser()).data };
      }),
    "getPublicKey",
    "deny",
  );
  expect(result.error).toBe("AUTH_FAILED");
  expect(result.user).toBeNull();
  expect(harness.relay.events.size).toBe(0);
});

// Risk: SDK signing must use the extension's actual key, then verify and publish its result.
test("approved extension sign-in and record signing publish a valid owned event", async ({
  signer,
  harness,
}) => {
  expect(await signIn(signer)).toEqual({ error: null, pubkey: developmentPubkey });
  const result = await promptFor(
    signer,
    () =>
      signer.page.evaluate(async () => {
        const client = window.clients.get("extension");
        if (!client) throw new Error("Missing client.");
        const result = await client
          .from("todos")
          .insert({ id: "approved", title: "Extension signed task" })
          .select();
        return {
          error: result.error?.code ?? null,
          title: result.data?.[0]?.title,
          author: result.data?.[0]?._nostr.pubkey,
        };
      }),
    "signEvent",
  );
  expect(result).toEqual({
    error: null,
    title: "Extension signed task",
    author: developmentPubkey,
  });
  const events = [...harness.relay.events.values()];
  expect(events).toHaveLength(1);
  const signed = events[0];
  expect(signed?.kind).toBe(30078);
  expect(signed?.pubkey).toBe(developmentPubkey);
  expect(signed && verifyEvent(structuredClone(signed))).toBe(true);
});

// Risk: rejected signing must never deliver an unsigned record or change optimistic state.
test("rejected record signing does not publish or create a cached row", async ({
  signer,
  harness,
}) => {
  expect((await signIn(signer)).error).toBeNull();
  const result = await promptFor(
    signer,
    () =>
      signer.page.evaluate(async () => {
        const client = window.clients.get("extension");
        if (!client) throw new Error("Missing client.");
        const write = await client
          .from("todos")
          .insert({ id: "denied", title: "Must stay absent" })
          .select();
        return {
          error: write.error?.code,
          data: write.data,
          local: (await client.from("todos").local()).data,
        };
      }),
    "signEvent",
    "deny",
  );
  expect(result.error).toBe("AUTH_FAILED");
  expect(result.data).toEqual([]);
  expect(result.local).toEqual([]);
  expect(harness.relay.frames.filter((frame) => frame[0] === "EVENT")).toEqual([]);
});

// Risk: dismissing a permission window must reject the current operation and permit a later retry.
test("closing the signer permission window rejects the operation and a later retry succeeds", async ({
  signer,
  harness,
}) => {
  expect((await signIn(signer)).error).toBeNull();
  const publish = () =>
    signer.page.evaluate(async () => {
      const client = window.clients.get("extension");
      if (!client) throw new Error("Missing client.");
      const result = await client.events.publish({
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        content: "Extension retry",
        tags: [],
      });
      return { error: result.error?.code ?? null, event: result.data };
    });
  const dismissed = await promptFor(signer, publish, "signEvent", "close");
  expect(dismissed.error).toBe("AUTH_FAILED");
  expect(dismissed.event).toBeNull();
  expect(harness.relay.events.size).toBe(0);
  const retry = await promptFor(signer, publish, "signEvent");
  expect(retry.error).toBeNull();
  expect(retry.event?.pubkey).toBe(developmentPubkey);
  expect(retry.event && verifyEvent(structuredClone(retry.event))).toBe(true);
  expect(harness.relay.events.size).toBe(1);
});

// Risk: private tables must use the extension's real NIP-44 implementation and permission UI.
test("private create/read encrypts and decrypts through the real extension without publishing plaintext", async ({
  signer,
  harness,
}) => {
  expect((await signIn(signer)).error).toBeNull();
  const write = await promptFor(
    signer,
    () =>
      signer.page.evaluate(async () => {
        const client = window.clients.get("extension");
        if (!client) throw new Error("Missing client.");
        const result = await client.private
          .from("todos")
          .insert({ id: "secret", title: "Extension private task" })
          .select();
        return { error: result.error?.code ?? null, title: result.data?.[0]?.title };
      }),
    ["nip44.encrypt", "signEvent"],
  );
  expect(write).toEqual({ error: null, title: "Extension private task" });
  const signed = [...harness.relay.events.values()][0];
  expect(signed).toBeDefined();
  expect(signed?.content).not.toContain("Extension private task");
  expect(signed?.tags).toContainEqual(["encryption", "nip44-self"]);
  expect(signed && verifyEvent(structuredClone(signed))).toBe(true);
  const read = await promptFor(
    signer,
    () =>
      signer.page.evaluate(async () => {
        const client = window.clients.get("extension");
        if (!client) throw new Error("Missing client.");
        const result = await client.private.from("todos").select();
        return { error: result.error?.code ?? null, title: result.data?.[0]?.title };
      }),
    "nip44.decrypt",
  );
  expect(read).toEqual({ error: null, title: "Extension private task" });
});
