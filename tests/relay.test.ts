import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { matchFilter, verifyEvent } from "nostr-tools";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { Filter, NostrbaseClient, NostrEvent, RelayPool } from "../src";
import { createClient } from "../src";
import { addressOf, compareEvents } from "../src/protocol";
import type { TestDB } from "./helpers";
import { alice } from "./helpers";

/** Small NIP-01/09 relay for transport contract tests. No internet or production keys. */
class TestRelay {
  server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  events = new Map<string, NostrEvent>();
  subscriptions = new Map<WebSocket, Map<string, Filter[]>>();
  rejectWrites = false;
  sendEose = true;
  url = "";
  async start(): Promise<this> {
    await once(this.server, "listening");
    this.url = `ws://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    this.server.on("connection", (socket) => {
      this.subscriptions.set(socket, new Map());
      socket.on("close", () => this.subscriptions.delete(socket));
      socket.on("message", (data) => {
        const [verb, payload, ...rest] = JSON.parse(data.toString());
        if (verb === "REQ") {
          const id = payload as string;
          const filters = rest as Filter[];
          this.subscriptions.get(socket)?.set(id, filters);
          const matched = new Map<string, NostrEvent>();
          for (const filter of filters) {
            const events = [...this.events.values()]
              .filter((event) => matchFilter(filter, event))
              .sort((a, b) => b.created_at - a.created_at)
              .slice(0, filter.limit ?? Number.POSITIVE_INFINITY);
            for (const event of events) matched.set(event.id, event);
          }
          for (const event of matched.values()) socket.send(JSON.stringify(["EVENT", id, event]));
          if (this.sendEose) socket.send(JSON.stringify(["EOSE", id]));
        } else if (verb === "CLOSE") this.subscriptions.get(socket)?.delete(payload as string);
        else if (verb === "EVENT") {
          const event = payload as NostrEvent;
          if (this.rejectWrites || !verifyEvent({ ...event })) {
            socket.send(
              JSON.stringify(["OK", event.id, false, "blocked: test relay rejected event"]),
            );
            return;
          }
          if (event.kind >= 30000 && event.kind < 40000) {
            const old = [...this.events.values()].find(
              (candidate) => addressOf(candidate) === addressOf(event),
            );
            if (old && compareEvents(event, old) <= 0) {
              socket.send(JSON.stringify(["OK", event.id, true, "duplicate:"]));
              return;
            }
            if (old) this.events.delete(old.id);
          }
          if (event.kind === 5) {
            for (const candidate of this.events.values()) {
              if (
                candidate.pubkey === event.pubkey &&
                candidate.created_at <= event.created_at &&
                event.tags.some(
                  (tag) =>
                    (tag[0] === "e" && tag[1] === candidate.id) ||
                    (tag[0] === "a" && tag[1] === addressOf(candidate)),
                )
              )
                this.events.delete(candidate.id);
            }
          }
          this.events.set(event.id, event);
          socket.send(JSON.stringify(["OK", event.id, true, ""]));
          for (const [client, subscriptions] of this.subscriptions)
            for (const [id, filters] of subscriptions)
              if (filters.some((filter) => matchFilter(filter, event)))
                client.send(JSON.stringify(["EVENT", id, event]));
        }
      });
    });
    return this;
  }
  async close(): Promise<void> {
    for (const socket of this.server.clients) socket.terminate();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
const relays: TestRelay[] = [];
const clients: NostrbaseClient<TestDB>[] = [];
async function relay() {
  const result = await new TestRelay().start();
  relays.push(result);
  return result;
}
function client(urls: string[], minWriteAcks = 1, timeout = 1000) {
  const result = createClient<TestDB>({
    namespace: "relay-app",
    relays: urls,
    signer: alice,
    minWriteAcks,
    timeout,
    relayOptions: {
      WebSocket: WebSocket as unknown as NonNullable<
        ConstructorParameters<typeof RelayPool>[0]
      >["WebSocket"],
      keepAlive: 0,
    },
  });
  clients.push(result);
  return result;
}
afterEach(async () => {
  for (const item of clients.splice(0)) item.close();
  await Promise.all(relays.splice(0).map((item) => item.close()));
});

describe("Applesauce WebSocket transport", () => {
  it("persists CRUD across independent clients over Nostr messages", async () => {
    const node = await relay();
    const writer = client([node.url]);
    const inserted = await writer
      .from("todos")
      .insert({ id: "one", title: "Real relay", done: false })
      .select()
      .single();
    expect(inserted.error).toBeNull();
    const reader = client([node.url]);
    expect((await reader.from("todos").single()).data?.title).toBe("Real relay");
    expect((await writer.from("todos").update({ done: true }).eq("id", "one")).error).toBeNull();
    expect((await reader.from("todos").single()).data?.done).toBe(true);
    expect((await writer.from("todos").delete().eq("id", "one")).error).toBeNull();
    expect((await reader.from("todos")).data).toEqual([]);
    expect((await client([node.url]).from("todos")).data).toEqual([]);
  });
  it("streams signed records between two clients and releases subscriptions", async () => {
    const node = await relay();
    const writer = client([node.url]);
    const reader = client([node.url]);
    const seen: string[] = [];
    const channel = reader
      .channel("live")
      .on("nostr_changes", { table: "todos" }, (payload) => seen.push(payload.eventType))
      .subscribe();
    await expect
      .poll(() => [...node.subscriptions.values()].some((subscriptions) => subscriptions.size > 0))
      .toBe(true);
    await writer.from("todos").insert({ id: "one", title: "live", done: false });
    await expect.poll(() => seen).toEqual(["INSERT"]);
    await writer.from("todos").update({ done: true }).eq("id", "one");
    await expect.poll(() => seen).toEqual(["INSERT", "UPDATE"]);
    await writer.from("todos").delete().eq("id", "one");
    await expect.poll(() => seen).toEqual(["INSERT", "UPDATE", "DELETE"]);
    await reader.removeChannel(channel);
    await expect
      .poll(() =>
        [...node.subscriptions.values()].every((subscriptions) => subscriptions.size === 0),
      )
      .toBe(true);
  });
  it("exposes relay rejection and minimum acknowledgement failures", async () => {
    const good = await relay();
    const blocked = await relay();
    blocked.rejectWrites = true;
    const defaultClient = client([good.url, blocked.url]);
    const result = await defaultClient
      .from("todos")
      .insert({ title: "one ack", done: false })
      .select();
    expect(result.error).toBeNull();
    expect(result.meta?.partial).toBe(true);
    expect(result.meta?.receipts?.[0]?.relays.map((status) => status.ok).sort()).toEqual([
      false,
      true,
    ]);
    const strictClient = client([good.url, blocked.url], 2);
    const strict = await strictClient
      .from("todos")
      .insert({ title: "two acks needed", done: false })
      .select();
    expect(strict.error?.code).toBe("PUBLISH_FAILED");
    expect(strict.data).toHaveLength(1);
  });
  it("times out a relay that never sends EOSE even if events keep arriving", async () => {
    const node = await relay();
    node.sendEose = false;
    const result = await client([node.url], 1, 80).from("todos");
    expect(result.error?.code).toBe("RELAY_ERROR");
  });
  it("cancels a live WebSocket read", async () => {
    const node = await relay();
    node.sendEose = false;
    const sdk = client([node.url]);
    const controller = new AbortController();
    const pending = Promise.resolve(sdk.from("todos").abortSignal(controller.signal));
    await expect
      .poll(() => [...node.subscriptions.values()].some((subscriptions) => subscriptions.size > 0))
      .toBe(true);
    controller.abort();
    expect((await pending).error?.code).toBe("ABORTED");
  });
});
