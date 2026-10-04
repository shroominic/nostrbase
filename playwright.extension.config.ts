import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/extension",
  testMatch: "*.spec.ts",
  outputDir: "output/playwright/extension",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  timeout: 40_000,
  expect: { timeout: 10_000 },
  reporter: [
    ["list"],
    ["json", { outputFile: "output/playwright/extension-results.json" }],
    ["html", { outputFolder: "output/playwright/extension-report", open: "never" }],
  ],
  projects: [{ name: "chromium-nos2x" }],
});
