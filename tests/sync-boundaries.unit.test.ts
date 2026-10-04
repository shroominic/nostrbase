import { describe, expect, vi } from "vitest";
import type { Filter, NostrEvent } from "../src";
import { alice } from "./helpers";
import { deferred, required, test } from "./support/lifecycle";

describe("reconciliation failure boundaries", () => {
  test("splits a missing-id vector across bounded requests and returns every verified event once", async ({
    scope,
  }) => {
    const { client, transport } = scope.client();
    const events = await Promise.all(
      Array.from({ length: 101 }, (_, index) =>
        alice.signEvent({ kind: 1, created_at: 10, content: String(index), tags: [] }),
      ),
    );
    transport.events = events;
    vi.spyOn(client.pool.relay(required(client.relays[0])), "negentropy").mockImplementation(
      async (_local, _filter, reconcile) => {
        await reconcile(
          [],
          events.map((event) => event.id),
        );
        return true;
      },
    );
    const result = await client.sync.pull({ kinds: [1] });
    expect(result.error).toBeNull();
    expect(result.meta?.sync[0]?.strategy).toBe("negentropy");
    expect(result.count).toBe(101);
    expect(result.data?.map((event) => event.id).sort()).toEqual(
      events.map((event) => event.id).sort(),
    );
    expect(transport.requests.map((filters) => filters[0]?.ids?.length)).toEqual([100, 1]);
    expect(transport.published).toEqual([]);
  });

  test("a missing negotiated event triggers query recovery without discarding already verified data", async ({
    scope,
  }) => {
    const { client, transport } = scope.client();
    const events = await Promise.all(
      ["a", "b"].map((content) => alice.signEvent({ kind: 1, created_at: 10, content, tags: [] })),
    );
    transport.events = events;
    const request = transport.request.bind(transport);
    vi.spyOn(transport, "request").mockImplementation(async (relays, filters, options) => {
      const response = await request(relays, filters, options);
      return filters[0]?.ids ? { ...response, events: response.events.slice(0, 1) } : response;
    });
    vi.spyOn(client.pool.relay(required(client.relays[0])), "negentropy").mockImplementation(
      async (_local, _filter, reconcile) => {
        await reconcile(
          [],
          events.map((event) => event.id),
        );
        return true;
      },
    );
    const result = await client.sync.pull({ kinds: [1] });
    expect(result.error).toBeNull();
    expect(result.meta?.sync[0]).toMatchObject({
      strategy: "query",
      fallbackReason: "Relay did not return every reconciled event.",
    });
    expect(result.count).toBe(2);
    expect(result.data?.map((event) => event.id).sort()).toEqual(
      events.map((event) => event.id).sort(),
    );
    expect(transport.requests).toHaveLength(2);
    expect(transport.published).toEqual([]);
  });

  test("reports mixed recovery when one filter negotiates and a second requires a query", async ({
    scope,
  }) => {
    const { client, transport } = scope.client();
    const note = await alice.signEvent({ kind: 1, created_at: 10, content: "note", tags: [] });
    const profile = await alice.signEvent({ kind: 0, created_at: 10, content: "{}", tags: [] });
    transport.events = [note, profile];
    vi.spyOn(client.pool.relay(required(client.relays[0])), "negentropy").mockImplementation(
      async (_local, filter, reconcile) => {
        if ((filter as Filter).kinds?.includes(0)) throw new Error("unsupported filter");
        await reconcile([], [note.id]);
        return true;
      },
    );
    const result = await client.sync.pull([{ kinds: [1] }, { kinds: [0] }]);
    expect(result.error).toBeNull();
    expect(result.meta?.sync[0]).toMatchObject({
      strategy: "mixed",
      fallbackReason: "unsupported filter",
    });
    expect(result.data?.map((event) => event.id).sort()).toEqual([note.id, profile.id].sort());
  });

  test("failed completion retains verified partial data and per-relay failure details", async ({
    scope,
  }) => {
    const { client, transport } = scope.client();
    const note = await alice.signEvent({ kind: 1, created_at: 10, content: "note", tags: [] });
    const request = transport.request.bind(transport);
    transport.events = [note];
    vi.spyOn(transport, "request").mockImplementation(async (relays, filters, options) => {
      if (filters[0]?.kinds?.includes(0))
        return {
          events: [],
          relays: relays.map((url) => ({ url, ok: false, message: "unavailable" })),
        };
      return request(relays, filters, options);
    });
    const result = await client.sync.pull([{ kinds: [1] }, { kinds: [0] }], { strategy: "query" });
    expect(result.error?.code).toBe("RELAY_ERROR");
    expect(result.data?.map((event) => event.id)).toEqual([note.id]);
    expect(result.meta?.partial).toBe(true);
    expect(result.meta?.sync[0]).toMatchObject({ ok: false, received: 1 });
    expect(client.cachedEvents().map((event) => event.id)).toContain(note.id);
  });

  test("ignores a late transport response after cancellation without adding its events to the cache", async ({
    scope,
  }) => {
    const { client, transport } = scope.client();
    const entered = deferred();
    const release = deferred<NostrEvent[]>();
    const controller = new AbortController();
    scope.defer(() => {
      controller.abort();
      release.resolve([]);
    });
    vi.spyOn(transport, "request").mockImplementation(async (relays) => {
      entered.resolve();
      return { events: await release.promise, relays: relays.map((url) => ({ url, ok: true })) };
    });
    const pending = client.sync.pull(
      { kinds: [1] },
      { strategy: "query", signal: controller.signal },
    );
    await entered.promise;
    controller.abort();
    release.resolve([
      await alice.signEvent({ kind: 1, created_at: 10, content: "too late", tags: [] }),
    ]);
    const result = await pending;
    expect(result.error?.code).toBe("ABORTED");
    expect(result.data).toEqual([]);
    expect(client.cachedEvents()).toEqual([]);
  });

  test("rejects unconfigured relay URLs before any request or negotiation", async ({ scope }) => {
    const { client, transport } = scope.client();
    const negotiation = vi.spyOn(client.pool.relay(required(client.relays[0])), "negentropy");
    expect(
      (await client.sync.pull({ kinds: [1] }, { relays: ["wss://unconfigured.test"] })).error?.code,
    ).toBe("INVALID_QUERY");
    expect(negotiation).not.toHaveBeenCalled();
    expect(transport.requests).toEqual([]);
  });
});
