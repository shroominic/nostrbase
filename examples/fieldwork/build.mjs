import { mkdir, copyFile } from "node:fs/promises";
import { build } from "esbuild";

await mkdir(new URL("dist", import.meta.url), { recursive: true });
await build({
  absWorkingDir: import.meta.dirname,
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["chrome120", "firefox120", "safari17.4"],
  sourcemap: true,
  outdir: "dist",
});
await copyFile(new URL("index.html", import.meta.url), new URL("dist/index.html", import.meta.url));
