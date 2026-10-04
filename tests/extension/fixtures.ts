import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { type BrowserContext, test as base, chromium, expect, type Page } from "@playwright/test";
import { getPublicKey, nip19 } from "nostr-tools";
import { extension, verifyBuild } from "../../integration/extension/setup.mjs";
import type {} from "../browser/support/entry";
import { type BrowserHarness, startBrowserHarness } from "../browser/support/server";

export const developmentKey = new Uint8Array(32).fill(65);
export const developmentPubkey = getPublicKey(developmentKey);
export interface LoadedExtension {
  context: BrowserContext;
  page: Page;
  id: string;
}

export const test = base.extend<{ harness: BrowserHarness; signer: LoadedExtension }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture dependency destructuring.
  harness: async ({}, use) => {
    const harness = await startBrowserHarness();
    try {
      await use(harness);
    } finally {
      await harness.close();
    }
  },
  signer: async ({ harness }, use, testInfo) => {
    verifyBuild();
    const profile = await mkdtemp(resolve(tmpdir(), "nostrbase-nos2x-profile-"));
    let context: BrowserContext | undefined;
    try {
      // channel: chromium uses full Chromium; the headless shell cannot load extensions.
      context = await chromium.launchPersistentContext(profile, {
        channel: "chromium",
        headless: true,
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
        viewport: { width: 1280, height: 900 },
      });
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
      const id = new URL(worker.url()).hostname;
      expect(worker.url()).toBe(`chrome-extension://${id}/background.build.js`);
      const options = await context.newPage();
      await options.goto(`chrome-extension://${id}/options.html`);
      await options
        .locator('input[type="password"]')
        .first()
        .fill(nip19.nsecEncode(developmentKey));
      await options.getByRole("button", { name: "save", exact: true }).click();
      await expect(options.getByText("saved private key!", { exact: true })).toBeVisible();
      await options.close();
      const page = await context.newPage();
      await page.goto(harness.url);
      await page.waitForFunction(() => window.harnessReady);
      // The upstream content script injects nostr-provider.js. The harness never defines window.nostr.
      await page.waitForFunction(() => {
        const provider = (window as unknown as { nostr?: { signEvent?: unknown } }).nostr;
        return typeof provider?.signEvent === "function";
      });
      await expect(
        page.locator(`script[src="chrome-extension://${id}/nostr-provider.js"]`),
      ).toHaveCount(1);
      await page.evaluate((relay) => {
        window.clients.set(
          "extension",
          window.nostrbase.createClient({
            namespace: "extension-app",
            relays: [relay],
            timeout: 10000,
            relayOptions: { keepAlive: 0 },
          }),
        );
      }, harness.relay.url);
      await use({ context, page, id });
    } finally {
      if (context) {
        if (testInfo.status !== testInfo.expectedStatus) {
          const trace = testInfo.outputPath("trace.zip");
          await context.tracing.stop({ path: trace });
          await testInfo.attach("nos2x-trace", { path: trace, contentType: "application/zip" });
        } else {
          await context.tracing.stop();
        }
        await context.close();
      }
      await rm(profile, { recursive: true, force: true });
    }
  },
});
export { expect };

/** Inspect and answer a real extension window. No provider or permission API is replaced. */
export async function promptFor<T>(
  signer: LoadedExtension,
  operation: () => Promise<T>,
  type:
    | "getPublicKey"
    | "signEvent"
    | "nip44.encrypt"
    | "nip44.decrypt"
    | readonly ("getPublicKey" | "signEvent" | "nip44.encrypt" | "nip44.decrypt")[],
  action: "approve" | "deny" | "close" = "approve",
): Promise<T> {
  let opened = signer.context.waitForEvent("page");
  const result = operation();
  const types = typeof type === "string" ? [type] : type;
  for (const [index, expectedType] of types.entries()) {
    const prompt = await opened;
    await prompt.waitForURL(`chrome-extension://${signer.id}/prompt.html?*`);
    expect(new URL(prompt.url()).searchParams.get("type")).toBe(expectedType);
    await expect(
      prompt.getByRole("button", { name: "authorize just this", exact: true }),
    ).toBeVisible();
    if (index < types.length - 1) opened = signer.context.waitForEvent("page");
    if (action === "close") await prompt.close();
    else {
      const closed = prompt.waitForEvent("close");
      await prompt
        .getByRole("button", {
          name: action === "approve" ? "authorize just this" : "reject",
          exact: true,
        })
        .click();
      await closed;
    }
  }
  return result;
}

export async function signIn(signer: LoadedExtension) {
  return promptFor(
    signer,
    () =>
      signer.page.evaluate(async () => {
        const client = window.clients.get("extension");
        if (!client) throw new Error("Missing extension client.");
        const result = await client.auth.signInWithExtension();
        return { error: result.error?.code ?? null, pubkey: result.data?.user.pubkey };
      }),
    "getPublicKey",
  );
}
