import { test as base } from "vitest";
import { setup } from "../helpers";

/** Fail fixture setup at its cause, instead of allowing missing data into later assertions. */
export function required<T>(value: T | null | undefined, label = "fixture value"): T {
  if (value === null || value === undefined) throw new Error(`Missing ${label}.`);
  return value;
}

/** Resolve the exact async boundary under test. No sleeps or polling for mock state. */
export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export class TestScope {
  constructor(private label: string) {}
  private disposals: (() => void | Promise<void>)[] = [];
  defer(dispose: () => void | Promise<void>): void {
    this.disposals.push(dispose);
  }
  client(options: Parameters<typeof setup>[0] = {}) {
    const result = setup(options);
    this.defer(() => result.client.closeAsync());
    return result;
  }
  async close(): Promise<void> {
    const failures: unknown[] = [];
    for (const dispose of this.disposals.reverse()) {
      try {
        await dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, `Cleanup failed: ${this.label}`);
  }
}

export const test = base.extend<{ scope: TestScope }>({
  scope: async ({ task }, use) => {
    const scope = new TestScope(task.name);
    try {
      await use(scope);
    } finally {
      await scope.close();
    }
  },
});
