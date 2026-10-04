import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { startRemoteSigner } from "../../../tests/environment/support/remote-signer";

const url = (namespace: string) => `/?workspace=${namespace}`;
async function identity(page: Page) {
  await page.getByRole("button", { name: "Connect identity" }).click();
  await page.getByRole("button", { name: "Use demo identity" }).click();
  await expect(
    page
      .getByRole("dialog")
      .filter({ has: page.getByRole("heading", { name: "Connect an identity." }) }),
  ).not.toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Identity connected. Your workspace is ready.");
}
async function createProject(page: Page, name = "Release planning") {
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await page.getByRole("textbox", { name: "Project name", exact: true }).fill(name);
  await page
    .getByRole("textbox", { name: "Description", exact: true })
    .fill("Ship a useful client application.");
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
}
async function createTask(page: Page, title: string) {
  await page.getByRole("textbox", { name: "Task title", exact: true }).fill(title);
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.locator(".task-card").filter({ hasText: title })).toHaveCount(1);
}
async function openTask(page: Page, title: string) {
  await page.locator(".task-card").filter({ hasText: title }).click();
  await expect(page.locator("#detail-project")).toHaveText(/Project: /);
}
async function peer(browser: Browser, namespace: string) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(url(namespace));
    await identity(page);
    return { page, context };
  } catch (error) {
    await context.close();
    throw error;
  }
}
test.beforeEach(async ({ page }) => {
  await page.goto(url(`fieldwork-test-${randomUUID()}`));
  await identity(page);
});

test("two authors share live CRUD, resolve references, and keep foreign edits read-only", async ({
  page,
  browser,
}) => {
  await createProject(page);
  const namespace = new URL(page.url()).searchParams.get("workspace") as string;
  const second = await peer(browser, namespace);
  try {
    await expect(second.page.getByRole("heading", { level: 1 })).toHaveText("Release planning");
    await createTask(page, "Review the launch plan");
    await expect(second.page.locator(".task-card")).toHaveText(/Review the launch plan/);
    await openTask(second.page, "Review the launch plan");
    await expect(second.page.getByRole("button", { name: "Save changes" })).toBeDisabled();
    await expect(
      second.page.getByRole("button", { name: "Delete task", exact: true }),
    ).toBeDisabled();
    await second.page.getByRole("button", { name: "Close task" }).click();
    await openTask(page, "Review the launch plan");
    await page.getByRole("combobox", { name: "Status", exact: true }).selectOption("active");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(second.page.locator("#tasks-active .task-card")).toHaveText(
      /Review the launch plan/,
    );
    await openTask(page, "Review the launch plan");
    await page.getByRole("button", { name: "Delete task", exact: true }).click();
    await expect(second.page.locator(".task-card")).toHaveCount(0);
  } finally {
    await second.context.close();
  }
});

test("real IndexedDB survives an offline page restart and publishes only after explicit replay", async ({
  page,
  context,
  browser,
}) => {
  await createProject(page);
  const namespace = new URL(page.url()).searchParams.get("workspace") as string;
  const second = await peer(browser, namespace);
  try {
    await context.setOffline(true);
    await createTask(page, "Offline design note");
    // Restore HTTP access for reload. Queue policy still prevents automatic publication.
    await page.getByLabel("Queue writes").check();
    await context.setOffline(false);
    await page.reload();
    await expect(page.locator(".task-card")).toHaveText(/Offline design note/);
    await page.getByRole("button", { name: "Developer console" }).click();
    await expect(page.locator("#pending")).toHaveText("1 pending writes");
    await expect(second.page.locator(".task-card")).toHaveCount(0);
    await page.getByRole("button", { name: "Replay queued writes", exact: true }).click();
    await expect(page.locator("#pending")).toHaveText("0 pending writes");
    await expect(second.page.locator(".task-card")).toHaveText(/Offline design note/);
  } finally {
    await second.context.close();
  }
});

