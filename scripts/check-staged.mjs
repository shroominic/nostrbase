import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const changed = execFileSync("git", ["diff", "--cached", "--name-only", "-z"], {
  cwd: root,
  encoding: "utf8",
});
const files = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);
if (changed.length) {
  const snapshot = await mkdtemp(join(tmpdir(), "nostrbase-staged-"));
  try {
    const config = execFileSync("git", ["show", ":biome.json"], { cwd: root });
    await writeFile(resolve(snapshot, "biome.json"), config);
    for (const file of files) {
      const destination = resolve(snapshot, file);
      if (!destination.startsWith(`${snapshot}/`)) throw new Error("Invalid staged path.");
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, execFileSync("git", ["show", `:${file}`], { cwd: root }));
    }
    if (files.length)
      execFileSync(
        resolve(root, "node_modules/.bin/biome"),
        [
          "check",
          "--formatter-enabled=true",
          "--linter-enabled=true",
          "--assist-enabled=false",
          "--files-ignore-unknown=true",
          "--no-errors-on-unmatched",
          ...files,
        ],
        { cwd: snapshot, stdio: "inherit" },
      );
    execFileSync(process.execPath, [resolve(root, "scripts/check-secrets.mjs"), "--staged"], {
      cwd: root,
      stdio: "inherit",
    });
    execFileSync("npm", ["run", "typecheck"], { cwd: root, stdio: "inherit" });
  } finally {
    await rm(snapshot, { recursive: true, force: true });
  }
}
