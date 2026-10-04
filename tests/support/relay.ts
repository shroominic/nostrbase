import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { matchFilter, verifyEvent } from "nostr-tools";
import { WebSocket, WebSocketServer } from "ws";
import type { Filter, NostrEvent, RelayPool } from "../../src";

export const relayOptions = {
  WebSocket: WebSocket as unknown as NonNullable<
    ConstructorParameters<typeof RelayPool>[0]
  >["WebSocket"],
  keepAlive: 0,
};

/** Independent NIP-01/09 fixture with observable frames and deliberate protocol faults. */
export class WireRelay {
  private server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  readonly events = new Map<string, NostrEvent>();
  readonly frames: unknown[][] = [];
  readonly subscriptions = new Map<WebSocket, Map<string, Filter[]>>();
  readMode: "eose" | "silence" | "closed" = "eose";
  writeMode: "accept" | "reject" | "silence" | "wrong-id" = "accept";
  rejectWriteNumber?: number;
  injected: NostrEvent[] = [];
  private writes = 0;
  url = "";

  async start(): Promise<this> {
    await once(this.server, "listening");
    this.url = `ws://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    this.server.on("connection", (socket) => {
      const active = new Map<string, Filter[]>();
      this.subscriptions.set(socket, active);
      socket.on("close", () => this.subscriptions.delete(socket));
      socket.on("message", (bytes) => {
        const frame = JSON.parse(bytes.toString()) as unknown[];
        this.frames.push(frame);
        const [verb, payload, ...rest] = frame;
        if (verb === "REQ") {
          const id = payload as string;
          active.set(id, rest as Filter[]);
          if (this.readMode === "closed") {
            socket.send(JSON.stringify(["CLOSED", id, "restricted: fixture"]));
            active.delete(id);
            return;
          }
          const found = new Map<string, NostrEvent>();
          for (const filter of rest as Filter[]) {
            const matching = [...this.events.values()]
              .filter((event) => matchFilter(filter, event))
              .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))
              .slice(0, filter.limit ?? Number.POSITIVE_INFINITY);
            for (const event of matching) found.set(event.id, event);
          }
          for (const event of [...found.values(), ...this.injected])
            socket.send(JSON.stringify(["EVENT", id, event]));
          if (this.readMode === "eose") socket.send(JSON.stringify(["EOSE", id]));
        } else if (verb === "CLOSE") active.delete(payload as string);
        else if (verb === "EVENT") {
          this.writes++;
          const event = payload as NostrEvent;
          if (this.writeMode === "silence") return;
          if (this.writeMode === "wrong-id") {
            socket.send(JSON.stringify(["OK", "0".repeat(64), true, "unrelated event"]));
            return;
          }
          if (
            this.writeMode === "reject" ||
            this.writes === this.rejectWriteNumber ||
            !verifyEvent(JSON.parse(JSON.stringify(event)))
          ) {
            socket.send(JSON.stringify(["OK", event.id, false, "blocked: fixture"]));
            return;
          }
          const identifier = (value: NostrEvent) =>
            value.tags.find((tag) => tag[0] === "d")?.[1] ?? "";
          const address = (value: NostrEvent) =>
            `${value.kind}:${value.pubkey}:${identifier(value)}`;
          let duplicate = this.events.has(event.id);
          if (event.kind >= 30000 && event.kind < 40000) {
            const old = [...this.events.values()].find(
              (value) => address(value) === address(event),
            );
            if (
              old &&
              (old.created_at > event.created_at ||
                (old.created_at === event.created_at && old.id <= event.id))
            )
              duplicate = true;
            else if (old) this.events.delete(old.id);
          }
          if (event.kind === 5) {
            for (const [id, candidate] of this.events) {
              if (
                candidate.pubkey === event.pubkey &&
                candidate.created_at <= event.created_at &&
                event.tags.some(
                  (tag) =>
                    (tag[0] === "e" && tag[1] === id) ||
                    (tag[0] === "a" && tag[1] === address(candidate)),
                )
              )
                this.events.delete(id);
            }
          }
          if (!duplicate && !(event.kind >= 20000 && event.kind < 30000))
            this.events.set(event.id, event);
          socket.send(JSON.stringify(["OK", event.id, true, duplicate ? "duplicate:" : ""]));
          if (!duplicate) this.emit(event);
        } else if (verb === "NEG-OPEN")
          socket.send(JSON.stringify(["NEG-ERR", payload, "unsupported: NIP-77"]));
      });
    });
    return this;
  }

  get activeSubscriptions(): number {
    return [...this.subscriptions.values()].reduce((count, entries) => count + entries.size, 0);
  }
  emit(event: NostrEvent): void {
    for (const [socket, subscriptions] of this.subscriptions)
      for (const [id, filters] of subscriptions)
        if (filters.some((filter) => matchFilter(filter, event)))
          socket.send(JSON.stringify(["EVENT", id, event]));
  }
  restrictSubscriptions(): void {
    for (const [socket, subscriptions] of this.subscriptions) {
      for (const id of subscriptions.keys())
        socket.send(JSON.stringify(["CLOSED", id, "restricted: fixture"]));
      subscriptions.clear();
    }
  }
  async close(): Promise<void> {
    for (const socket of this.server.clients) socket.terminate();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