test("private notes persist as ciphertext and stay hidden from another author and the inspector", async ({
  page,
  browser,
}) => {
  const secret = `Personal draft ${randomUUID()}`;
  await page.getByRole("button", { name: "Private notebook" }).click();
  await page.getByLabel("Note title", { exact: true }).fill("Personal launch notes");
  await page.getByLabel("Your note", { exact: true }).fill(secret);
  await page.getByRole("button", { name: "Save private note" }).click();
  await expect(page.locator(".note-card")).toHaveText(new RegExp(secret));
  await page.getByRole("button", { name: "Developer console" }).click();
  await page.getByRole("button", { name: "Export backup", exact: true }).click();
  const backup = await page.getByRole("textbox", { name: "Signed backup" }).inputValue();
  expect(backup).not.toContain(secret);
  const persistedCiphertext = () =>
    page.evaluate(async () => {
      const name = `fieldwork:${new URL(location.href).searchParams.get("workspace")}`;
      const records = await new Promise<unknown[]>((resolve, reject) => {
        const open = indexedDB.open(name, 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const database = open.result;
          const read = database.transaction("events", "readonly").objectStore("events").getAll();
          read.onerror = () => {
            database.close();
            reject(read.error);
          };
          read.onsuccess = () => {
            database.close();
            resolve(read.result);
          };
        };
      });
      return JSON.stringify(records);
    });
  await expect.poll(persistedCiphertext).toContain('"encryption"');
  expect(await persistedCiphertext()).not.toContain(secret);
  expect(
    JSON.parse(backup).events.some((event: { tags: string[][] }) =>
      event.tags.some((tag) => tag[0] === "encryption"),
    ),
  ).toBe(true);
  await page.getByText("Local cache inspector", { exact: true }).click();
  await expect(page.locator("#inspector pre")).not.toContainText(secret);
  const namespace = new URL(page.url()).searchParams.get("workspace") as string;
  const second = await peer(browser, namespace);
  try {
    await second.page.getByRole("button", { name: "Private notebook" }).click();
    await expect(second.page.locator(".note-card")).toHaveCount(0);
    await page.reload();
    await page.getByRole("button", { name: "Private notebook" }).click();
    await expect(page.locator(".note-card")).toContainText(secret);
    await page.getByRole("button", { name: "Delete note", exact: true }).click();
    await expect(page.locator(".note-card")).toHaveCount(0);
    await page.getByRole("button", { name: /Explorer ·/ }).click();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.locator(".note-card")).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("button", { name: "Connect identity" })).toBeVisible();
  } finally {
    await second.context.close();
  }
});

test("Blossom browser CORS supports attachment upload, verified download, list, and removal", async ({
  page,
}) => {
  await createProject(page);
  await createTask(page, "Attach release checklist");
  await openTask(page, "Attach release checklist");
  const bytes = `Release checklist ${randomUUID()}\n1. Review\n2. Ship\n`;
  await page
    .getByLabel("Attach public file")
    .setInputFiles({ name: "checklist.txt", mimeType: "text/plain", buffer: Buffer.from(bytes) });
  await expect(page.getByRole("button", { name: "Download attachment" })).toBeVisible();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download attachment" }).click();
  expect(await readFile((await (await downloaded).path()) as string, "utf8")).toBe(bytes);
  await page.getByRole("button", { name: "Close task" }).click();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page.getByRole("button", { name: "Refresh files" }).click();
  await expect(page.locator(".file-row")).toHaveCount(1);
  await page.getByRole("button", { name: "Remove file" }).click();
  await expect(page.locator(".file-row")).toHaveCount(0);
});

test("presence and ephemeral broadcasts connect two real browser sessions and sign-out removes presence", async ({
  page,
  browser,
}) => {
  const namespace = new URL(page.url()).searchParams.get("workspace") as string;
  const second = await peer(browser, namespace);
  try {
    await expect(page.locator("#presence")).toHaveText("2 here");
    await page.getByLabel("Room update", { exact: true }).fill("Ready for review");
    await page.getByRole("button", { name: "Send update" }).click();
    await expect(second.page.locator("#signal")).toHaveText("Ready for review");
    await second.page.getByRole("button", { name: /Explorer ·/ }).click();
    await second.page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.locator("#presence")).toHaveText("1 here");
    await page.getByRole("button", { name: "Developer console" }).click();
    await page.getByLabel("Public activity message").fill("Launch review is published");
    await page.getByRole("button", { name: "Publish public update" }).click();
    await expect(second.page.locator("#signal")).toHaveText("Launch review is published");
    await page.getByRole("button", { name: "Export backup", exact: true }).click();
    const archive = JSON.parse(
      await page.getByRole("textbox", { name: "Signed backup" }).inputValue(),
    );
    expect(
      archive.events.every((event: { kind: number }) => event.kind < 20000 || event.kind >= 30000),
    ).toBe(true);
  } finally {
    await second.context.close();
  }
});

