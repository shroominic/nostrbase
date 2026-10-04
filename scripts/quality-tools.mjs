import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export const root = resolve(import.meta.dirname, "..");
const tools = JSON.parse(
  await readFile(resolve(import.meta.dirname, "quality-tools.json"), "utf8"),
);
const platform = `${process.platform}-${process.arch}`;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function qualityTool(name) {
  const tool = tools[name];
  if (!tool?.platforms[platform])
    throw new Error(`Quality tools support macOS/Linux on arm64/x64; unsupported: ${platform}.`);
  return resolve(root, "output/quality-tools", `${name}-${tool.version}`, platform, name);
}
export async function requireQualityTool(name) {
  const binary = qualityTool(name);
  try {
    await access(binary);
  } catch {
    throw new Error(`Missing ${name}. Run npm run prepare:quality first.`);
  }
  return binary;
}
export async function prepareQualityTools() {
  for (const [name, tool] of Object.entries(tools)) {
    const binary = qualityTool(name);
    const directory = resolve(binary, "..");
    const [suffix, expected] = tool.platforms[platform];
    const asset = `${name}_${tool.version}_${suffix}.tar.gz`;
    const archive = resolve(directory, asset);
    await mkdir(directory, { recursive: true });
    let bytes;
    try {
      bytes = await readFile(archive);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const url = `https://github.com/${tool.repository}/releases/download/v${tool.version}/${asset}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`${name} download failed: HTTP ${response.status}.`);
      bytes = Buffer.from(await response.arrayBuffer());
    }
    if (hash(bytes) !== expected)
      throw new Error(`${name} archive checksum does not match the pin.`);
    await writeFile(archive, bytes);
    execFileSync("tar", ["-xzf", archive, "-C", directory, name], { stdio: "inherit" });
    await chmod(binary, 0o755);
    console.log(`Prepared ${name} ${tool.version}: verified SHA-256.`);
  }
}
