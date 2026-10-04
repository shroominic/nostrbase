import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { WebSocket } from "ws";

const execute = promisify(execFile);
export const relayImages = {
  "nostr-rs": {
    image:
      "scsibug/nostr-rs-relay@sha256:48d54c2d2781577cf3ed2951112f0953dc2c5e7c9d2ea20c64e8c0fa37d16e4d",
    version: "0.10.0",
    port: 8080,
  },
  strfry: {
    image: "dockurr/strfry@sha256:599ab3500dbfbe6cb78c668e1892cd9802c192d066df4660e8e3175034a8344d",
    version: "1.1.3",
    port: 7777,
  },
} as const;
export type RelayImplementation = keyof typeof relayImages;
export interface RelayService {
  url: string;
  httpUrl: string;
  containerName: string;
  logsPath: string;
  restart(): Promise<void>;
  stop(): Promise<void>;
  information(): Promise<{ software: string; version: string; supported_nips: number[] }>;
}

async function docker(args: string[], timeout = 30_000): Promise<string> {
  try {
    const result = await execute(process.env.NOSTRBASE_DOCKER ?? "docker", args, {
      timeout,
      maxBuffer: 4 * 1024 * 1024,
    });
    return result.stdout.trim();
  } catch (error) {
    throw new Error(
      `Independent relay prerequisite or operation failed: docker ${args.join(" ")}. ` +
        "Start Docker and run node integration/relay/prepare.mjs. " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

/** A valid EOSE proves the DB reader and the WebSocket server are both ready. */
function ready(url: string): Promise<void> {
  return new Promise((resolveReady, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => finish(new Error("Relay readiness timed out.")), 1500);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      socket.removeAllListeners();
      // Keep an error observer until termination; connecting sockets can emit an error here.
      socket.on("error", () => {});
      socket.terminate();
      if (error) reject(error);
      else resolveReady();
    };
    socket.on("error", finish);
    socket.on("open", () =>
      socket.send(JSON.stringify(["REQ", "readiness", { kinds: [0], limit: 1 }])),
    );
    socket.on("message", (message) => {
      const frame = JSON.parse(message.toString()) as unknown[];
      if (frame[0] === "EOSE" && frame[1] === "readiness") finish();
    });
  });
}

/** Runs independent upstream software, never the project's WireRelay fixture. */
export async function startRelayService(
  options: {
    implementation?: RelayImplementation;
    allowedPubkeys?: string[];
    requireAuth?: boolean;
  } = {},
): Promise<RelayService> {
  const implementation = options.implementation ?? "nostr-rs";
  const spec = relayImages[implementation];
  if (options.allowedPubkeys && implementation !== "nostr-rs")
    throw new Error("The pubkey allowlist option is only supported by nostr-rs-relay.");
  if (options.requireAuth && implementation !== "strfry")
    throw new Error("The protected-event authentication option is only supported by strfry.");
  await docker(["info", "--format", "{{.ServerVersion}}"]);
  await docker(["image", "inspect", spec.image]);
  const directory = await mkdtemp(join(tmpdir(), "nostrbase-relay-service-"));
  const reservation = createServer().listen({ host: "127.0.0.1", port: 0 });
  await once(reservation, "listening");
  const port = (reservation.address() as AddressInfo).port;
  const url = `ws://127.0.0.1:${port}/`;
  const httpUrl = `http://127.0.0.1:${port}/`;
  const containerName = `nostrbase-${implementation}-${randomUUID()}`;
  const logsPath = resolve("output/environment/relay", `${containerName}.log`);
  const database = join(directory, "db");
  const configPath = join(directory, "config");
  const config =
    implementation === "nostr-rs"
      ? `[info]\nname = "nostrbase integration"\n[network]\naddress = "0.0.0.0"\nport = 8080\n[options]\nreject_future_seconds = 1800\n[limits]\nlimit_scrapers = false\n${
          options.allowedPubkeys
            ? `[authorization]\npubkey_whitelist = ${JSON.stringify(options.allowedPubkeys)}\n`
            : ""
        }`
      : `db = "/test-db/"\nrelay {\n bind = "0.0.0.0"\n port = 7777\n${options.requireAuth ? ` auth {\n enabled = true\n serviceUrl = "${url}"\n }\n` : ""}}\n`;
  let created = false;
  let stopped = false;
  const captureLogs = async () => {
    await mkdir(join(logsPath, ".."), { recursive: true });
    const { stdout, stderr } = await execute(
      process.env.NOSTRBASE_DOCKER ?? "docker",
      ["logs", containerName],
      { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
    );
    await writeFile(logsPath, `Image: ${spec.image}\nVersion: ${spec.version}\n${stdout}${stderr}`);
  };
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (reservation.listening)
      await new Promise<void>((resolveClose) => reservation.close(() => resolveClose()));
    const errors: unknown[] = [];
    if (created) {
      try {
        await captureLogs();
      } catch (error) {
        errors.push(error);
      }
      try {
        await docker(["rm", "--force", containerName]);
      } catch (error) {
        errors.push(error);
      }
    }
    await rm(directory, { recursive: true, force: true });
    if (errors.length) throw new AggregateError(errors, `Relay cleanup failed (${containerName}).`);
  };
  try {
    await mkdir(database);
    await writeFile(configPath, config);
    const args = [
      "create",
      "--pull=never",
      "--name",
      containerName,
      "--user",
      "0:0",
      "--publish",
      `127.0.0.1:${port}:${spec.port}`,
      "--mount",
      `type=bind,src=${database},dst=/test-db`,
      "--mount",
      `type=bind,src=${configPath},dst=/test-config.toml,readonly`,
    ];
    if (implementation === "nostr-rs") args.push("--platform", "linux/amd64");
    args.push(
      "--entrypoint",
      implementation === "nostr-rs" ? "/usr/src/app/nostr-rs-relay" : "/app/strfry",
    );
    args.push(spec.image);
    if (implementation === "nostr-rs")
      args.push("--config", "/test-config.toml", "--db", "/test-db");
    else args.push("--config", "/test-config.toml", "relay");
    await docker(args);
    created = true;
    await new Promise<void>((resolveClose) => reservation.close(() => resolveClose()));
    await docker(["start", containerName]);
    const binding = await docker(["port", containerName, `${spec.port}/tcp`]);
    if (!/^127\.0\.0\.1:\d+$/.test(binding)) throw new Error(`Unexpected port binding: ${binding}`);
    if (binding !== `127.0.0.1:${port}`) throw new Error(`Host port changed: ${binding}`);
    const waitReady = async () => {
      const deadline = Date.now() + 45_000;
      let failure: unknown;
      while (Date.now() < deadline) {
        try {
          await ready(url);
          return;
        } catch (error) {
          failure = error;
        }
        const running = await docker(["inspect", "--format", "{{.State.Running}}", containerName]);
        if (running !== "true") break;
        await delay(100);
      }
      throw new Error(`Independent relay failed readiness; logs: ${logsPath}`, { cause: failure });
    };
    await waitReady();
    return {
      url,
      httpUrl,
      containerName,
      logsPath,
      async restart() {
        // SIGKILL checks disk recovery; restart uses the same container, storage and port.
        await docker(["kill", "--signal", "KILL", containerName]);
        await docker(["start", containerName]);
        await waitReady();
      },
      stop,
      async information() {
        const response = await fetch(httpUrl, {
          headers: { Accept: "application/nostr+json" },
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error(`NIP-11 request failed: ${response.status}`);
        return response.json();
      },
    };
  } catch (error) {
    try {
      await stop();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Independent relay startup and cleanup failed.",
      );
    }
    throw error;
  }
}
