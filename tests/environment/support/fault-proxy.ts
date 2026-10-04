import { once } from "node:events";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { WebSocket, WebSocketServer, type RawData } from "ws";

/** Waits for actual traffic. Deadlines detect a missing boundary; they do not trigger faults. */
class Observations<T> {
  readonly entries: T[] = [];
  private observers = new Set<{
    predicate: (entry: T) => boolean;
    resolve: (entry: T) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  add(entry: T): void {
    this.entries.push(entry);
    for (const observer of this.observers) {
      if (observer.predicate(entry)) {
        clearTimeout(observer.timer);
        this.observers.delete(observer);
        observer.resolve(entry);
      }
    }
  }
  wait(predicate: (entry: T) => boolean): Promise<T> {
    const observed = this.entries.find(predicate);
    if (observed !== undefined) return Promise.resolve(observed);
    return new Promise((resolve, reject) => {
      const observer = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.observers.delete(observer);
          reject(new Error("The expected proxy traffic boundary was not observed in 10 seconds."));
        }, 10000),
      };
      this.observers.add(observer);
    });
  }
  close(): void {
    for (const observer of this.observers) {
      clearTimeout(observer.timer);
      observer.reject(new Error("Fault proxy closed before the expected traffic boundary."));
    }
    this.observers.clear();
  }
}

export interface ProxyFrame {
  direction: "client" | "server";
  connection: number;
  frame: unknown[];
}

/** Forwards frames to an independent relay; its only protocol decisions are explicit fault gates. */
export class RelayFaultProxy {
  readonly traffic = new Observations<ProxyFrame>();
  readonly connections = new Observations<number>();
  readonly server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  readonly held: { bytes: RawData; socket: WebSocket; frame: unknown[] }[] = [];
  private upstreamSockets = new Set<WebSocket>();
  private pending = new Set<() => void>();
  private connectionNumber = 0;
  hold: (frame: unknown[]) => boolean = () => false;
  paused = false;
  url = "";

  private constructor(private upstream: string) {}
  static async start(upstream: string): Promise<RelayFaultProxy> {
    const proxy = new RelayFaultProxy(upstream);
    await once(proxy.server, "listening");
    proxy.url = `ws://127.0.0.1:${(proxy.server.address() as AddressInfo).port}/`;
    proxy.server.on("connection", (downstream) => proxy.connect(downstream));
    return proxy;
  }
  private connect(downstream: WebSocket): void {
    const connection = ++this.connectionNumber;
    let upstream: WebSocket | undefined;
    const buffered: RawData[] = [];
    const forward = () => {
      this.pending.delete(forward);
      if (downstream.readyState !== WebSocket.OPEN) return;
      upstream = new WebSocket(this.upstream);
      this.upstreamSockets.add(upstream);
      upstream.on("error", () => downstream.terminate());
      upstream.on("close", () => {
        if (upstream) this.upstreamSockets.delete(upstream);
        downstream.terminate();
      });
      upstream.on("open", () => {
        for (const bytes of buffered.splice(0)) upstream?.send(bytes);
      });
      upstream.on("message", (bytes) => {
        const frame = JSON.parse(bytes.toString()) as unknown[];
        this.traffic.add({ direction: "server", connection, frame });
        if (this.hold(frame)) this.held.push({ bytes, socket: downstream, frame });
        else if (downstream.readyState === WebSocket.OPEN) downstream.send(bytes);
      });
    };
    downstream.on("error", () => upstream?.terminate());
    downstream.on("close", () => {
      this.pending.delete(forward);
      upstream?.terminate();
    });
    downstream.on("message", (bytes) => {
      this.traffic.add({ direction: "client", connection, frame: JSON.parse(bytes.toString()) });
      if (upstream?.readyState === WebSocket.OPEN) upstream.send(bytes);
      else buffered.push(bytes);
    });
    if (this.paused) this.pending.add(forward);
    else forward();
    this.connections.add(connection);
  }
  releaseFrames(): void {
    this.hold = () => false;
    for (const held of this.held.splice(0))
      if (held.socket.readyState === WebSocket.OPEN) held.socket.send(held.bytes);
  }
  resumeConnections(): void {
    this.paused = false;
    for (const forward of [...this.pending]) forward();
  }
  cutConnections(): void {
    this.held.length = 0;
    for (const socket of this.server.clients) socket.terminate();
    for (const socket of this.upstreamSockets) socket.terminate();
  }
  async close(): Promise<void> {
    this.traffic.close();
    this.connections.close();
    this.cutConnections();
    this.pending.clear();
    await new Promise<void>((resolveClose) => this.server.close(() => resolveClose()));
  }
}

