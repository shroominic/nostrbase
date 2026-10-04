import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
export const localNak = join(root, "output/fieldwork/nak");
// Official release asset digests from fiatjaf/nak v0.20.7.
const digests = {
  "darwin-arm64": "8feb1d1003f1afb3e0416e49bc737742eaacd7d679b5eb203613e070d98e5647",
  "darwin-amd64": "74ebeb3f681a145d39e2bf70e4468c3d8e994a1a94ef1494b229b1bc53539768",
  "linux-arm64": "917b19813f2f27ca6bc937d151652953ceeea2c18cd2610f6d1a9bf3e7161634",
  "linux-amd64": "ba918fafd1b030bc50958a5b218c6386f4c3a57c1e469562d3947e858e0ba56e",
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const isPinnedNakVersion = (version) => /^nak version v?0\.20\.7$/.test(version.trim());
export async function prepareNak() {
  try {
    if (
      isPinnedNakVersion(
        execFileSync(process.env.FIELDWORK_NAK ?? "nak", ["--version"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }),
      )
    )
      return;
  } catch {
    /* Use the verified local release when no matching binary is installed. */
  }
  const platform = `${process.platform}-${process.arch === "x64" ? "amd64" : process.arch}`;
  const expected = digests[platform];
  if (!expected)
    throw new Error("Use nak 0.20.7 on this platform and set FIELDWORK_NAK to its path.");
  try {
    if (digest(await readFile(localNak)) === expected) return;
  } catch {
    /* Download missing asset. */
  }
  console.log(`Download nak 0.20.7 (${platform}) to output/fieldwork; verify SHA-256.`);
  const response = await fetch(
    `https://github.com/fiatjaf/nak/releases/download/v0.20.7/nak-v0.20.7-${platform}`,
    { signal: AbortSignal.timeout(30000) },
  );
  if (!response.ok) throw new Error(`nak download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (digest(bytes) !== expected)
    throw new Error("nak release SHA-256 does not match the pinned digest.");
  await mkdir(resolve(localNak, ".."), { recursive: true });
  await writeFile(localNak, bytes);
  await chmod(localNak, 0o755);
}
