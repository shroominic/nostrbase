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
