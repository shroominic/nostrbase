import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Each deliberate fault targets a named contract. Run only in a disposable copy.
const cases = [
  {
    name: "cache owns its signed events",
    source: "src/client.ts",
    before: "event = structuredClone(event);",
    after: "/* Deliberate fault: keep the caller's mutable event. */",
    file: "tests/cache-isolation.unit.test.ts",
    test: "mutating a transport-owned event after ingestion",
  },
  {
    name: "cache reads honor cancellation",
    source: "src/client.ts",
    before:
      'if (this.signal(state.signal).aborted)\n        throw new NostrbaseError("ABORTED", "Operation was aborted.");',
    after: "/* Deliberate fault: ignore cache read cancellation. */",
    file: "tests/state.unit.test.ts",
    test: "pre-aborted public cache reads",
  },
  {
    name: "signed publication uses a snapshot",
    source: "src/events.ts",
    before: "const signed = structuredClone(event);",
    after: "const signed = event;",
    file: "tests/state.unit.test.ts",
    test: "a delayed native signed publish uses an immutable event snapshot",
  },
  {
    name: "table observers receive separate payloads",
    source: "src/channel.ts",
    before: "listener.callback(structuredClone(payload));",
    after: "listener.callback(payload);",
    file: "tests/state.unit.test.ts",
    test: "one table observer cannot alter the next observer",
  },
  {
    name: "stale deletes cannot hide a newer version",
    source: "src/channel.ts",
    before:
      "if (latest && compareEvents(latest, previous.event) > 0 && !this.client.isDeleted(latest))\n          continue;",
    after: "/* Deliberate fault: emit a stale deletion. */",
    file: "tests/state.unit.test.ts",
    test: "a stale delete cannot emit a phantom DELETE",
  },
  {
    name: "queue commits before optimistic exposure",
    source: "src/offline.ts",
    before:
      "await this.adapter.putQueue(entry, this.host.namespace);\n        // Only expose optimistic state after the queue write commits.\n        this.host.ingest(signed);",
    after:
      "this.host.ingest(signed);\n        await this.adapter.putQueue(entry, this.host.namespace);",
    file: "tests/durability.unit.test.ts",
    test: "a failed durable enqueue cannot expose optimistic state",
  },
  {
    name: "record content agrees with namespace tags",
    source: "src/protocol.ts",
    before: "record.namespace !== namespace ||",
    after: "false ||",
    file: "tests/protocol.unit.test.ts",
    test: "rejects signed records with content namespace disagrees with scope",
  },
  {
    name: "mutations enforce author ownership",
    source: "src/client.ts",
    before: "if (state.authors?.some((author) => author !== pubkey))",
    after: "if (false)",
    file: "tests/sdk.test.ts",
    test: "uses author plus id for identity and rejects writes to other authors",
  },
];

const root = resolve(import.meta.dirname, "..");
const directory = await mkdtemp(join(tmpdir(), "nostrbase-mutations-"));
const sources = new Map();
const report = join(directory, "result.json");
async function run(files, pattern) {
  await rm(report, { force: true });
  const result = spawnSync(
    process.execPath,
    [
      join(root, "node_modules/vitest/vitest.mjs"),
      "run",
      ...files,
      "--project",
      "unit",
      "--reporter=json",
      `--outputFile=${report}`,
      "-t",
      pattern,
    ],
    { cwd: directory, encoding: "utf8", timeout: 30000 },
  );
  if (result.error || result.signal)
    throw new Error(`Test runner failed: ${result.error ?? result.signal}`);
  try {
    return { status: result.status, report: JSON.parse(await readFile(report, "utf8")) };
  } catch {
    throw new Error(`Test runner did not produce a report.\n${result.stdout}\n${result.stderr}`);
  }
}
try {
  for (const path of ["src", "tests", "package.json", "vitest.config.ts", "tsconfig.json"])
    await cp(join(root, path), join(directory, path), { recursive: true });
  await symlink(join(root, "node_modules"), join(directory, "node_modules"), "dir");
  for (const mutation of cases) {
    if (!sources.has(mutation.source))
      sources.set(mutation.source, await readFile(join(directory, mutation.source), "utf8"));
    const source = sources.get(mutation.source);
    if (source.split(mutation.before).length !== 2)
      throw new Error(`Update the mutation target: ${mutation.name}`);
  }
  const baseline = await run(
    [...new Set(cases.map((mutation) => mutation.file))],
    cases.map((mutation) => mutation.test).join("|"),
  );
  if (baseline.status !== 0 || baseline.report.numPassedTests !== cases.length)
    throw new Error("The unmodified contract tests must all pass before mutation checks.");
  let detected = 0;
  for (const mutation of cases) {
    const source = sources.get(mutation.source);
    await writeFile(
      join(directory, mutation.source),
      source.replace(mutation.before, mutation.after),
    );
    const result = await run([mutation.file], mutation.test);
    await writeFile(join(directory, mutation.source), source);
    // Compilation, collection and runner failures do not count as a detected behavioral fault.
    const failed = result.report.testResults
      .flatMap((file) => file.assertionResults)
      .filter((assertion) => assertion.status === "failed");
    if (
      result.status === 0 ||
      result.report.numFailedTests !== 1 ||
      failed.length !== 1 ||
      !failed[0].failureMessages.some((message) => message.includes("AssertionError"))
    )
      throw new Error(`Fault was not detected by its contract test: ${mutation.name}`);
    detected++;
    console.log(`Detected: ${mutation.name}`);
  }
  console.log(
    `${detected}/${cases.length} deliberate faults detected. The workspace source was unchanged.`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
