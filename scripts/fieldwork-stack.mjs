import { createWriteStream } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { access, mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isPinnedNakVersion, localNak } from "./prepare-fieldwork.mjs";

const root = resolve(import.meta.dirname, "..");
const port = process.env.FIELDWORK_RELAY_PORT ?? "18047";
const appPort = process.env.FIELDWORK_PORT ?? "4173";
const nak =
  process.env.FIELDWORK_NAK ??
  (await access(localNak).then(
    () => localNak,
    () => "nak",
  ));
const directory = await mkdtemp(join(tmpdir(), "fieldwork-services-"));
await mkdir(join(root, "output/fieldwork"), { recursive: true });
const log = createWriteStream(join(root, "output/fieldwork/services.log"));
const children = [];
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  await Promise.all(
    children.map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) return resolve();
          const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        }),
    ),
  );
  await rm(directory, { recursive: true, force: true });
  log.end();
  process.exitCode = code;
}
try {
  const version = execFileSync(nak, ["--version"], { encoding: "utf8" }).trim();
  if (!isPinnedNakVersion(version))
    throw new Error(`Use nak 0.20.7; got ${version}. See examples/fieldwork/README.md.`);
  const args = ["serve", "--hostname", "127.0.0.1", "--port", port, "--blossom"];
  if (!process.env.FIELDWORK_NO_NEGENTROPY) args.push("--negentropy");
  // nak's Blossom implementation stores files relative to cwd. Isolate each run.
  const relay = spawn(nak, args, { cwd: directory, stdio: ["ignore", "pipe", "pipe"] });
  children.push(relay);
  relay.stdout.pipe(log, { end: false });
  relay.stderr.pipe(log, { end: false });
  relay.once("error", (error) => {
    console.error(error);
    void stop(1);
  });
  relay.once("exit", (code) => {
    if (!stopping) {
      console.error(`Relay exited: ${code}`);
      void stop(1);
    }
  });
  const deadline = Date.now() + 15000;
  for (;;) {
    if (stopping) throw new Error("Relay failed to start.");
    try {
      const response = await fetch(`http://127.0.0.1:${port}`, {
        headers: { Accept: "application/nostr+json" },
        signal: AbortSignal.timeout(500),
      });
      const info = await response.json();
      if (
        info.name !== "nak serve" ||
        typeof info.version !== "string" ||
        info.version.replace(/^v/, "") !== "0.20.7"
      )
        throw new Error("Unexpected relay on selected port.");
      if (!process.env.FIELDWORK_NO_NEGENTROPY && !info.supported_nips.includes(77))
        throw new Error("Relay did not advertise NIP-77.");
      break;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const app = spawn(process.execPath, ["examples/fieldwork/serve.mjs"], {
    cwd: root,
    env: { ...process.env, FIELDWORK_PORT: appPort },
    stdio: "inherit",
  });
  children.push(app);
  app.once("error", (error) => {
    console.error(error);
    void stop(1);
  });
  app.once("exit", () => {
    if (!stopping) void stop(1);
  });
  console.log(
    `Independent services: ${version}; NIP-77 ${process.env.FIELDWORK_NO_NEGENTROPY ? "disabled (fallback test)" : "enabled"}; Blossom enabled.`,
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      void stop();
    });
} catch (error) {
  console.error(error);
  await stop(1);
}
