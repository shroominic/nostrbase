import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { setImmediate as yieldToIO } from "node:timers/promises";
import { WebSocket } from "ws";
import { createClient, PrivateKeySigner, REALTIME_KIND, type RelayPool } from "../../../src";

export interface RealtimeLoadReport {
  node: string;
  durationTargetMs: number;
  elapsedMs: number;
  warmupCycles: number;
  cycles: number;
  broadcasts: number;
  joins: number;
  leaves: number;
  socketConnections: number;
  messages: { req: number; close: number; event: number; ok: number };
  latencyMs: { p50: number; p95: number; maximum: number };
  resources: {
    idleIntervalBaseline: number;
    channelIntervalsCreated: number;
    platformTimeoutBaseline: number;
    platformTimeoutsAfterClose: number;
    activeSubscriptions: number;
    activeIntervals: number;
    openSockets: number;
    cachedEvents: number;
    maxDiagnosticEntries: number;
  };
  memory: { point: string; heapUsed: number; rss: number; external: number }[];
}

const subscriptions = new Map<
  WebSocket,
  Map<string, { filters: Record<string, unknown>[]; eose: boolean }>
>();
const sockets = new Set<WebSocket>();
const messages = { req: 0, close: 0, event: 0, ok: 0 };
let socketConnections = 0;
class ObservedWebSocket extends WebSocket {
  constructor(...args: ConstructorParameters<typeof WebSocket>) {
    super(...args);
    socketConnections++;
    sockets.add(this);
    subscriptions.set(this, new Map());
    const original = this.send.bind(this);
    this.send = ((data: unknown, ...rest: unknown[]) => {
      if (typeof data === "string") {
        const frame = JSON.parse(data) as unknown[];
        if (frame[0] === "REQ") {
          messages.req++;
          subscriptions.get(this)?.set(frame[1] as string, {
            filters: frame.slice(2) as Record<string, unknown>[],
            eose: false,
          });
        } else if (frame[0] === "CLOSE") {
          messages.close++;
          subscriptions.get(this)?.delete(frame[1] as string);
        } else if (frame[0] === "EVENT") messages.event++;
      }
      Reflect.apply(original, this, [data, ...rest]);
    }) as WebSocket["send"];
    this.on("message", (bytes) => {
      const frame = JSON.parse(bytes.toString()) as unknown[];
      if (frame[0] === "EOSE") {
        const subscription = subscriptions.get(this)?.get(frame[1] as string);
        if (subscription) subscription.eose = true;
      } else if (frame[0] === "CLOSED") subscriptions.get(this)?.delete(frame[1] as string);
      else if (frame[0] === "OK") messages.ok++;
    });
    this.on("close", () => {
      sockets.delete(this);
      subscriptions.delete(this);
    });
  }
}
async function until(predicate: () => boolean, boundary: string): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, `Missing workload boundary: ${boundary}`);
    await yieldToIO();
  }
}
const pendingSubscriptions = () =>
  [...subscriptions.values()].reduce((total, entries) => total + entries.size, 0);

