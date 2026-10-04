import { defineConfig } from "vitest/config";

/** Explicit infrastructure projects. These are separate from the fast, fixture-based suite. */
const projects = [
  "relay-service",
  "blossom-service",
  "remote-signer",
  "network-faults",
  "crash-recovery",
  "load",
  "live-services",
] as const;

export default defineConfig({
  test: {
    reporters: ["default", "json"],
    outputFile: { json: "output/integration/environment-results.json" },
    maxWorkers: 1,
    fileParallelism: false,
    projects: projects.map((name) => ({
      test: {
        name,
        allowOnly: !process.env.CI,
        retry: 0,
        include: [`tests/environment/${name}.test.ts`],
        testTimeout: 60000,
        hookTimeout: 120000,
        pool: "forks",
        fileParallelism: false,
        maxWorkers: 1,
      },
    })),
  },
});
