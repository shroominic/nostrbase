import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PrivateKeySigner } from "applesauce-signers";

const [relay, blossom, option] = process.argv.slice(2);
if (!relay || !blossom || (option !== undefined && option !== "--write")) {
  throw new Error(
    "Usage: node integration/live/run-public.mjs <relay-url> <blossom-origin> [--write]",
  );
}
for (const [value, protocols, origin] of [
  [relay, ["ws:", "wss:"], false],
  [blossom, ["http:", "https:"], true],
]) {
  const endpoint = new URL(value);
  if (
    !protocols.includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    (origin && endpoint.pathname !== "/")
  )
    throw new Error(
      "Explicit endpoints must not contain credentials, queries, fragments, or a Blossom path.",
    );
}
const signer = new PrivateKeySigner();
const pubkey = await signer.getPublicKey();
const runId = `${Date.now()}-${randomUUID()}`;
const directory = resolve("output/environment/live", runId);
await mkdir(directory, { recursive: true });
const summary = [];
const identityDirectory = resolve("output/integration-cache/live-identities");
const keyPath = resolve(identityDirectory, `${runId}.hex`);
let keyRetained = false;
for (const mode of option === "--write" ? ["read-only", "writes"] : ["read-only"]) {
  const environment = {
    ...process.env,
    NOSTRBASE_LIVE_LOCAL: "0",
    NOSTRBASE_LIVE_RELAY: relay,
    NOSTRBASE_LIVE_BLOSSOM: blossom,
    NOSTRBASE_LIVE_WRITE: mode === "writes" ? "1" : "0",
    NOSTRBASE_LIVE_NAMESPACE: `nostrbase-integration-${randomUUID()}`,
    NOSTRBASE_LIVE_REPORT_FILE: resolve(directory, `${mode}-compatibility.json`),
  };
  delete environment.NOSTRBASE_LIVE_TEST_KEY;
  delete environment.NOSTRBASE_LIVE_TEST_PUBKEY;
  if (mode === "writes") {
    environment.NOSTRBASE_LIVE_TEST_KEY = Buffer.from(signer.key).toString("hex");
    environment.NOSTRBASE_LIVE_TEST_PUBKEY = pubkey;
    await mkdir(identityDirectory, { recursive: true, mode: 0o700 });
    await writeFile(keyPath, Buffer.from(signer.key).toString("hex"), { mode: 0o600, flag: "wx" });
    keyRetained = true;
  }
  const outputFile = resolve(directory, `${mode}.json`);
  const child = spawn(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "--config",
      "vitest.environment.config.ts",
      "--project",
      "live-services",
      `--outputFile.json=${outputFile}`,
    ],
    { env: environment, stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  const append = (bytes) => {
    log = (log + bytes.toString()).slice(-2_000_000);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  const exitCode = await new Promise((done, fail) => {
    child.once("exit", done);
    child.once("error", fail);
  });
  const logPath = resolve(directory, `${mode}.log`);
  await writeFile(logPath, log);
  summary.push({
    mode,
    exitCode,
    results: outputFile,
    compatibility: environment.NOSTRBASE_LIVE_REPORT_FILE,
    log: logPath,
  });
  if (mode === "writes") {
    try {
      const report = JSON.parse(await readFile(environment.NOSTRBASE_LIVE_REPORT_FILE, "utf8"));
      const checks = report.checks ?? {};
      const resources = [
        ["recordAttempt", "recordCleanup", "relays"],
        ["searchSeedAttempt", "searchSeedCleanup", "relays"],
        ["blobAttempt", "blobCleanup", "results"],
      ];
      const cleanupUnconfirmed =
        resources.some(([write, cleanup, acknowledgements]) => {
          if (checks[write] === undefined) return false;
          const receipt = checks[cleanup];
          return (
            receipt?.error !== null ||
            !Array.isArray(receipt[acknowledgements]) ||
            !receipt[acknowledgements].some((result) => result?.ok === true) ||
            (write === "recordAttempt" &&
              (!Array.isArray(receipt.eventIds) || receipt.eventIds.length === 0))
          );
        }) || resources.some(([, cleanup]) => checks[cleanup]?.error != null);
      if (!cleanupUnconfirmed) {
        await rm(keyPath);
        keyRetained = false;
      }
    } catch {
      /* Keep this dedicated account key if the process/report could not confirm cleanup. */
    }
  }
}
await writeFile(
  resolve(directory, "summary.json"),
  JSON.stringify(
    {
      relay,
      blossom,
      testPubkey: option === "--write" ? pubkey : undefined,
      runs: summary,
      keyRetained,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ directory, runs: summary, keyRetained }));
process.exitCode = summary.some((run) => run.exitCode !== 0) ? 1 : 0;
