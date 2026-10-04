import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const directory = resolve(root, "output/security");
await mkdir(directory, { recursive: true });
let failed = false;
for (const scope of [".", "site", "integration/extension", "examples/fieldwork"]) {
  const result = spawnSync("npm", ["audit", "--json", "--package-lock-only"], {
    cwd: resolve(root, scope),
    encoding: "utf8",
    maxBuffer: 10_000_000,
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  const report = JSON.parse(result.stdout || "{}");
  const name = scope === "." ? "sdk" : scope.replaceAll("/", "-");
  await writeFile(resolve(directory, `${name}-audit.json`), JSON.stringify(report, null, 2));
  if (report.error || !report.metadata || ![0, 1].includes(result.status)) {
    console.error(
      `${scope}: audit could not complete; inspect output/security/${name}-audit.json.`,
    );
    failed = true;
  } else console.log(`${scope}: ${JSON.stringify(report.metadata.vulnerabilities)}`);
}
console.log(
  "Dependency findings are reported for maintainer triage; they do not fail this command.",
);
process.exitCode = failed ? 1 : 0;
