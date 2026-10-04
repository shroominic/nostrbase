import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { requireQualityTool, root } from "./quality-tools.mjs";

const files = (await readdir(resolve(root, ".github/workflows")))
  .filter((file) => /\.ya?ml$/.test(file))
  .map((file) => resolve(root, ".github/workflows", file));
const binary = await requireQualityTool("actionlint");
execFileSync(binary, ["-shellcheck=", "-pyflakes=", ...files], { cwd: root, stdio: "inherit" });
console.log(`Verified ${files.length} workflows with pinned actionlint.`);
