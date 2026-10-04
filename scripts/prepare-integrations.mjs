import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const steps = [
  ["Pinned relay images", "integration/relay/prepare.mjs"],
  ["Pinned Blossom server", "integration/blossom/setup.mjs"],
  [
    "Browser engines",
    "node_modules/@playwright/test/cli.js",
    "install",
    "chromium",
    "firefox",
    "webkit",
  ],
  ["Pinned NIP-07 extension", "integration/extension/setup.mjs"],
];

for (const [label, ...args] of steps) {
  process.stdout.write(`\nPrepare: ${label}\n`);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} preparation failed (${signal ?? code}).`));
    });
  });
}
