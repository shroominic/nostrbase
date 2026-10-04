import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { prepareNak } from "./prepare-fieldwork.mjs";

const root = resolve(import.meta.dirname, "..");
const output = join(root, "output/fieldwork");
await mkdir(output, { recursive: true });
await prepareNak();
const run = (program, args, cwd = root) => execFileSync(program, args, { cwd, stdio: "inherit" });
run("npm", ["run", "build"]);
// Avoid recursively running prepack/check. The app test gate runs separately.
const [packed] = JSON.parse(
  execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", output], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }),
);
const archive = `nostrbase-${packed.version}-${packed.shasum}.tgz`;
await copyFile(join(output, packed.filename), join(output, archive));
const app = join(root, "examples/fieldwork");
const manifestPath = join(app, "package.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const dependency = `file:../../output/fieldwork/${archive}`;
const changed = manifest.dependencies.nostrbase !== dependency;
if (changed) {
  manifest.dependencies.nostrbase = dependency;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
const lockExists = await readFile(join(app, "package-lock.json")).then(
  () => true,
  () => false,
);
// Immutable archive paths prevent npm from reusing an old package with the same version.
run(
  "npm",
  [lockExists && !changed ? "ci" : "install", "--ignore-scripts", "--no-audit", "--no-fund"],
  app,
);
run("npm", ["run", "build"], app);
