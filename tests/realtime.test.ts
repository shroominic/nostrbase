import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { matchFilters, verifyEvent } from "nostr-tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { Filter, NostrbaseClient, NostrEvent, RelayPool } from "../src";
import { createClient } from "../src";
import type { BroadcastPayload, PresencePayload } from "../src/channel";
import { NostrbaseChannel, REALTIME_KIND } from "../src/channel";
import type { TestDB } from "./helpers";
import { alice, bob, MemoryTransport, setup } from "./helpers";

const clients: NostrbaseClient<TestDB>[] = [];
const channels: NostrbaseChannel<TestDB>[] = [];
function fixture(options: Parameters<typeof setup>[0] = {}) {
  const result = setup(options);
  clients.push(result.client);
  return result;
}
function channel(client: NostrbaseClient<TestDB>, name = "room", options = {}) {
  const result = new NostrbaseChannel(client, name, options);
  channels.push(result);
  return result;
}
afterEach(() => {
  for (const item of channels.splice(0)) item.unsubscribe();
  for (const item of clients.splice(0)) item.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("signed ephemeral broadcast", () => {
  it("streams broadcast and presence through Applesauce against an ephemeral WebSocket relay", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const subscriptions = new Map<WebSocket, Map<string, Filter[]>>();
    await once(server, "listening");
    server.on("connection", (socket) => {
      const filters = new Map<string, Filter[]>();
      subscriptions.set(socket, filters);
      socket.on("close", () => subscriptions.delete(socket));
      socket.on("message", (raw) => {
        const [verb, payload, ...rest] = JSON.parse(raw.toString());
        if (verb === "REQ") {
          filters.set(payload as string, rest as Filter[]);
          socket.send(JSON.stringify(["EOSE", payload]));
        } else if (verb === "CLOSE") filters.delete(payload as string);
        else if (verb === "EVENT") {
          const event = payload as NostrEvent;
          const valid = event.kind === REALTIME_KIND && verifyEvent({ ...event });
          socket.send(JSON.stringify(["OK", event.id, valid, ""]));
          if (valid)
            for (const [connection, active] of subscriptions)
              for (const [id, query] of active)
                if (matchFilters(query, event))
                  connection.send(JSON.stringify(["EVENT", id, event]));
        }
      });
    });
    const relay = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const options = {
      namespace: "socket-app",
      relays: [relay],
      timeout: 1000,
      relayOptions: {
        WebSocket: WebSocket as unknown as NonNullable<
          ConstructorParameters<typeof RelayPool>[0]
        >["WebSocket"],
        keepAlive: 0,
      },
    };
    const writer = createClient<TestDB>({ ...options, signer: alice });
    const reader = createClient<TestDB>(options);
    clients.push(writer, reader);
    const received = vi.fn();
    const observer = channel(reader)
      .on("broadcast", { event: "cursor" }, received)
      .on("presence", { event: "sync" }, () => {})
      .subscribe();
    const sender = channel(writer).subscribe();
    try {
      await expect
        .poll(() => [...subscriptions.values()].filter((active) => active.size > 0).length)
        .toBe(2);
      expect(
        (await sender.send({ type: "broadcast", event: "cursor", payload: { x: 1 } })).error,
      ).toBeNull();
      await expect.poll(() => received.mock.calls.length).toBe(1);
      expect((await sender.track({ online: true })).error).toBeNull();
      const author = await alice.getPublicKey();
      await expect.poll(() => observer.presenceState()[author]?.length).toBe(1);
      await sender.untrack();
      await expect.poll(() => observer.presenceState()[author]).toBeUndefined();
      sender.unsubscribe();
      observer.unsubscribe();
      await expect
        .poll(() => [...subscriptions.values()].every((active) => active.size === 0))
        .toBe(true);
      expect(reader.eventStore.getByFilters({ kinds: [REALTIME_KIND] })).toEqual([]);
    } finally {
      writer.close();
      reader.close();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("delivers signed scoped broadcasts once, excludes self, and does not cache them", async () => {
    const transport = new MemoryTransport();
    const sender = fixture({ transport }).client;
    const receiver = fixture({ transport, signer: undefined }).client;
    const local = vi.fn();
    const received: BroadcastPayload[] = [];
    const room = channel(sender).on("broadcast", { event: "cursor" }, local).subscribe();
    channel(receiver)
      .on("broadcast", { event: "cursor" }, (event) => received.push(event))
      .subscribe();
    const unrelated = vi.fn();
    channel(receiver, "other").on("broadcast", { event: "*" }, unrelated).subscribe();
    const result = await room.send({ type: "broadcast", event: "cursor", payload: { x: 4 } });
    expect(result.error).toBeNull();
    expect(result.meta?.receipts?.[0]?.eventId).toBe(result.data?.eventId);
    expect(local).not.toHaveBeenCalled();
    expect(unrelated).not.toHaveBeenCalled();
    expect(received).toHaveLength(1);
    expect(received[0]?.pubkey).toBe(await alice.getPublicKey());
    expect(received[0]?.payload).toEqual({ x: 4 });
    const event = transport.published[0];
    expect(event?.kind).toBe(REALTIME_KIND);
    expect(event?.tags.some((tag) => tag[0] === "expiration")).toBe(true);
    if (event) transport.live.next(event);
    expect(received).toHaveLength(1);
    expect(sender.eventStore.getByFilters({ kinds: [REALTIME_KIND] })).toEqual([]);
    expect(receiver.eventStore.getByFilters({ kinds: [REALTIME_KIND] })).toEqual([]);
  });

  it("supports self delivery without a relay echo, isolates callbacks, and reports ack failures", async () => {
    const { client, transport } = fixture();
    vi.spyOn(transport, "publish").mockImplementation(async (_relays, event) => {
      transport.published.push(event);
      return [{ url: "wss://relay.test/", ok: true }];
    });
    const statuses = vi.fn();
    const received = vi.fn();
    const room = channel(client, "room", { broadcast: { self: true } })
      .on("broadcast", { event: "*" }, () => {
        throw new Error("observer");
      })
      .on("broadcast", { event: "*" }, received)
      .subscribe(statuses);
    expect((await room.send({ type: "broadcast", event: "ping", payload: null })).error).toBeNull();
    expect(received).toHaveBeenCalledTimes(1);
    expect(statuses).toHaveBeenCalledWith("CHANNEL_ERROR", expect.any(Error));
    vi.mocked(transport.publish).mockResolvedValue([{ url: "wss://relay.test/", ok: false }]);
    expect((await room.send({ type: "broadcast", event: "ping", payload: null })).error?.code).toBe(
      "PUBLISH_FAILED",
    );
    expect(received).toHaveBeenCalledTimes(1);
  });

  it("rejects unsigned, expired, cross-namespace traffic and invalid JSON writes", async () => {
    vi.useFakeTimers();
    const { client, transport } = fixture();
    const received = vi.fn();
    const room = channel(client, "room", { broadcast: { self: true } })
      .on("broadcast", { event: "*" }, received)
      .subscribe();
    await room.send({ type: "broadcast", event: "ok", payload: 1 });
    const valid = transport.published[0];
    if (!valid) throw new Error("Missing event");
    transport.live.next({ ...valid, content: "tampered" });
    const expired = await alice.signEvent({
      kind: REALTIME_KIND,
      created_at: valid.created_at - 60,
      tags: [
        ["t", "nostrbase:channel:test-app:room"],
        ["expiration", String(valid.created_at - 1)],
      ],
      content: valid.content,
    });
    transport.live.next(expired);
    const wrongNamespace = await alice.signEvent({
      kind: REALTIME_KIND,
      created_at: valid.created_at,
      tags: valid.tags,
      content: JSON.stringify({
        ...JSON.parse(valid.content),
        namespace: "other",
        sessionId: "other",
      }),
    });
    transport.live.next(wrongNamespace);
    expect(received).toHaveBeenCalledTimes(1);
    expect(
      (await room.send({ type: "broadcast", event: "bad", payload: { value: undefined } })).error
        ?.code,
    ).toBe("INVALID_RECORD");
    const anonymous = channel(fixture({ signer: undefined }).client)
      .on("broadcast", { event: "*" }, () => {})
      .subscribe();
    expect(
      (await anonymous.send({ type: "broadcast", event: "x", payload: null })).error?.code,
    ).toBe("AUTH_REQUIRED");
  });
});

describe("presence", () => {
  it("groups separate sessions by verified author, updates state, and resists stale heartbeats after leave", async () => {
    vi.useFakeTimers();
    const transport = new MemoryTransport();
    const client = fixture({ transport }).client;
    const first = channel(client)
      .on("presence", { event: "sync" }, () => {})
      .subscribe();
    const second = channel(client)
      .on("presence", { event: "sync" }, () => {})
      .subscribe();
    const changes: PresencePayload[] = [];
    const observer = channel(fixture({ transport, signer: undefined }).client)
      .on("presence", { event: "join" }, (event) => changes.push(event))
      .on("presence", { event: "leave" }, (event) => changes.push(event))
      .subscribe();
    expect((await first.track({ name: "first" })).error).toBeNull();
    expect((await second.track({ name: "second" })).error).toBeNull();
    const author = await alice.getPublicKey();
    expect(observer.presenceState()[author]).toHaveLength(2);
    const heartbeat = transport.published[0];
    await first.track({ name: "updated" });
    expect(changes.filter((change) => change.event === "join")).toHaveLength(2);
    expect(observer.presenceState()[author]?.some((entry) => entry.state.name === "updated")).toBe(
      true,
    );
    await first.untrack();
    if (heartbeat) {
      transport.live.next(heartbeat);
      const delayed = await alice.signEvent({
        kind: heartbeat.kind,
        created_at: heartbeat.created_at,
        tags: heartbeat.tags,
        content: JSON.stringify({ ...JSON.parse(heartbeat.content), state: { name: "stale" } }),
      });
      transport.live.next(delayed);
    }
    expect(observer.presenceState()[author]).toHaveLength(1);
    expect(changes.filter((change) => change.event === "leave")).toHaveLength(1);
    const state = observer.presenceState();
    if (state[author]?.[0]) state[author][0].state.name = "changed";
    expect(observer.presenceState()[author]?.[0]?.state.name).toBe("second");
  });

  it("refreshes heartbeats, expires disconnected sessions, and stops on signer changes", async () => {
    vi.useFakeTimers();
    const transport = new MemoryTransport();
    const client = fixture({ transport }).client;
    const author = await alice.getPublicKey();
    const room = channel(client, "room", { presence: { ttl: 4, heartbeatInterval: 1 } })
      .on("presence", { event: "sync" }, () => {})
      .subscribe();
    const leave = vi.fn();
    const observer = channel(fixture({ transport, signer: undefined }).client)
      .on("presence", { event: "leave" }, leave)
      .subscribe();
    await room.track({ online: true });
    await vi.advanceTimersByTimeAsync(5000);
    expect(transport.published.length).toBeGreaterThan(1);
    expect(observer.presenceState()[author]).toHaveLength(1);
    await client.auth.signInWithSigner(bob);
    const count = transport.published.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(transport.published).toHaveLength(count);
    expect(observer.presenceState()[author]).toBeUndefined();
    expect(leave).toHaveBeenCalledTimes(1);
    expect(room.presenceState()[author]).toBeUndefined();
  });

  it("cleans transport and timers on client close and rejects in-flight writes after unsubscribe", async () => {
    vi.useFakeTimers();
    const { client, transport } = fixture();
    const room = client
      .channel("managed")
      .on("presence", { event: "sync" }, () => {})
      .subscribe();
    await room.track({ online: true });
    expect(transport.activeSubscriptions).toBe(1);
    client.close();
    expect(transport.activeSubscriptions).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    const other = fixture();
    let resolve: (() => void) | undefined;
    vi.spyOn(other.transport, "publish").mockImplementation(async () => {
      await new Promise<void>((done) => {
        resolve = done;
      });
      return [{ url: "wss://relay.test/", ok: true }];
    });
    const pending = channel(other.client)
      .on("presence", { event: "sync" }, () => {})
      .subscribe();
    const result = pending.track({ online: true });
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    pending.unsubscribe();
    resolve?.();
    expect((await result).error?.code).toBe("ABORTED");
    expect(pending.presenceState()).toEqual({});
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps table changes working on mixed channels", async () => {
    const { client } = fixture();
    const changes = vi.fn();
    const room = channel(client)
      .on("nostr_changes", { table: "todos" }, changes)
      .on("broadcast", { event: "*" }, () => {})
      .on("presence", { event: "sync" }, () => {})
      .subscribe();
    await client.from("todos").insert({ id: "one", title: "task", done: false });
    await room.track({ online: true });
    expect(changes).toHaveBeenCalledTimes(1);
    expect(changes.mock.calls[0]?.[0].eventType).toBe("INSERT");
  });

  it("emits local queued INSERT, UPDATE, and DELETE without relay delivery", async () => {
    const { client, transport } = fixture();
    const changes = vi.fn();
    channel(client).on("nostr_changes", { table: "todos" }, changes).subscribe();
    expect(
      (await client.from("todos").insert({ id: "queued", title: "task", done: false }).queue())
        .error,
    ).toBeNull();
    expect(
      (await client.from("todos").update({ done: true }).eq("id", "queued").queue()).error,
    ).toBeNull();
    expect((await client.from("todos").delete().eq("id", "queued").queue()).error).toBeNull();
    expect(transport.published).toEqual([]);
    expect(changes.mock.calls.map(([change]) => change.eventType)).toEqual([
      "INSERT",
      "UPDATE",
      "DELETE",
    ]);
    expect((await client.from("todos").local()).data).toEqual([]);
    expect((await client.offline.flush()).error).toBeNull();
    expect(changes).toHaveBeenCalledTimes(3);
  });

  it("does not restore tracking after the signer changes during a publish", async () => {
    vi.useFakeTimers();
    const { client, transport } = fixture();
    let resolve: (() => void) | undefined;
    vi.spyOn(transport, "publish").mockImplementation(async (_relays, event) => {
      transport.published.push(event);
      await new Promise<void>((done) => {
        resolve = done;
      });
      transport.live.next(event);
      return [{ url: "wss://relay.test/", ok: true }];
    });
    const room = channel(client).subscribe();
    const pending = room.track({ online: true });
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    await client.auth.signOut();
    resolve?.();
    expect((await pending).error?.code).toBe("AUTH_FAILED");
    expect(room.presenceState()).toEqual({});
    await vi.advanceTimersByTimeAsync(31000);
    expect(transport.published).toHaveLength(1);
  });

  it("allows send-only channels and validates channel timing", async () => {
    const { client, transport } = fixture();
    const room = channel(client).subscribe();
    expect((await room.send({ type: "broadcast", event: "ping", payload: null })).error).toBeNull();
    expect(transport.activeSubscriptions).toBe(1);
    expect(() => channel(client, "")).toThrow(/Channel name/);
    expect(() => channel(client, "room", { presence: { ttl: 1 } })).toThrow(/TTL/);
    expect(() => channel(client, "room", { presence: { ttl: 10, heartbeatInterval: 6 } })).toThrow(
      /TTL/,
    );
    room.unsubscribe();
    expect((await room.track({ online: true })).error?.code).toBe("INVALID_QUERY");
  });

  it("does not publish an ephemeral event that expires during a signer prompt", async () => {
    vi.useFakeTimers();
    let resolve: (() => void) | undefined;
    const signer = {
      getPublicKey: alice.getPublicKey.bind(alice),
      signEvent: async (template: Parameters<typeof alice.signEvent>[0]) => {
        await new Promise<void>((done) => {
          resolve = done;
        });
        return alice.signEvent(template);
      },
    };
    const { client, transport } = fixture({ signer });
    const room = channel(client, "room", {
      presence: { ttl: 2, heartbeatInterval: 1 },
    }).subscribe();
    const result = room.send({ type: "broadcast", event: "ping", payload: null });
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    await vi.advanceTimersByTimeAsync(3000);
    resolve?.();
    expect((await result).error?.code).toBe("PUBLISH_FAILED");
    expect(transport.published).toEqual([]);
  });
});
