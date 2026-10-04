import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const directories: string[] = [];
const initial = "export const value = 1;\n";
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "nostrbase-hook-test-"));
  directories.push(directory);
  for (const file of [
    ".gitleaks.toml",
    "biome.json",
    ".githooks/pre-commit",
    "scripts/check-staged.mjs",
    "scripts/check-secrets.mjs",
    "scripts/quality-tools.mjs",
    "scripts/quality-tools.json",
  ]) {
    await mkdir(dirname(resolve(directory, file)), { recursive: true });
    await copyFile(resolve(root, file), resolve(directory, file));
  }
  await mkdir(resolve(directory, "output"));
  await symlink(
    resolve(root, "output/quality-tools"),
    resolve(directory, "output/quality-tools"),
    "dir",
  );
  await symlink(resolve(root, "node_modules"), resolve(directory, "node_modules"), "dir");
  await writeFile(resolve(directory, ".gitignore"), "node_modules\noutput/\n");
  await writeFile(resolve(directory, "fixture.ts"), initial);
  await writeFile(
    resolve(directory, "package.json"),
    JSON.stringify({ private: true, scripts: { typecheck: "tsc --noEmit" } }),
  );
  await writeFile(
    resolve(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true, skipLibCheck: true, noEmit: true },
      include: ["fixture.ts"],
    }),
  );
  execFileSync(
    resolve(root, "node_modules/.bin/biome"),
    ["format", "--write", "package.json", "tsconfig.json"],
    { cwd: directory, stdio: "pipe" },
  );
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8" });
  git("init", "--quiet", "-b", "main");
  git("config", "user.name", "Integration Test");
  git("config", "user.email", "test@nostrbase.invalid");
  git("config", "core.hooksPath", ".githooks");
  git("add", ".");
  const commit = () =>
    spawnSync("git", ["-c", "commit.gpgSign=false", "commit", "--quiet", "-m", "Hook fixture"], {
      cwd: directory,
      encoding: "utf8",
      timeout: 20_000,
    });
  return { directory, git, commit };
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("actual pre-commit hook and secret scanner", () => {
  it("rejects staged formatting even when unstaged formatting hides the defect", async () => {
    const { directory, git, commit } = await fixture();
    await writeFile(resolve(directory, "fixture.ts"), "export const value=1\n");
    git("add", "fixture.ts");
    await writeFile(resolve(directory, "fixture.ts"), initial);
    const result = commit();
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("format");
    expect(git("show", ":fixture.ts")).toBe("export const value=1\n");
  });
  it("accepts valid staged content without committing or rewriting unstaged formatting", async () => {
    const { directory, git, commit } = await fixture();
    await writeFile(resolve(directory, "fixture.ts"), "export const value=1\n");
    const result = commit();
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(git("show", "HEAD:fixture.ts")).toBe(initial);
    expect(git("diff", "--", "fixture.ts")).toContain("+export const value=1");
  });
  it("rejects a staged Nostr key hidden by unstaged removal and redacts the value", async () => {
    const { directory, git, commit } = await fixture();
    const secret = randomBytes(32).toString("hex");
    await writeFile(
      resolve(directory, "fixture.ts"),
      `export const NOSTR_PRIVATE_KEY = "${secret}";\n`,
    );
    git("add", "fixture.ts");
    await writeFile(resolve(directory, "fixture.ts"), initial);
    const result = commit();
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("nostr-private-hex");
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
  });
  it("scans non-ignored untracked source before the first source commit", async () => {
    const { directory } = await fixture();
    const secret = randomBytes(32).toString("hex");
    await writeFile(resolve(directory, "untracked.env.txt"), `NOSTR_PRIVATE_KEY=${secret}\n`);
    const result = spawnSync(process.execPath, [resolve(directory, "scripts/check-secrets.mjs")], {
      cwd: directory,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("untracked.env.txt");
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
  });
  it("rejects a deletion-only commit when an imported TypeScript module is removed", async () => {
    const { directory, git, commit } = await fixture();
    await writeFile(resolve(directory, "fixture.ts"), 'export { value } from "./module";\n');
    await writeFile(resolve(directory, "module.ts"), initial);
    git("add", "fixture.ts", "module.ts");
    const first = commit();
    expect(first.status, first.stderr).toBe(0);
    await rm(resolve(directory, "module.ts"));
    git("add", "--update");
    const result = commit();
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("TS2307");
  });
  it("scans a source symlink as text without reading a file outside the repository", async () => {
    const { directory, git } = await fixture();
    const external = await mkdtemp(join(tmpdir(), "nostrbase-external-fixture-"));
    directories.push(external);
    const secret = randomBytes(32).toString("hex");
    await writeFile(resolve(external, "key.txt"), `NOSTR_PRIVATE_KEY=${secret}\n`);
    await symlink(resolve(external, "key.txt"), resolve(directory, "linked.txt"));
    const result = spawnSync(process.execPath, [resolve(directory, "scripts/check-secrets.mjs")], {
      cwd: directory,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
    await mkdir(resolve(directory, "folder"));
    await writeFile(resolve(directory, "folder/key.txt"), "development fixture\n");
    git("add", "folder/key.txt");
    await rm(resolve(directory, "folder"), { recursive: true });
    await symlink(external, resolve(directory, "folder"), "dir");
    const escaped = spawnSync(process.execPath, [resolve(directory, "scripts/check-secrets.mjs")], {
      cwd: directory,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(escaped.error).toBeUndefined();
    expect(escaped.status).not.toBe(0);
    expect(escaped.stderr).toContain("escapes the repository");
    expect(`${escaped.stdout}${escaped.stderr}`).not.toContain(secret);
  });
});
