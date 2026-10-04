import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildStorageVector, negentropySync } from "applesauce-relay/negentropy";
import { webSocket } from "rxjs/webSocket";
import { WebSocket } from "ws";

const endpoint = new URL(process.argv[2] ?? "invalid:");
if (
  !["ws:", "wss:"].includes(endpoint.protocol) ||
  endpoint.username ||
  endpoint.password ||
  endpoint.search ||
  endpoint.hash
)
  throw new Error("Supply an explicit ws(s) relay URL without credentials, query, or fragment.");
const report = {
  relay: endpoint.toString(),
  started: new Date().toISOString(),
  completed: false,
  notices: [],
  have: 0,
  need: 0,
};
let resolveOpen;
let rejectOpen;
const opened = new Promise((done, fail) => {
  resolveOpen = done;
  rejectOpen = fail;
});
const socket = webSocket({
  url: endpoint.toString(),
  WebSocketCtor: WebSocket,
  openObserver: { next: () => resolveOpen() },
});
const subscription = socket.subscribe({
  next: (frame) => {
    if (frame[0] === "NOTICE") report.notices.push(String(frame[1]).slice(0, 1000));
  },
  error: (error) => rejectOpen(error),
});
let timer;
try {
  await Promise.race([
    opened,
    new Promise((_, fail) => {
      timer = setTimeout(() => fail(new Error("WebSocket readiness timed out.")), 10000);
    }),
  ]);
  clearTimeout(timer);
  report.completed = await negentropySync(
    buildStorageVector([]),
    socket,
    { kinds: [30078], "#t": [`nostrbase-integration-probe-${randomUUID()}`] },
    async (have, need) => {
      report.have += have.length;
      report.need += need.length;
    },
    { signal: AbortSignal.timeout(5000) },
  );
} catch (error) {
  report.error = error instanceof Error ? error.message : "Negentropy probe failed.";
} finally {
  clearTimeout(timer);
  subscription.unsubscribe();
  socket.complete();
  report.finished = new Date().toISOString();
}
const path = resolve("output/environment/live", `negentropy-probe-${Date.now()}.json`);
await mkdir(resolve(path, ".."), { recursive: true });
await writeFile(path, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ path, ...report }));
process.exitCode = report.completed ? 0 : 1;
