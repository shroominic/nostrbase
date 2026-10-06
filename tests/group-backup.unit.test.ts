import { describe, expect, it } from "vitest";
import { exportGroupStateBackup, importGroupStateBackup } from "../src/group-backup";
import { MemoryGroupStateAdapter } from "../src/group-store";
import { NostrbaseError } from "../src/errors";

const namespace = "backup-test";
const account = "ab".repeat(32);
const device = "cd".repeat(32);
const scope = `nostrbase-group:v1:${[namespace, account, device].map(encodeURIComponent).join(":")}:`;

describe("encrypted group-state backup", () => {
  it("exports only scoped ciphertext and restores it after checksum validation", async () => {
    const source = new MemoryGroupStateAdapter();
    await source.set(`${scope}state:group`, "AAAAciphertext");
    await source.set(`${scope}history:group`, "BBBBciphertext");
    await source.set("other:scope", "not included");
    const archive = await exportGroupStateBackup(source, namespace, account, device);
    expect(archive.entries).toHaveLength(2);
    expect(JSON.stringify(archive)).not.toContain("not included");
    const target = new MemoryGroupStateAdapter();
    const imported = await importGroupStateBackup(target, archive, namespace, account, device);
    expect(imported).toEqual({ imported: 2, skipped: 0 });
    expect(await target.get(`${scope}state:group`)).toBe("AAAAciphertext");
  });

  it("rejects a changed identity or corrupted checksum without writing", async () => {
    const source = new MemoryGroupStateAdapter();
    await source.set(`${scope}state:group`, "AAAAciphertext");
    const archive = await exportGroupStateBackup(source, namespace, account, device);
    const target = new MemoryGroupStateAdapter();
    await expect(
      importGroupStateBackup(target, archive, namespace, account, "ef".repeat(32)),
    ).rejects.toMatchObject({ code: "INVALID_RECORD" });
    await expect(
      importGroupStateBackup(
        target,
        { ...archive, checksum: "0".repeat(64) },
        namespace,
        account,
        device,
      ),
    ).rejects.toMatchObject({ code: "INVALID_RECORD" });
    expect(await target.keys()).toEqual([]);
  });

  it("rejects duplicate and plaintext-looking entries", async () => {
    const source = new MemoryGroupStateAdapter();
    await source.set(`${scope}state:group`, "AAAAciphertext");
    const archive = await exportGroupStateBackup(source, namespace, account, device);
    const first = archive.entries[0];
    if (!first) throw new Error("Expected a backup entry.");
    const duplicate = { ...archive, entries: [...archive.entries, first] };
    await expect(
      importGroupStateBackup(source, duplicate, namespace, account, device),
    ).rejects.toBeInstanceOf(NostrbaseError);
  });
});
