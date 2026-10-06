import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { required } from "./support/lifecycle";

describe("published package boundary", () => {
  it("packs usable ESM and declarations, then type-checks and runs a separate consumer", async () => {
    const root = resolve(import.meta.dirname, "..");
    const directory = await mkdtemp(join(tmpdir(), "nostrbase-package-test-"));
    const run = (program: string, args: string[], cwd = root) =>
      execFileSync(program, args, { cwd, encoding: "utf8", timeout: 30000, stdio: "pipe" });
    try {
      run(process.execPath, [join(root, "node_modules/tsup/dist/cli-default.js")]);
      const pack = JSON.parse(
        run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory]),
      ) as { filename: string; files: { path: string }[] }[];
      const packed = required(pack[0], "npm pack result");
      const paths = packed.files.map((file) => file.path);
      expect(paths).toContain("dist/index.js");
      expect(paths).toContain("dist/index.d.ts");
      expect(paths).toContain("dist/node.js");
      expect(paths).toContain("dist/node.d.ts");
      expect(paths.some((path) => path.startsWith("src/") || path.startsWith("tests/"))).toBe(
        false,
      );
      expect(paths).toContain(
        "node_modules/@internet-privacy/marmot-ts/dist/client/session/group-session.js",
      );
      expect(paths).toContain("vendor/patches/marmot-ingress-durability.patch");
      const consumer = join(directory, "consumer");
      const modules = join(consumer, "node_modules");
      const installed = join(modules, "nostrbase");
      await mkdir(installed, { recursive: true });
      run("tar", [
        "-xzf",
        join(directory, packed.filename),
        "--strip-components=1",
        "-C",
        installed,
      ]);
      const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
        dependencies: Record<string, string>;
        bundledDependencies: string[];
      };
      // Only dependencies are linked. The consumer imports the unpacked archive, never source paths.
      for (const name of Object.keys(manifest.dependencies))
        if (!manifest.bundledDependencies.includes(name)) {
          await mkdir(dirname(join(modules, name)), { recursive: true });
          await symlink(join(root, "node_modules", name), join(modules, name), "dir");
        }
      await mkdir(join(modules, "@types"));
      await symlink(join(root, "node_modules/@types/node"), join(modules, "@types/node"), "dir");
      await writeFile(join(consumer, "package.json"), JSON.stringify({ type: "module" }));
      await writeFile(
        join(consumer, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            skipLibCheck: true,
            outDir: "out",
          },
          include: ["consumer.ts"],
        }),
      );
      await writeFile(
        join(consumer, "consumer.ts"),
        `
import assert from "node:assert/strict";
import * as sdk from "nostrbase";
import type { InferDatabase, Result, Row } from "nostrbase";
import { z } from "zod";
import { Observable } from "rxjs";
const schema = sdk.defineSchema({ todos: sdk.zodTable(z.object({ title: z.string(), done: z.boolean() })) });
type DB = InferDatabase<typeof schema>;
let wireCalls = 0;
const client = sdk.createClient<DB>({ namespace: "consumer", relays: ["wss://unused.test"], schema,
 signer: new sdk.PrivateKeySigner(new Uint8Array(32).fill(3)),
 transport: {
  request: async () => { wireCalls++; throw new Error("Unexpected network read"); },
  publish: async () => { wireCalls++; throw new Error("Unexpected network write"); },
  subscribe: () => new Observable(() => () => {}),
 }
});
function invalidTypes() {
 // @ts-expect-error unknown table
 client.from("unknown");
 // @ts-expect-error wrong boolean type
 client.from("todos").inGroup("0".repeat(64)).eq("done", "false");
 // @ts-expect-error required field missing
 client.private.from("todos").insert({ title: "incomplete" });
 // @ts-expect-error unknown projection
 client.from("todos").inGroup("0".repeat(64)).select("id, missing");
}
const inserted = await client.from("todos").insert({ id: "a", title: "public", done: false }).queue().select().single();
assert.equal(inserted.error, null);
assert.equal(inserted.data?.title, "public");
const selected: Result<Pick<Row<DB["todos"]>, "id" | "title"> | null> = await client.from("todos").local().select("id, title").maybeSingle();
assert.deepEqual(selected.data, { id: "a", title: "public" });
const rich = await client.from("todos").local().or("title.ilike.pub%,done.eq.true")
 .not("id", "in", "(missing)").select("*", { count: "exact", head: true });
assert.equal(rich.error, null);
assert.equal(rich.count, 1);
assert.deepEqual(rich.data, []);
const backup = await client.auth.exportKey("consumer password", { logn: 10 });
assert.equal(backup.error, null);
assert.ok(backup.data?.startsWith("ncryptsec1"));
assert.equal((await client.auth.signInWithEncryptedKey(backup.data!, "consumer password")).error, null);
client.offline.startAutoReplay({ initial: false });
assert.equal(client.offline.autoReplayStatus.running, true);
client.offline.stopAutoReplay();
const encrypted = await client.private.from("todos").insert({ id: "b", title: "secret", done: false }).queue().select().single();
assert.equal(encrypted.error, null);
assert.equal((await client.private.from("todos").local().single()).data?.title, "secret");
const created: Result<sdk.NostrbaseGroup<DB>> = await client.groups.create({ name: "Consumer group" });
assert.equal(created.error, null);
assert.ok(created.data);
const group = created.data;
const reopened = await client.groups.get(group.id);
assert.equal(reopened.error, null);
assert.equal(reopened.data?.id, group.id);
const groups = await client.groups.list();
assert.equal(groups.error, null);
assert.equal(groups.count, 1);
assert.equal(groups.data?.[0]?.id, group.id);
const groupInsert: Result<Pick<Row<DB["todos"]>, "id" | "title"> | null> = await client.from("todos").inGroup(group.id)
 .insert({ id: "group", title: "GROUP-SECRET", done: false }).queue().local().select("id, title").single();
assert.equal(groupInsert.error, null);
assert.deepEqual(groupInsert.data, { id: "group", title: "GROUP-SECRET" });
assert.equal(groupInsert.meta?.receipts?.[0]?.queued, true);
const groupLocal = await client.from("todos").inGroup(group.id).local();
assert.equal(groupLocal.error, null);
assert.deepEqual(groupLocal.data, []);
const invalidGroup = await client.groups.get("invalid");
assert.equal(invalidGroup.error?.code, "INVALID_QUERY");
const missingGroup = await client.from("todos").inGroup("0".repeat(64)).local();
assert.equal(missingGroup.error?.code, "NOT_FOUND");
assert.equal(JSON.stringify((await client.backup.export()).data).includes("secret"), false);
assert.equal((await client.offline.list()).length, 2);
assert.equal(wireCalls, 0);
await client.closeAsync();
console.log(JSON.stringify(Object.keys(sdk).sort()));
`,
      );
      run(
        process.execPath,
        [
          join(root, "node_modules/typescript/bin/tsc"),
          "--project",
          join(consumer, "tsconfig.json"),
        ],
        consumer,
      );
      const exports = JSON.parse(
        run(process.execPath, [join(consumer, "out/consumer.js")], consumer),
      ) as string[];
      expect(exports).toEqual(
        [
          "ApplesauceTransport",
          "CanvasImageProcessor",
          "decryptKey",
          "encryptKey",
          "EventStore",
          "ExtensionSigner",
          "IndexedDBPersistenceAdapter",
          "IndexedDBGroupStateAdapter",
          "IndexedDBStorageUploadQueueAdapter",
          "MemoryPersistenceAdapter",
          "MemoryGroupStateAdapter",
          "MemoryStorageUploadQueueAdapter",
          "NostrConnectSigner",
          "NostrbaseAuth",
          "NostrbaseBackup",
          "NostrbaseChannel",
          "NostrbaseClient",
          "NostrbaseDashboard",
          "NostrbaseDiagnostics",
          "NostrbaseError",
          "NostrbaseEvents",
          "NostrbaseGroup",
          "NostrbaseGroups",
          "NostrbaseMigrations",
          "NostrbaseOffline",
          "NostrbasePersistence",
          "NostrbasePrivateTables",
          "NostrbaseRelations",
          "NostrbaseStorage",
          "NostrbaseSync",
          "PROTOCOL_VERSION",
          "PrivateKeySigner",
          "QueryBuilder",
          "REALTIME_KIND",
          "RECORD_KIND",
          "RelayPool",
          "belongsToNamespace",
          "createClient",
          "defineSchema",
          "defineTable",
          "exportGroupStateBackup",
          "importGroupStateBackup",
          "recordIdentifier",
          "reference",
          "scopeTag",
          "zodTable",
        ].sort(),
      );
      // Exercise browser module resolution against the same unpacked archive.
      const browserEntry = join(consumer, "browser.ts");
      await writeFile(browserEntry, 'export * from "nostrbase";');
      run(
        join(root, "node_modules/.bin/esbuild"),
        [
          browserEntry,
          "--bundle",
          "--platform=browser",
          "--format=esm",
          "--target=es2022",
          `--outfile=${join(consumer, "browser.js")}`,
        ],
        consumer,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);
});
