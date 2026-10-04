import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/baseline/**/*.test.ts"],
    allowOnly: !process.env.CI,
    retry: 0,
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
