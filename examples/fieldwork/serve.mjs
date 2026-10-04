import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const root = new URL("dist/", import.meta.url);
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".map": "application/json",
};
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, "http://localhost").pathname;
    const file = new URL(path === "/" ? "index.html" : `.${path}`, root);
    if (!file.href.startsWith(root.href)) throw new Error("Invalid path");
    const body = await readFile(file);
    response.writeHead(200, {
      "Content-Type":
        types[file.pathname.slice(file.pathname.lastIndexOf("."))] ?? "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
});
server.listen(Number(process.env.FIELDWORK_PORT ?? 4173), "127.0.0.1", () => {
  console.log(`Fieldwork: http://127.0.0.1:${server.address().port}`);
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close());