test("two tabs with the same signer receive private live changes without sharing plaintext storage", async ({
  page,
}) => {
  const opened = page.waitForEvent("popup");
  await page.evaluate(() => window.open(location.href, "_blank"));
  const second = await opened;
  try {
    await expect(second.getByRole("button", { name: /Explorer ·/ })).toBeVisible();
    await second.getByRole("button", { name: "Private notebook" }).click();
    await page.getByRole("button", { name: "Private notebook" }).click();
    await page.getByLabel("Note title", { exact: true }).fill("Same identity, second tab");
    await page
      .getByLabel("Your note", { exact: true })
      .fill("This arrives through the private subscription.");
    await page.getByRole("button", { name: "Save private note" }).click();
    await expect(second.locator(".note-card")).toContainText(
      "This arrives through the private subscription.",
    );
    await second.getByRole("button", { name: "Delete note", exact: true }).click();
    await expect(page.locator(".note-card")).toHaveCount(0);
  } finally {
    await second.close();
  }
});

test("a NIP-46 signer in a separate process signs app writes and encrypts personal notes", async ({
  page,
}) => {
  const signer = await startRemoteSigner("ws://127.0.0.1:18047");
  try {
    await page.getByRole("button", { name: /Explorer ·/ }).click();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.getByRole("button", { name: "Connect identity" }).click();
    await page.getByLabel("Bunker URI", { exact: true }).fill(signer.uri);
    await page.getByRole("button", { name: "Connect remote signer" }).click();
    await expect(
      page.getByRole("button", { name: `Explorer · ${signer.pubkey.slice(0, 6)}` }),
    ).toBeVisible();
    await createProject(page, "Remote signer workspace");
    await createTask(page, "Delegated signature");
    await page.getByRole("button", { name: "Private notebook" }).click();
    await page.getByLabel("Note title", { exact: true }).fill("Remote encryption");
    await page
      .getByLabel("Your note", { exact: true })
      .fill("Encrypted by the separate signer process.");
    await page.getByRole("button", { name: "Save private note" }).click();
    await expect(page.locator(".note-card")).toContainText(
      "Encrypted by the separate signer process.",
    );
    await page.getByRole("button", { name: /Explorer ·/ }).click();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("button", { name: "Connect identity" })).toBeVisible();
    await expect(page.locator(".note-card")).toHaveCount(0);
  } finally {
    await signer.close();
  }
});

test("cursor pages have no duplicate cards and local text search finds later cached records", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Load sample project" }).click();
  await expect(page.locator(".task-card")).toHaveCount(6);
  await page.getByRole("button", { name: "Load more tasks" }).click();
  await expect(page.locator(".task-card")).toHaveCount(9);
  const ids = await page
    .locator(".task-card")
    .evaluateAll((cards) => cards.map((card) => card.getAttribute("data-task")));
  expect(new Set(ids).size).toBe(9);
  await page.getByRole("textbox", { name: "Search tasks" }).fill("offline");
  await expect(page.locator(".task-card")).toHaveCount(1);
  await expect(page.locator(".task-card")).toContainText("Check the offline experience");
});

