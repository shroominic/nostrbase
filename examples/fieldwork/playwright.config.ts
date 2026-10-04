import { defineConfig, devices } from "@playwright/test";

const fallback = process.env.FIELDWORK_NO_NEGENTROPY === "1";
export default defineConfig({
  testDir: "./e2e",
  outputDir: fallback
    ? "../../output/fieldwork/fallback-results"
    : "../../output/fieldwork/test-results",
  timeout: 45000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ["list"],
    [
      "html",
      {
        outputFolder: fallback
          ? "../../output/fieldwork/report-fallback"
          : "../../output/fieldwork/report",
        open: "never",
      },
    ],
  ],
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: fallback
    ? [{ name: "chromium-fallback", use: { ...devices["Desktop Chrome"] } }]
    : [
        { name: "chromium", use: { ...devices["Desktop Chrome"] } },
        { name: "firefox", use: { ...devices["Desktop Firefox"] } },
        { name: "webkit", use: { ...devices["Desktop Safari"] } },
      ],
  webServer: {
    command: "node ../../scripts/fieldwork-stack.mjs",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
    timeout: 25000,
  },
});
