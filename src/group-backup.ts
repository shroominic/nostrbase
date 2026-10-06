import { NostrbaseError } from "./errors";
import type { GroupStateAdapter } from "./group-store";

export interface GroupStateBackupEntry {
  key: string;
  value: string;
}

export interface GroupStateBackup {
  format: "nostrbase-group-state";
  version: 1;
  namespace: string;
  account: string;
  device: string;
  entries: GroupStateBackupEntry[];
  checksum: string;
}

export interface GroupStateBackupImport {
  imported: number;
  skipped: number;
}

const prefix = (namespace: string, account: string, device: string): string =>
  `nostrbase-group:v1:${[namespace, account, device].map(encodeURIComponent).join(":")}:`;

function canonicalEntries(entries: readonly GroupStateBackupEntry[]): string {
  return JSON.stringify([...entries].sort((a, b) => a.key.localeCompare(b.key)));
}

async function checksum(entries: readonly GroupStateBackupEntry[]): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalEntries(entries))),
  );
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function validateIdentity(namespace: string, account: string, device: string): void {
  if (
    typeof namespace !== "string" ||
    !namespace.trim() ||
    namespace.length > 256 ||
    !/^[0-9a-f]{64}$/.test(account) ||
    !/^[0-9a-f]{64}$/.test(device)
  )
    throw new NostrbaseError("INVALID_RECORD", "Group state backup identity is invalid.");
}

/** Export encrypted Marmot state without exposing plaintext MLS material. */
export async function exportGroupStateBackup(
  adapter: GroupStateAdapter,
  namespace: string,
  account: string,
  device: string,
): Promise<GroupStateBackup> {
  validateIdentity(namespace, account, device);
  const scope = prefix(namespace, account, device);
  const entries: GroupStateBackupEntry[] = [];
  for (const key of await adapter.keys()) {
    if (!key.startsWith(scope)) continue;
    const value = await adapter.get(key);
    if (value !== null) entries.push({ key, value });
  }
  return {
    format: "nostrbase-group-state",
    version: 1,
    namespace,
    account,
    device,
    entries,
    checksum: await checksum(entries),
  };
}

/** Import encrypted state for the same account, namespace, and stable device ID. */
export async function importGroupStateBackup(
  adapter: GroupStateAdapter,
  archive: GroupStateBackup | string,
  namespace: string,
  account: string,
  device: string,
): Promise<GroupStateBackupImport> {
  validateIdentity(namespace, account, device);
  let parsed: GroupStateBackup;
  try {
    parsed = typeof archive === "string" ? (JSON.parse(archive) as GroupStateBackup) : archive;
  } catch {
    throw new NostrbaseError("INVALID_RECORD", "Group state backup is not valid JSON.");
  }
  if (
    parsed?.format !== "nostrbase-group-state" ||
    parsed.version !== 1 ||
    parsed.namespace !== namespace ||
    parsed.account !== account ||
    parsed.device !== device ||
    !Array.isArray(parsed.entries) ||
    parsed.entries.length > 100_000 ||
    typeof parsed.checksum !== "string"
  )
    throw new NostrbaseError("INVALID_RECORD", "Group state backup does not match this device.");
  const scope = prefix(namespace, account, device);
  const entries = parsed.entries.map((entry) => {
    if (
      !entry ||
      typeof entry.key !== "string" ||
      !entry.key.startsWith(scope) ||
      typeof entry.value !== "string" ||
      entry.value.length === 0 ||
      entry.value.length > 10_000_000
    )
      throw new NostrbaseError("INVALID_RECORD", "Group state backup contains invalid ciphertext.");
    return { key: entry.key, value: entry.value };
  });
  if (new Set(entries.map((entry) => entry.key)).size !== entries.length)
    throw new NostrbaseError("INVALID_RECORD", "Group state backup contains duplicate keys.");
  if ((await checksum(entries)) !== parsed.checksum)
    throw new NostrbaseError("INVALID_RECORD", "Group state backup checksum is invalid.");
  let imported = 0;
  for (const entry of entries) {
    await adapter.set(entry.key, entry.value);
    imported++;
  }
  return { imported, skipped: 0 };
}
