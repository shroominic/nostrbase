import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    allowOnly: !process.env.CI,
    retry: 0,
    projects: [
      {
        test: {
          name: "unit",
          include: [
            "tests/**/*.unit.test.ts",
            "tests/sdk.test.ts",
            "tests/types.test.ts",
            "tests/tooling.test.ts",
            "tests/private-storage.test.ts",
          ],
          testTimeout: 10000,
        },
      },
      {
        test: {
          name: "integration",
          include: [
            "tests/**/*.integration.test.ts",
            "tests/relay.test.ts",
            "tests/realtime.test.ts",
            "tests/offline-sync.test.ts",
          ],
          testTimeout: 10000,
        },
      },
    ],
  },
});
