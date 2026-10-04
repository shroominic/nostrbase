import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");
const watched = [
  resolve(root, "docs"),
  resolve(root, "CHANGELOG.md"),
  resolve(root, "CONTRIBUTING.md"),
  resolve(root, "dist/index.d.ts"),
  resolve(root, "site/src/catalog.json"),
];
export default function contentWatch() {
  return {
    name: "nostrbase-content-watch",
    hooks: {
      "astro:server:setup": ({ server, logger }) => {
        server.watcher.add(watched);
        let timer;
        let chain = Promise.resolve();
        const refresh = (path) => {
          if (!watched.some((target) => path === target || path.startsWith(`${target}/`))) return;
          clearTimeout(timer);
          timer = setTimeout(() => {
            chain = chain.then(async () => {
              try {
                const { stdout } = await execute(
                  process.execPath,
                  [resolve(root, "site/scripts/prepare-content.mjs")],
                  { cwd: resolve(root, "site") },
                );
                logger.info(stdout.trim());
              } catch (error) {
                logger.error(error.message);
              }
            });
          }, 120);
        };
        server.watcher.on("change", refresh);
        server.watcher.on("add", refresh);
        server.httpServer?.once("close", () => {
          clearTimeout(timer);
          server.watcher.off("change", refresh);
          server.watcher.off("add", refresh);
        });
      },
    },
  };
}
