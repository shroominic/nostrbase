import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const upstream = "https://github.com/fiatjaf/nos2x.git";
export const revision = "014493f9602d0a3826ef3eab2bdd4901ee315cce";
export const version = "2.5.2";
export const root = fileURLToPath(new URL("../../", import.meta.url));
const dependencies = fileURLToPath(new URL("./", import.meta.url));
export const source = resolve(root, "output/integration-cache", `nos2x-${revision}`);
export const extension = resolve(source, "extension");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, cwd = root, inherit = false, env = process.env) {
  return execFileSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: inherit ? "inherit" : "pipe",
    timeout: 240_000,
  });
}

function hashes(directory, prefix = "") {
  const files = {};
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) Object.assign(files, hashes(path, `${name}/`));
    else if (entry.isFile())
      files[name] = createHash("sha256").update(readFileSync(path)).digest("hex");
  }
  return files;
}

export function verifyBuild() {
  if (!existsSync(resolve(source, ".nostrbase-provenance.json")))
    throw new Error("nos2x is not prepared. Run node integration/extension/setup.mjs first.");
  const provenance = JSON.parse(
    readFileSync(resolve(source, ".nostrbase-provenance.json"), "utf8"),
  );
  if (
    run("git", ["rev-parse", "HEAD"], source).trim() !== revision ||
    provenance.revision !== revision
  )
    throw new Error("nos2x source does not match the pinned upstream revision.");
  if (run("git", ["status", "--porcelain", "--untracked-files=no"], source).trim())
    throw new Error("nos2x tracked source changed. Remove its integration cache and run setup.");
  const manifest = JSON.parse(readFileSync(resolve(extension, "manifest.json"), "utf8"));
  if (manifest.version !== version || manifest.manifest_version !== 3)
    throw new Error("Expected the pinned nos2x 2.5.2 Manifest V3 extension.");
  if (JSON.stringify(hashes(extension)) !== JSON.stringify(provenance.files))
    throw new Error("nos2x extension files changed after setup. Run setup again.");
  const dependencyLock = createHash("sha256")
    .update(readFileSync(resolve(dependencies, "package-lock.json")))
    .digest("hex");
  if (dependencyLock !== provenance.dependencyLock)
    throw new Error("nos2x build dependencies changed. Run setup again.");
}

export function prepare() {
  if (!existsSync(source)) {
    const checkout = mkdtempSync(resolve(tmpdir(), "nostrbase-nos2x-source-"));
    try {
      run("git", ["init", "-q", checkout]);
      run("git", ["fetch", "--depth=1", upstream, revision], checkout, true);
      run("git", ["checkout", "--detach", "FETCH_HEAD"], checkout, true);
      mkdirSync(resolve(root, "output/integration-cache"), { recursive: true });
      renameSync(checkout, source);
    } finally {
      rmSync(checkout, { recursive: true, force: true });
    }
  }
  if (run("git", ["rev-parse", "HEAD"], source).trim() !== revision)
    throw new Error("nos2x checkout is not the pinned revision.");
  if (run("git", ["status", "--porcelain", "--untracked-files=no"], source).trim())
    throw new Error("nos2x source changed; remove the integration cache before setup.");
  run(npm, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], dependencies, true);
  rmSync(resolve(source, "node_modules"), { recursive: true, force: true });
  symlinkSync(resolve(dependencies, "node_modules"), resolve(source, "node_modules"), "junction");
  // Run the upstream build without changing its manifest, provider, UI or signing code.
  run(process.execPath, ["build.js", "prod"], source, true, {
    ...process.env,
    NODE_PATH: resolve(dependencies, "node_modules"),
  });
  writeFileSync(
    resolve(source, ".nostrbase-provenance.json"),
    `${JSON.stringify(
      {
        upstream,
        revision,
        version,
        dependencyLock: createHash("sha256")
          .update(readFileSync(resolve(dependencies, "package-lock.json")))
          .digest("hex"),
        files: hashes(extension),
      },
      null,
      2,
    )}\n`,
  );
  verifyBuild();
  process.stdout.write(
    `Prepared real nos2x ${version} (${revision}) from unmodified upstream source.\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) prepare();
