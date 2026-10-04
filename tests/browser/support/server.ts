import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { WireRelay } from "../../support/relay";

let bundle: Promise<string> | undefined;
function browserBundle(): Promise<string> {
  bundle ??= build({
    entryPoints: [fileURLToPath(new URL("./entry.ts", import.meta.url))],
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    target: "es2022",
    sourcemap: "inline",
    logLevel: "warning",
  }).then((result) => {
    const output = result.outputFiles[0];
    if (!output) throw new Error("Browser SDK bundle was not produced.");
    return output.text;
  });
  return bundle;
}

/** Ephemeral HTTP origin and real WebSocket fixture; reusable by browser/crash/signer projects. */
export async function startBrowserHarness() {
  const script = await browserBundle();
  const relay = await new WireRelay().start();
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (request.url === "/harness.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end(script);
    } else if (request.url === "/relay-url") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ relay: relay.url }));
    } else if (request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Nostrbase integration harness</title></head><body><h1>Nostrbase browser integration</h1><p id="status">Loading SDK…</p><script type="module" src="/harness.js"></script></body></html>',
      );
    } else {
      response.writeHead(404);
      response.end("Not found");
    }
  });
  server.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
  } catch (error) {
    await relay.close();
    throw error;
  }
  let closed = false;
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    relay,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      server.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
        relay.close(),
      ]);
    },
  };
}
export type BrowserHarness = Awaited<ReturnType<typeof startBrowserHarness>>;
