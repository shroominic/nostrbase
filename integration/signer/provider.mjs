import { RelayPool } from "applesauce-relay";
import { NostrConnectProvider, PrivateKeySigner } from "applesauce-signers";
import { readFile } from "node:fs/promises";
import { WebSocket } from "ws";
import { lastValueFrom } from "rxjs";

// Only this child process owns the account key. IPC carries control decisions, never a signature.
const relay = process.argv[2];
if (!relay || !process.send) throw new Error("Run this service through the integration helper.");
const pool = new RelayPool({ WebSocket, keepAlive: 0 });
const upstream = new PrivateKeySigner();
const identity = new PrivateKeySigner();
const policies = { connect: "allow", sign: "allow", encrypt: "allow", decrypt: "allow" };
const pending = new Map();
let sequence = 0;
const authorize = async (operation) => {
  const id = ++sequence;
  process.send({ type: "approval", id, operation });
  const decision = policies[operation];
  if (decision === "hold") return new Promise((resolve) => pending.set(id, resolve));
  return decision === "allow";
};
const provider = new NostrConnectProvider({
  relays: [relay],
  upstream,
  signer: identity,
  bunkerSecret: "integration-local-only",
  pool,
  onConnect: () => authorize("connect"),
  onSignEvent: () => authorize("sign"),
  onNip44Encrypt: () => authorize("encrypt"),
  onNip44Decrypt: () => authorize("decrypt"),
});

process.on("message", async (message) => {
  try {
    const { command, id } = message;
    if (command === "policy") Object.assign(policies, message.policies);
    else if (command === "release") {
      const resolve = pending.get(message.approval);
      if (!resolve) throw new Error("No held approval with that id.");
      pending.delete(message.approval);
      resolve(message.allow);
    } else if (command === "stop") await provider.stop();
    else if (command === "start") await provider.start();
    else if (command === "close") {
      for (const resolve of pending.values()) resolve(false);
      pending.clear();
      await provider.stop();
      pool.close();
      process.send(
        {
          type: "response",
          id,
          value: { listening: provider.listening, relays: pool.relays.size },
        },
        () => process.exit(0),
      );
      return;
    } else throw new Error(`Unknown command: ${command}`);
    process.send({ type: "response", id, value: { listening: provider.listening } });
  } catch (error) {
    process.send({ type: "response", id: message.id, error: String(error) });
  }
});
await provider.start();
await lastValueFrom(pool.request([relay], { kinds: [0], limit: 1 }), { defaultValue: null });
const packageInfo = JSON.parse(
  await readFile(
    new URL("../../node_modules/applesauce-signers/package.json", import.meta.url),
    "utf8",
  ),
);
process.send({
  type: "ready",
  uri: await provider.getBunkerURI(),
  pubkey: await upstream.getPublicKey(),
  version: packageInfo.version,
  pid: process.pid,
});
