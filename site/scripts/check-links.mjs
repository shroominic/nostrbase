import { readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../dist");
const basePath = (process.env.BASE_PATH ?? "").replace(/\/$/, "");
async function htmlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? htmlFiles(resolve(directory, entry.name))
        : entry.name.endsWith(".html")
          ? [resolve(directory, entry.name)]
          : [],
    ),
  );
  return files.flat();
}
const files = await htmlFiles(root);
const errors = [];
let links = 0;
const cache = new Map();
async function read(path) {
  if (!cache.has(path)) cache.set(path, await readFile(path, "utf8"));
  return cache.get(path);
}
const decode = (value) => value.replaceAll("&amp;", "&");
for (const file of files) {
  const html = await read(file);
  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const target = decode(match[1]);
    if (/^(https?:|data:|mailto:|tel:|javascript:)/.test(target)) continue;
    const url = new URL(
      target,
      `https://docs.local/${relative(root, file).replace(/index\.html$/, "")}`,
    );
    let pathname = decodeURIComponent(url.pathname);
    if (basePath && (pathname === basePath || pathname.startsWith(`${basePath}/`)))
      pathname = pathname.slice(basePath.length) || "/";
    let destination = resolve(root, `.${pathname}`);
    if (!destination.startsWith(`${root}/`) && destination !== root)
      throw new Error(`Link escapes build: ${target}`);
    try {
      if ((await stat(destination)).isDirectory()) destination = resolve(destination, "index.html");
      await stat(destination);
      if (url.hash && destination.endsWith(".html")) {
        const fragment = decodeURIComponent(url.hash.slice(1));
        const content = await read(destination);
        if (!content.includes(`id="${fragment}"`)) throw new Error(`Missing fragment: ${fragment}`);
      }
    } catch (error) {
      errors.push(`${relative(root, file)} → ${target}: ${error.message}`);
    }
    links++;
  }
}
const search = JSON.parse(await readFile(resolve(root, "search.json"), "utf8"));
for (const entry of search) {
  const url = new URL(entry.url, "https://docs.local");
  let pathname = decodeURIComponent(url.pathname);
  if (basePath && (pathname === basePath || pathname.startsWith(`${basePath}/`)))
    pathname = pathname.slice(basePath.length) || "/";
  const path = resolve(root, `.${pathname}`, "index.html");
  const html = await read(path);
  if (url.hash && !html.includes(`id="${decodeURIComponent(url.hash.slice(1))}"`))
    errors.push(`search.json → ${entry.url}: missing fragment`);
}
if (errors.length) throw new Error(`Broken links:\n${errors.join("\n")}`);
console.log(
  `Verified ${links} local links/assets across ${files.length} pages and ${search.length} search sections.`,
);
