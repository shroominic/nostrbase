import { test as base } from "@playwright/test";
import { startBrowserHarness, type BrowserHarness } from "./server";

export const test = base.extend<{ harness: BrowserHarness }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires destructured fixture dependencies.
  harness: async ({}, use) => {
    const harness = await startBrowserHarness();
    try {
      await use(harness);
    } finally {
      await harness.close();
    }
  },
});
export { expect } from "@playwright/test";
