import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const upstream = "https://github.com/hzrd149/blossom-server.git";
export const revision = "32567afb15255c171817a78ed2861cd9e57bf4de";
export const version = "6.4.0";
export const root = fileURLToPath(new URL("../../", import.meta.url));
export const source = resolve(root, "output/integration-cache", `blossom-${revision}`);
export const deno = process.env.BLOSSOM_DENO_BIN ?? resolve(root, "node_modules/.bin/deno");

function run(command, args, cwd = root, inherit = false) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: inherit ? "inherit" : "pipe",
    timeout: 240_000,
  });
}

export function verifySource() {
  if (!existsSync(source))
    throw new Error("Blossom source is missing. Run node integration/blossom/setup.mjs first.");
  if (run("git", ["rev-parse", "HEAD"], source).trim() !== revision)
    throw new Error("Blossom checkout does not match the pinned upstream revision.");
  if (run("git", ["status", "--porcelain", "--untracked-files=no"], source).trim())
    throw new Error("Blossom tracked source changed. Remove its integration cache and run setup.");
  const runtime = run(deno, ["--version"]).split("\n")[0];
  if (!runtime?.startsWith("deno 2.9.6 "))
    throw new Error(`Blossom requires Deno 2.9.6; found ${runtime}. Run npm ci.`);
}

export function prepare() {
  if (!existsSync(source)) {
    const checkout = mkdtempSync(resolve(tmpdir(), "nostrbase-blossom-source-"));
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
  verifySource();
  run(deno, ["cache", "--frozen", "main.ts"], source, true);
  writeFileSync(
    resolve(source, ".nostrbase-provenance.json"),
    `${JSON.stringify({ upstream, revision, version, deno: "2.9.6", frozenLock: true }, null, 2)}\n`,
  );
  process.stdout.write(`Prepared upstream Blossom ${version} (${revision}), Deno 2.9.6.\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) prepare();
