import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "runtime.spec.ts",
  outputDir: "output/playwright/browser",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 2 : 3,
  timeout: 30000,
  expect: { timeout: 10000 },
  reporter: [
    ["list"],
    ["json", { outputFile: "output/playwright/browser-results.json" }],
    ["html", { outputFolder: "output/playwright/browser-report", open: "never" }],
  ],
  use: {
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      testMatch: ["runtime.spec.ts", "quota.spec.ts"],
      use: { ...devices["Desktop Chrome"] },
    },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
