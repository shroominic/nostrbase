import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dirname, "../..");
const temp = await mkdtemp(resolve(tmpdir(), "nostrbase-doc-examples-"));
const formatHost = {
  getCanonicalFileName: (path) => path,
  getCurrentDirectory: () => root,
  getNewLine: () => "\n",
};
let snippets = 0;
try {
  const sources = [];
  for (const file of await readdir(resolve(root, "docs/guides")))
    sources.push({
      file: `docs/guides/${file}`,
      text: await readFile(resolve(root, "docs/guides", file), "utf8"),
    });
  for (const file of [
    "api.md",
    "realtime.md",
    "offline-sync.md",
    "private-storage.md",
    "tooling.md",
    "groups.md",
    "key-backup.md",
    "queries.md",
    "automatic-replay.md",
    "images.md",
  ])
    sources.push({
      file: `docs/${file}`,
      text: await readFile(resolve(root, "docs", file), "utf8"),
    });
  for (const source of sources) {
    for (const match of source.text.matchAll(/```(ts|tsx|js)\n([\s\S]*?)```/g)) {
      const parsed = ts.createSourceFile(
        `${source.file}.${match[1]}`,
        match[2],
        ts.ScriptTarget.Latest,
        true,
        match[1] === "tsx"
          ? ts.ScriptKind.TSX
          : match[1] === "js"
            ? ts.ScriptKind.JS
            : ts.ScriptKind.TS,
      );
      if (parsed.parseDiagnostics.length)
        throw new Error(
          ts.formatDiagnosticsWithColorAndContext(parsed.parseDiagnostics, formatHost),
        );
      snippets++;
    }
  }
  const entrypoints = [];
  for (const slug of ["quickstart", "browser", "react", "node"]) {
    const markdown = await readFile(resolve(root, "docs/guides", `${slug}.md`), "utf8");
    const code = [...markdown.matchAll(/```(?:ts|tsx|js)\n([\s\S]*?)```/g)]
      .map((match) => match[1])
      .join("\n");
    const file = resolve(
      temp,
      `${slug}.${slug === "react" ? "tsx" : slug === "node" ? "js" : "ts"}`,
    );
    await writeFile(file, code);
    entrypoints.push(file);
  }
  const program = ts.createProgram(entrypoints, {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    allowJs: true,
    checkJs: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    types: ["node"],
    typeRoots: [resolve(root, "node_modules/@types"), resolve(root, "site/node_modules/@types")],
    paths: {
      nostrbase: [resolve(root, "dist/index.d.ts")],
      "nostrbase/node": [resolve(root, "dist/node.d.ts")],
      react: [resolve(root, "site/node_modules/@types/react/index.d.ts")],
      "react/jsx-runtime": [resolve(root, "site/node_modules/@types/react/jsx-runtime.d.ts")],
    },
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length)
    throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, formatHost));
  console.log(
    `Verified syntax of ${snippets} guide snippets and SDK types for 4 complete quickstarts.`,
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
