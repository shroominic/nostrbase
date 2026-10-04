import { expect, test } from "./support/fixtures";
import type {} from "./support/entry";

// Risk: a real full browser origin must reject the durable enqueue before optimistic cache changes.
// Chromium exposes deterministic quota controls through CDP; other engines run the portable project.
test("actual IndexedDB quota rejection leaves no queue receipt or optimistic row and retry succeeds", async ({
  page,
  context,
  harness,
}) => {
  await page.goto(harness.url);
  await page.waitForFunction(() => window.harnessReady);
  await page.evaluate(
    async ({ relay }) => {
      await window.createHarnessClient({
        name: "main",
        database: "quota-boundary",
        namespace: "quota-app",
        relay,
      });
    },
    { relay: harness.relay.url },
  );
  const cdp = await context.newCDPSession(page);
  await cdp.send("Storage.overrideQuotaForOrigin", { origin: harness.url, quotaSize: 1024 });
  try {
    const failed = await page.evaluate(async () => {
      const client = window.clients.get("main");
      if (!client) throw new Error("Missing client");
      const result = await client
        .from("todos")
        .insert({ id: "large", title: "x".repeat(262144) })
        .queue()
        .select();
      return {
        result: {
          count: result.count,
          error: result.error?.code,
          cause: result.error?.details instanceof DOMException ? result.error.details.name : "",
          receipts: result.meta?.receipts,
        },
        queue: await client.offline.list(),
        rows: (await client.from("todos").local()).data,
      };
    });
    expect(failed.result.error).toBe("RELAY_ERROR");
    expect(failed.result.cause).toBe("QuotaExceededError");
    expect(failed.result.count).toBe(0);
    expect(failed.result.receipts).toEqual([]);
    expect(failed.queue).toEqual([]);
    expect(failed.rows).toEqual([]);
    expect(harness.relay.frames).toEqual([]);
  } finally {
    await cdp.send("Storage.overrideQuotaForOrigin", { origin: harness.url });
    await cdp.detach();
  }
  const retry = await page.evaluate(async () => {
    const client = window.clients.get("main");
    if (!client) throw new Error("Missing client");
    const result = await client
      .from("todos")
      .insert({ id: "small", title: "retry after quota release" })
      .queue()
      .select();
    await client.closeAsync();
    return {
      code: result.error?.code,
      count: result.count,
      persisted: result.meta?.receipts?.[0]?.queued,
    };
  });
  expect(retry).toEqual({ code: undefined, count: 1, persisted: true });
});
