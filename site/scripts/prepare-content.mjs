import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";
import { format } from "prettier";
import { protocolDiagram } from "./protocol-diagram.mjs";

const root = resolve(import.meta.dirname, "../..");
const site = resolve(root, "site");
const catalog = JSON.parse(await readFile(resolve(site, "src/catalog.json"), "utf8"));
const output = resolve(site, "src/content/docs");
const rawOutput = resolve(site, "public/content");
await mkdir(output, { recursive: true });
await mkdir(rawOutput, { recursive: true });
async function writeChanged(path, content) {
  let previous;
  try {
    previous = await readFile(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (previous === content) return;
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, path);
}
const documents = [];
const sourceExports = new Map();
const sourceRoutes = new Map(
  [...catalog.groups.flatMap((group) => group.items), ...(catalog.support ?? [])]
    .filter((entry) => !entry.section)
    .map((entry) => [resolve(root, entry.source), `/docs/${entry.slug}/`]),
);
sourceRoutes.set(resolve(root, "CONTRIBUTING.md"), "/docs/contributing/");
sourceRoutes.set(resolve(root, "README.md"), "/");
const linkMap = {
  "integration/README.md": "/docs/environment-integration/",
  "../integration/README.md": "/docs/environment-integration/",
  "testing.md": "/docs/testing/",
  "docs/testing.md": "/docs/testing/",
  "docs/README.md": "/",
  "api.md": "/docs/quickstart/",
  "realtime.md": "/docs/live-changes/",
  "offline-sync.md": "/docs/persistence/",
  "private-storage.md": "/docs/private-tables/",
  "tooling.md": "/docs/schemas/",
  "protocol.md": "/docs/protocol/",
  "verification.md": "/docs/verification/",
  "../CONTRIBUTING.md": "/docs/contributing/",
  "../CHANGELOG.md": "/docs/changelog/",
  "../README.md": "/",
  "../examples/README.md": "/docs/browser/",
};
function rewriteLinks(body, source) {
  return body.replace(/\]\(([^)]+)\)/g, (full, target) => {
    if (/^(?:[a-zA-Z][\w+.-]*:|\/|#)/.test(target)) return full;
    const [file, fragment] = target.split("#");
    const resolved = resolve(root, dirname(source), file);
    const route = sourceRoutes.get(resolved);
    if (route) return `](${route}${fragment ? `#${fragment}` : ""})`;
    if (linkMap[file]) return `](${linkMap[file]})`;
    if (!resolved.startsWith(`${root}/`))
      throw new Error(`Link escapes repository: ${source} → ${target}`);
    const local = relative(root, resolved);
    if (/\.(?:ya?ml|json|ts|mjs)$/.test(local) && !/^(?:output|node_modules|\.git)\//.test(local)) {
      sourceExports.set(resolved, local);
      return `](/source/${local})`;
    }
    return full;
  });
}
async function save(slug, title, description, group, source, body, reference = false) {
  body = rewriteLinks(body, source).trim();
  if (reference) {
    for (const match of body.matchAll(/```ts\n([\s\S]*?)\n```/g)) {
      let formatted;
      try {
        formatted = await format(match[1], { parser: "typescript", printWidth: 86 });
      } catch {
        const wrapped = await format(`declare class Signature {\n${match[1]}\n}`, {
          parser: "typescript",
          printWidth: 88,
        });
        formatted = wrapped
          .slice(wrapped.indexOf("{") + 1, wrapped.lastIndexOf("}"))
          .replace(/^ {2}/gm, "");
      }
      body = body.replace(match[0], `\`\`\`ts\n${formatted.trim()}\n\`\`\``);
    }
  }
  const metadata = { title, description, group, source, reference };
  const frontmatter = Object.entries(metadata)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join("\n");
  const path = resolve(output, `${slug}.md`);
  const rawPath = resolve(rawOutput, `${slug}.md`);
  await mkdir(dirname(path), { recursive: true });
  await mkdir(dirname(rawPath), { recursive: true });
  const displayBody =
    slug === "protocol" ? body.replace(/```mermaid[\s\S]*?```/g, protocolDiagram) : body;
  await writeChanged(path, `---\n${frontmatter}\n---\n\n${displayBody}\n`);
  const markdown = `# ${title}\n\n${description}\n\n${body}\n`;
  await writeChanged(rawPath, markdown);
  documents.push({ slug, title, description, markdown });
}
function getSection(markdown, heading) {
  const lines = markdown.split("\n");
  const start = lines.indexOf(`## ${heading}`);
  if (start < 0) throw new Error(`Missing section: ${heading}`);
  let end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join("\n");
}
for (const entry of catalog.support ?? []) {
  const markdown = await readFile(resolve(root, entry.source), "utf8");
  await save(
    entry.slug,
    entry.title,
    entry.description,
    "Engineering",
    entry.source,
    markdown.replace(/^# [^\n]+\n+/, ""),
  );
}
for (const group of catalog.groups) {
  for (const entry of group.items) {
    const markdown = await readFile(resolve(root, entry.source), "utf8");
    let body = entry.section
      ? getSection(markdown, entry.section)
      : markdown.replace(/^# [^\n]+\n+/, "");
    if (entry.source.startsWith("docs/guides/")) body = body.replace(/^[^\n]+\n+/, "");
    if (!entry.section && body.startsWith(`${entry.description}\n`))
      body = body.slice(entry.description.length).trim();
    if (entry.section) {
      const headings = {
        authentication: "Choose a signer",
        "live-changes": "Subscribe to changes",
        pagination: "Read a page",
        schemas: "Validate records",
        search: "Find records and events",
        references: "Resolve a reference",
        "private-tables": "Encrypt a personal record",
        broadcast: "Send and receive",
        presence: "Track a session",
        storage: "Store and retrieve files",
        persistence: "Configure persistence",
        "offline-writes": "Sign and queue a write",
        synchronization: "Pull missing events",
        "native-events": "Work with standard kinds",
        migrations: "Preview and apply",
        backups: "Export and import",
        diagnostics: "Inspect the log",
        dashboard: "Inspect local state",
      };
      body = `## ${headings[entry.slug] ?? "Usage"}\n\n${body}`;
    }
    if (["broadcast", "presence"].includes(entry.slug)) {
      const realtime = await readFile(resolve(root, "docs/realtime.md"), "utf8");
      body += `\n\n## Delivery and privacy\n\n${getSection(realtime, "Limits")}`;
    }
    if (entry.slug === "synchronization") {
      const sync = await readFile(resolve(root, "docs/offline-sync.md"), "utf8");
      body += `\n\n## Subscriptions and reconnects\n\n${getSection(sync, "Live subscriptions and recovery")}`;
    }
    await save(entry.slug, entry.title, entry.description, group.title, entry.source, body);
  }
}
await save(
  "contributing",
  "Contributing",
  "Build, verify, and maintain the SDK and its documentation.",
  "Reference and help",
  "CONTRIBUTING.md",
  (await readFile(resolve(root, "CONTRIBUTING.md"), "utf8")).replace(/^# [^\n]+\n+/, ""),
);

// tsup can move types shared by the browser and Node entries into a declaration chunk.
// Include every emitted declaration so the reference covers both public entries.
const declarationFiles = (await readdir(resolve(root, "dist"))).filter((file) =>
  file.endsWith(".d.ts"),
);
const declarationText = (
  await Promise.all(declarationFiles.map((file) => readFile(resolve(root, "dist", file), "utf8")))
).join("\n");
const declarationFile = ts.createSourceFile(
  "index.d.ts",
  declarationText,
  ts.ScriptTarget.Latest,
  true,
);
const exported = new Set();
for (const statement of declarationFile.statements) {
  if (
    ts.isExportDeclaration(statement) &&
    !statement.moduleSpecifier &&
    statement.exportClause &&
    ts.isNamedExports(statement.exportClause)
  ) {
    for (const item of statement.exportClause.elements)
      exported.add(item.propertyName?.text ?? item.name.text);
  }
}
const declarations = new Map();
for (const statement of declarationFile.statements) {
  if (statement.name && ts.isIdentifier(statement.name))
    declarations.set(statement.name.text, statement);
  if (ts.isVariableStatement(statement)) {
    for (const item of statement.declarationList.declarations) {
      if (ts.isIdentifier(item.name)) declarations.set(item.name.text, statement);
    }
  }
}
const owners = new Map();
for (const file of await readdir(resolve(root, "src"))) {
  if (!file.endsWith(".ts")) continue;
  const sourceText = await readFile(resolve(root, "src", file), "utf8");
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
  for (const statement of sourceFile.statements) {
    if (statement.name && ts.isIdentifier(statement.name))
      owners.set(statement.name.text, `src/${file}`);
    if (ts.isVariableStatement(statement)) {
      for (const item of statement.declarationList.declarations) {
        if (ts.isIdentifier(item.name)) owners.set(item.name.text, `src/${file}`);
      }
    }
  }
}
const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
const print = (node) => printer.printNode(ts.EmitHint.Unspecified, node, declarationFile).trim();
const fence = (code) => `\n\n\`\`\`ts\n${code}\n\`\`\`\n`;
function declarationMarkdown(name, node, level = 2) {
  let body = `${"#".repeat(level)} ${name}\n`;
  if (!ts.isClassDeclaration(node)) return body + fence(print(node));
  const header = ts.factory.updateClassDeclaration(
    node,
    node.modifiers,
    node.name,
    node.typeParameters,
    node.heritageClauses,
    [],
  );
  body += fence(print(header));
  const members = node.members.filter(
    (member) =>
      !member.modifiers?.some(
        (modifier) =>
          modifier.kind === ts.SyntaxKind.PrivateKeyword ||
          modifier.kind === ts.SyntaxKind.ProtectedKeyword,
      ),
  );
  const properties = members.filter(
    (member) => ts.isPropertyDeclaration(member) || ts.isGetAccessorDeclaration(member),
  );
  if (properties.length) body += `\n### Properties\n${fence(properties.map(print).join("\n"))}`;
  const methods = new Map();
  for (const member of members.filter((item) => !properties.includes(item))) {
    const memberName = ts.isConstructorDeclaration(member)
      ? "constructor"
      : (member.name?.getText(declarationFile) ?? "signature");
    const existing = methods.get(memberName) ?? [];
    existing.push(member);
    methods.set(memberName, existing);
  }
  for (const [methodName, nodes] of methods)
    body += `\n### ${methodName}\n${fence(nodes.map(print).join("\n\n"))}`;
  return body;
}
const documentedExports = new Set();
for (const entry of catalog.reference) {
  let body = `[Read the ${
    catalog.groups
      .flatMap((group) => group.items)
      .find((item) => item.slug === entry.guide)
      ?.title.toLowerCase() ?? entry.guide
  } guide](/docs/${entry.guide}/). Signatures below come from the published SDK declarations. Access SDK services through \`db\`; use their constructors only when integrating at a lower level.\n\n`;
  const primary = [...declarations].filter(
    ([name]) => exported.has(name) && owners.get(name) === entry.module,
  );
  const supporting = [...declarations].filter(
    ([name]) => !exported.has(name) && owners.get(name) === entry.module,
  );
  for (const [name, node] of primary) {
    body += `${declarationMarkdown(name, node)}\n`;
    documentedExports.add(name);
  }
  if (supporting.length) {
    body +=
      "\n## Supporting declarations\n\nThese types appear in public signatures but are not package exports.\n\n";
    for (const [name, node] of supporting) body += `${declarationMarkdown(name, node, 3)}\n`;
  }
  await save(
    entry.slug,
    entry.title,
    entry.description,
    "TypeScript API",
    entry.module,
    body,
    true,
  );
}
const missing = [...exported].filter((name) => !documentedExports.has(name));
if (missing.length) throw new Error(`Undocumented exports: ${missing.join(", ")}`);
await save(
  "reference/applesauce",
  "Applesauce exports",
  "Signer, pool, and event-store exports from Applesauce.",
  "TypeScript API",
  "src/index.ts",
  `## Re-exported classes\n\nnostrbase re-exports these classes unchanged:\n\n| Export | Package | Purpose |\n| --- | --- | --- |\n| \`EventStore\` | applesauce-core | Verified event cache |\n| \`RelayPool\` | applesauce-relay | Relay connections |\n| \`ExtensionSigner\` | applesauce-signers | Browser NIP-07 signer |\n| \`PrivateKeySigner\` | applesauce-signers | Local private-key signer |\n| \`NostrConnectSigner\` | applesauce-signers | NIP-46 remote signer |\n\n[Applesauce documentation](https://applesauce.hzrd149.com/). See [signer setup](/docs/authentication/) and [client integration](/docs/client/).\n\n## Nostr event types\n\n\`NostrEvent\`, \`EventTemplate\`, and \`Filter\` are re-exported from nostr-tools. \`Signer\` aliases the Applesauce \`ISigner\` interface. Use [native event operations](/docs/native-events/) for protocol-specific records.`,
  true,
);
const llms = `# nostrbase\n\n> A Supabase-style TypeScript SDK over Nostr, built on Applesauce. SDK 0.2.0; ESM; Node 22.12+ and modern browsers. Not published to npm.\n\n## Documentation\n\n${documents.map((doc) => `- [${doc.title}](/content/${doc.slug}.md): ${doc.description}`).join("\n")}\n\n## Complete text\n\n- [All documentation](/llms-full.txt)\n`;
await writeChanged(resolve(site, "public/llms.txt"), llms);
await writeChanged(
  resolve(site, "public/llms-full.txt"),
  documents.map((doc) => `${doc.markdown}\nSource: /docs/${doc.slug}/\n`).join("\n---\n\n"),
);
console.log(
  `Prepared ${documents.length} pages; covered ${documentedExports.size} local exports and 8 external exports.`,
);

const expected = new Set(documents.map((document) => `${document.slug}.md`));
const exportedSources = resolve(site, "public/source");
await rm(exportedSources, { recursive: true, force: true });
for (const [source, path] of sourceExports) {
  const destination = resolve(exportedSources, path);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}
for (const directory of [output, rawOutput]) {
  for (const file of await readdir(directory, { recursive: true })) {
    if (file.endsWith(".md") && !expected.has(file)) await rm(resolve(directory, file));
  }
}
