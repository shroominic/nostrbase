import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { requireQualityTool, root } from "./quality-tools.mjs";

const mode = process.argv[2];
if (process.argv.length > 3 || (mode && !["--staged", "--history"].includes(mode)))
  throw new Error("Usage: npm run check-secrets -- [--staged|--history]");
const binary = await requireQualityTool("gitleaks");
const canonicalRoot = await realpath(root);
const reportDirectory = resolve(root, "output/security");
await mkdir(reportDirectory, { recursive: true });
const reportPath = resolve(reportDirectory, `secrets-${mode?.slice(2) ?? "source"}.json`);
const options = [
  "--redact=100",
  "--no-banner",
  "--report-format=json",
  "--report-path",
  reportPath,
];
let snapshot;
try {
  let args;
  if (mode === "--history")
    args = [
      "git",
      root,
      "--log-opts=--all",
      "--config",
      resolve(root, ".gitleaks.toml"),
      ...options,
    ];
  else {
    snapshot = await mkdtemp(join(tmpdir(), "nostrbase-secrets-"));
    const list = execFileSync(
      "git",
      [
        "ls-files",
        "-z",
        "--cached",
        ...(mode === "--staged" ? [] : ["--others", "--exclude-standard"]),
      ],
      { cwd: root, encoding: "utf8" },
    );
    const files = new Set(list.split("\0").filter(Boolean));
    for (const file of files) {
      const destination = resolve(snapshot, file);
      if (!destination.startsWith(`${snapshot}/`)) throw new Error("Invalid repository path.");
      if (mode === "--staged") {
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, execFileSync("git", ["show", `:${file}`], { cwd: root }));
      } else {
        try {
          const source = resolve(root, file);
          const parent = await realpath(dirname(source));
          if (parent !== canonicalRoot && !parent.startsWith(`${canonicalRoot}/`))
            throw new Error(
              `Source path escapes the repository through a directory symlink: ${file}`,
            );
          await mkdir(dirname(destination), { recursive: true });
          if ((await lstat(source)).isSymbolicLink())
            await writeFile(destination, await readlink(source));
          else await copyFile(source, destination);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    }
    args = [
      "dir",
      snapshot,
      "--config",
      resolve(mode === "--staged" ? snapshot : root, ".gitleaks.toml"),
      ...options,
    ];
  }
  const result = spawnSync(binary, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status === 1) {
    const findings = JSON.parse(await readFile(reportPath, "utf8"));
    for (const finding of findings)
      console.error(`${finding.File}:${finding.StartLine}: ${finding.RuleID} (secret redacted)`);
  }
  process.exitCode = result.status ?? 1;
} finally {
  if (snapshot) await rm(snapshot, { recursive: true, force: true });
}