async function run(): Promise<RealtimeLoadReport> {
  const [url, namespace, durationText] = process.argv.slice(2);
  const duration = Number(durationText);
  assert.ok(
    url && namespace && Number.isSafeInteger(duration) && duration >= 1000 && duration <= 120000,
  );
  assert.equal(typeof globalThis.gc, "function", "Run the workload child with --expose-gc.");
  const intervals = new Set<ReturnType<typeof setInterval>>();
  let channelIntervalsCreated = 0;
  const platformTimeouts = () =>
    process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
  const platformTimeoutBaseline = platformTimeouts();
  const nativeSetInterval = globalThis.setInterval;
  const nativeClearInterval = globalThis.clearInterval;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const interval = Reflect.apply(nativeSetInterval, globalThis, args) as ReturnType<
      typeof setInterval
    >;
    // Observe direct SDK channel timers, rather than counting transient RxJS liveness timers.
    const caller = new Error().stack?.split("\n")[2] ?? "";
    if (caller.includes("NostrbaseChannel.")) {
      intervals.add(interval);
      channelIntervalsCreated++;
    }
    return interval;
  }) as typeof setInterval;
  globalThis.clearInterval = ((interval: ReturnType<typeof setInterval>) => {
    intervals.delete(interval);
    nativeClearInterval(interval);
  }) as typeof clearInterval;
  const options = {
    namespace,
    relays: [url],
    timeout: 5000,
    diagnostics: { capacity: 32 },
    relayOptions: {
      WebSocket: ObservedWebSocket as unknown as NonNullable<
        ConstructorParameters<typeof RelayPool>[0]
      >["WebSocket"],
      keepAlive: 60000,
    },
  };
  const writer = createClient({
    ...options,
    signer: new PrivateKeySigner(new Uint8Array(32).fill(71)),
  });
  const reader = createClient(options);
  const author = (await writer.auth.getSession()).data?.user.pubkey as string;
  const memory: RealtimeLoadReport["memory"] = [];
  const sample = (point: string) => {
    globalThis.gc?.();
    const { heapUsed, rss, external } = process.memoryUsage();
    memory.push({ point, heapUsed, rss, external });
  };
  let cycles = 0;
  let broadcasts = 0;
  let joins = 0;
  let leaves = 0;
  let maxDiagnosticEntries = 0;
  let idleIntervalBaseline = 0;
  const latency: number[] = [];
  async function cycle(index: number): Promise<void> {
    const began = performance.now();
    const intervalsBefore = channelIntervalsCreated;
    let delivered = 0;
    const errors: string[] = [];
    const room = `room-${index}`;
    const scope = `nostrbase:channel:${encodeURIComponent(namespace as string)}:${room}`;
    const observer = reader
      .channel(room)
      .on("broadcast", { event: "position" }, (message) => {
        assert.deepEqual(message.payload, { index });
        delivered++;
        broadcasts++;
      })
      .on("presence", { event: "join" }, () => joins++)
      .on("presence", { event: "leave" }, () => leaves++)
      .subscribe((status, error) => {
        if (status === "CHANNEL_ERROR") errors.push(error?.message ?? "unknown channel error");
      });
    const sender = writer
      .channel(room, { presence: { ttl: 30, heartbeatInterval: 10 } })
      .subscribe((status, error) => {
        if (status === "CHANNEL_ERROR") errors.push(error?.message ?? "unknown channel error");
      });
    try {
      await until(
        () =>
          [...subscriptions.values()]
            .flatMap((entries) => [...entries.values()])
            .filter(
              (entry) =>
                entry.eose &&
                entry.filters.some((filter) =>
                  (filter["#t"] as string[] | undefined)?.includes(scope),
                ),
            ).length === 2,
        "both upstream subscriptions ready",
      );
      assert.equal(
        (await sender.send({ type: "broadcast", event: "position", payload: { index } })).error,
        null,
      );
      await until(() => delivered === 1, "one remote broadcast");
      assert.equal((await sender.track({ index })).error, null);
      await until(() => observer.presenceState()[author]?.length === 1, "presence join");
      assert.equal((await sender.untrack()).error, null);
      await until(() => observer.presenceState()[author] === undefined, "presence leave");
      assert.deepEqual(errors, []);
    } finally {
      await Promise.all([writer.removeChannel(sender), reader.removeChannel(observer)]);
    }
    assert.equal(Object.keys(sender.presenceState()).length, 0);
    assert.equal(Object.keys(observer.presenceState()).length, 0);
    // EOSE on each same connection proves preceding CLOSE frames reached the upstream relay.
    const drains = await Promise.all([
      writer.events.query({ ids: ["0".repeat(64)] }),
      reader.events.query({ ids: ["0".repeat(64)] }),
    ]);
    for (const drain of drains) assert.equal(drain.error, null);
    assert.equal(pendingSubscriptions(), 0);
    assert.equal(
      intervals.size,
      idleIntervalBaseline,
      "Channel expiry, heartbeat, and request timers must return to the idle connection baseline.",
    );
    assert.equal(
      channelIntervalsCreated - intervalsBefore,
      3,
      "Observe both expiry intervals and the sender heartbeat; the cleanup check must not be vacuous.",
    );
    assert.equal(delivered, 1, "A cycle must not duplicate the remote broadcast.");
    for (const client of [writer, reader]) {
      assert.deepEqual(client.cachedEvents(), []);
      assert.deepEqual(client.eventStore.getByFilters({ kinds: [REALTIME_KIND] }), []);
      const logs = client.diagnostics.list();
      assert.ok(logs.length <= 32);
      maxDiagnosticEntries = Math.max(maxDiagnosticEntries, logs.length);
    }
    latency.push(performance.now() - began);
  }
  try {
    const initial = await Promise.all([
      writer.events.query({ ids: ["0".repeat(64)] }),
      reader.events.query({ ids: ["0".repeat(64)] }),
    ]);
    for (const result of initial) assert.equal(result.error, null);
    assert.equal(pendingSubscriptions(), 0);
    idleIntervalBaseline = intervals.size;
    sample("before-warmup");
    for (let index = -3; index < 0; index++) await cycle(index);
    await yieldToIO();
    sample("after-warmup");
    const began = performance.now();
    while (performance.now() - began < duration) {
      assert.ok(cycles < 10000, "Workload exceeded the 10,000 cycle resource guard.");
      await cycle(cycles++);
      if (cycles % 25 === 0) {
        await yieldToIO();
        sample(`cycle-${cycles}`);
      }
    }
    const elapsedMs = performance.now() - began;
    assert.ok(cycles > 0);
    await Promise.all([writer.closeAsync(), reader.closeAsync()]);
    await until(() => sockets.size === 0, "WebSocket cleanup after client close");
    assert.equal(intervals.size, 0);
    assert.equal(
      platformTimeouts(),
      platformTimeoutBaseline,
      "No referenced platform timer may survive client close.",
    );
    await yieldToIO();
    sample("after-close");
    latency.sort((a, b) => a - b);
    assert.equal(broadcasts, cycles + 3);
    assert.equal(joins, cycles + 3);
    assert.equal(leaves, cycles + 3);
    return {
      node: process.version,
      durationTargetMs: duration,
      elapsedMs,
      warmupCycles: 3,
      cycles,
      broadcasts,
      joins,
      leaves,
      socketConnections,
      messages,
      latencyMs: {
        p50: latency[Math.floor(latency.length * 0.5)] ?? 0,
        p95: latency[Math.floor(latency.length * 0.95)] ?? 0,
        maximum: latency.at(-1) ?? 0,
      },
      resources: {
        idleIntervalBaseline,
        channelIntervalsCreated,
        platformTimeoutBaseline,
        platformTimeoutsAfterClose: platformTimeouts(),
        activeSubscriptions: pendingSubscriptions(),
        activeIntervals: intervals.size,
        openSockets: sockets.size,
        cachedEvents: writer.cachedEvents().length + reader.cachedEvents().length,
        maxDiagnosticEntries,
      },
      memory,
    };
  } finally {
    await Promise.allSettled([writer.closeAsync(), reader.closeAsync()]);
    globalThis.setInterval = nativeSetInterval;
    globalThis.clearInterval = nativeClearInterval;
    for (const interval of intervals) nativeClearInterval(interval);
    for (const socket of sockets) socket.terminate();
  }
}

void run()
  .then((report) => process.stdout.write(`${JSON.stringify(report)}\n`))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