test("migration preview is read-only, apply changes owned records, and tampered backups fail", async ({
  page,
  browser,
}) => {
  await createProject(page);
  await createTask(page, "Own migration candidate");
  const namespace = new URL(page.url()).searchParams.get("workspace") as string;
  const second = await peer(browser, namespace);
  try {
    await createTask(second.page, "Foreign migration candidate");
    await page.getByRole("button", { name: "Developer console" }).click();
    await page.getByRole("button", { name: "Preview migration" }).click();
    await expect(page.locator("#migration-result")).toHaveText(
      "Preview: 1 of 1 owned tasks will change.",
    );
    await page.getByRole("button", { name: "Project board" }).click();
    await openTask(page, "Own migration candidate");
    await expect(page.locator("#detail-revision")).toHaveText("Record revision 1");
    await page.getByRole("button", { name: "Close task" }).click();
    await page.getByRole("button", { name: "Developer console" }).click();
    await page.getByRole("button", { name: "Apply migration" }).click();
    await expect(page.locator("#migration-result")).toHaveText("Applied: 1 owned tasks upgraded.");
    await page.getByRole("button", { name: "Export backup", exact: true }).click();
    const archive = JSON.parse(
      await page.getByRole("textbox", { name: "Signed backup" }).inputValue(),
    );
    const record = archive.events.find((event: { kind: number }) => event.kind === 30078);
    record.content = "tampered";
    await page.getByRole("textbox", { name: "Signed backup" }).fill(JSON.stringify(archive));
    await page.getByRole("button", { name: "Import backup", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("invalid signature");
    await page.getByRole("button", { name: "Export backup", exact: true }).click();
    await page.getByRole("button", { name: "Import backup", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Backup restored locally:");
    await page.getByRole("button", { name: "Project board" }).click();
    await openTask(page, "Own migration candidate");
    await expect(page.locator("#detail-revision")).toHaveText("Record revision 2");
    await page.getByRole("button", { name: "Close task" }).click();
    await openTask(page, "Foreign migration candidate");
    await expect(page.locator("#detail-revision")).toHaveText("Record revision 1");
  } finally {
    await second.context.close();
  }
});

test("independent NIP-77 recovery pulls missed records, REQ works, and native profiles round-trip", async ({
  page,
  browser,
}) => {
  await createProject(page);
  await createTask(page, "Recover me");
  await page.getByRole("button", { name: "Developer console" }).click();
  await page.getByRole("button", { name: "Pause live updates" }).click();
  const namespace = new URL(page.url()).searchParams.get("workspace") as string;
  const second = await peer(browser, namespace);
  try {
    await createTask(second.page, "Missed while live updates were paused");
    await expect(page.locator(".task-card")).toHaveCount(1);
    await page.getByRole("button", { name: "Recover from relay" }).click();
    await expect(page.locator("#sync-result")).toContainText('"ok": true');
    if (process.env.FIELDWORK_NO_NEGENTROPY === "1") {
      await expect(page.locator("#sync-result")).toContainText('"strategy": "query"');
      await expect(page.locator("#sync-result")).toContainText("fallbackReason");
    } else await expect(page.locator("#sync-result")).toContainText('"strategy": "negentropy"');
    expect(JSON.parse(await page.locator("#sync-result").innerText())[0].received).toBeGreaterThan(
      0,
    );
    await expect(
      page.locator(".task-card").filter({ hasText: "Missed while live updates were paused" }),
    ).toHaveCount(1);
    await page.getByRole("button", { name: "Recover with REQ" }).click();
    await expect(page.locator("#sync-result")).toContainText('"strategy": "query"');
    await expect(page.locator("#capabilities")).toContainText("NIP-50 not supported");
    await expect(page.getByRole("button", { name: "Search relay", exact: true })).toBeDisabled();
    await page.locator("#profile-name").fill("Fieldwork developer");
    await page.getByRole("button", { name: "Publish profile" }).click();
    await page.getByRole("button", { name: "Read profile", exact: true }).click();
    await expect(page.locator("#profile-result")).toHaveText('{"name":"Fieldwork developer"}');
    await page.getByRole("button", { name: "Resume live updates" }).click();
    await createTask(second.page, "Live updates resumed");
    await expect(
      page.locator(".task-card").filter({ hasText: "Live updates resumed" }),
    ).toHaveCount(1);
  } finally {
    await second.context.close();
  }
});

test("mobile layout exposes the same task flow without page overflow or browser errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Load sample project" }).click();
  await createTask(page, "Mobile review task");
  await openTask(page, "Mobile review task");
  await expect(page.getByRole("button", { name: "Save changes" })).toBeVisible();
  await page.getByRole("button", { name: "Close task" }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