export interface HttpFaultGate {
  observed: Promise<{ status: number; bytesForwarded: number }>;
  cut(): void;
}

/** Real HTTP forwarding with one-shot faults at upstream headers or a partial response body. */
export class HttpFaultProxy {
  private sockets = new Set<Socket>();
  private outgoing = new Set<ReturnType<typeof httpRequest>>();
  private armed?: {
    method: string;
    path: string;
    stage: "headers" | "body";
    observed: (value: { status: number; bytesForwarded: number }) => void;
    reject: (error: Error) => void;
    response?: ServerResponse;
    timer: ReturnType<typeof setTimeout>;
  };
  private active = new Set<NonNullable<HttpFaultProxy["armed"]>>();
  private server = createServer((request, response) => {
    const armed = this.armed;
    const fault =
      armed && armed.method === request.method && armed.path === request.url ? armed : undefined;
    if (fault) {
      this.armed = undefined;
      this.active.add(fault);
      fault.response = response;
    }
    const upstream = httpRequest(new URL(request.url ?? "/", this.upstream), {
      method: request.method,
      headers: { ...request.headers, host: new URL(this.upstream).host },
      agent: false,
    });
    this.outgoing.add(upstream);
    upstream.on("error", (error) => {
      if (fault) {
        clearTimeout(fault.timer);
        fault.reject(error);
      }
      response.destroy();
    });
    upstream.on("close", () => this.outgoing.delete(upstream));
    response.on("close", () => {
      upstream.destroy();
      if (fault) this.active.delete(fault);
    });
    request.on("error", () => upstream.destroy());
    upstream.on("response", (received) => {
      received.on("error", () => response.destroy());
      if (fault?.stage === "headers") {
        received.pause();
        clearTimeout(fault.timer);
        fault.observed({ status: received.statusCode ?? 500, bytesForwarded: 0 });
        return;
      }
      response.writeHead(received.statusCode ?? 500, received.headers);
      if (fault?.stage === "body") {
        received.once("data", (bytes: Buffer) => {
          received.pause();
          // Send one byte, retain all remaining bytes, and never send a complete response.
          response.write(bytes.subarray(0, 1), () => {
            clearTimeout(fault.timer);
            fault.observed({ status: received.statusCode ?? 500, bytesForwarded: 1 });
          });
        });
      } else received.pipe(response);
    });
    request.pipe(upstream);
  });
  url = "";
  private constructor(private upstream: string) {
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
  }
  static async start(upstream: string): Promise<HttpFaultProxy> {
    const proxy = new HttpFaultProxy(upstream);
    proxy.server.listen(0, "127.0.0.1");
    await once(proxy.server, "listening");
    proxy.url = `http://127.0.0.1:${(proxy.server.address() as AddressInfo).port}`;
    return proxy;
  }
  arm(method: string, path: string, stage: "headers" | "body"): HttpFaultGate {
    if (this.armed) throw new Error("An HTTP proxy fault is already armed.");
    let fault: NonNullable<HttpFaultProxy["armed"]>;
    const observed = new Promise<{ status: number; bytesForwarded: number }>((resolve, reject) => {
      fault = {
        method,
        path,
        stage,
        observed: resolve,
        reject,
        timer: setTimeout(() => reject(new Error("HTTP fault boundary was not observed.")), 10000),
      };
      this.armed = fault;
    });
    return { observed, cut: () => fault.response?.destroy() };
  }
  async close(): Promise<void> {
    for (const fault of [...this.active, ...(this.armed ? [this.armed] : [])]) {
      clearTimeout(fault.timer);
      fault.reject(new Error("HTTP fault proxy closed before fault completed."));
    }
    for (const request of this.outgoing) request.destroy();
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolveClose) => this.server.close(() => resolveClose()));
  }
}
