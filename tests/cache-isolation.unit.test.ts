import { describe, expect } from "vitest";
import type { ChangePayload } from "../src";
import { encodeRecord } from "../src/protocol";
import type { TestDB } from "./helpers";
import { alice } from "./helpers";
import { required, test } from "./support/lifecycle";

describe("verified cache ownership", () => {
  test("one native event listener cannot alter delivery to another listener", async ({ scope }) => {
    const { client, transport } = scope.client();
    const seen: string[] = [];
    client.events.subscribe({ kinds: [1] }, (event) => {
      event.content = "observer mutation";
    });
    client.events.subscribe({ kinds: [1] }, (event) => seen.push(event.content));
    transport.live.next(
      await alice.signEvent({ kind: 1, created_at: 10, content: "original", tags: [] }),
    );
    expect(seen).toEqual(["original"]);
  });

  test("mutating a transport-owned event after ingestion cannot change a cache-only result", async ({
    scope,
  }) => {
    const { client } = scope.client();
    const signed = await alice.signEvent(
      encodeRecord("test-app", "todos", "x", { title: "original", done: false }, 10, 10),
    );
    client.ingest(signed);
    const body = JSON.parse(signed.content);
    body.data.title = "forged";
    signed.content = JSON.stringify(body);
    expect((await client.from("todos").local().single()).data?.title).toBe("original");
  });

  test("native query results cannot corrupt the verified table cache", async ({ scope }) => {
    const { client, transport } = scope.client();
    transport.events.push(
      await alice.signEvent(
        encodeRecord("test-app", "todos", "x", { title: "original", done: false }, 10, 10),
      ),
    );
    const result = await client.events.query({ kinds: [30078] });
    const event = required(result.data?.[0]);
    const body = JSON.parse(event.content);
    body.data.title = "forged";
    event.content = JSON.stringify(body);
    expect((await client.from("todos").local().single()).data?.title).toBe("original");
  });

  test("a raw-event observer cannot forge later table reads by mutating its event", async ({
    scope,
  }) => {
    const { client, transport } = scope.client();
    client.events.subscribe({ kinds: [30078] }, (event) => {
      const body = JSON.parse(event.content);
      body.data.title = "forged";
      event.content = JSON.stringify(body);
    });
    transport.live.next(
      await alice.signEvent(
        encodeRecord("test-app", "todos", "x", { title: "original", done: false }, 10, 10),
      ),
    );
    expect((await client.from("todos").local().single()).data?.title).toBe("original");
  });

  test("mutating private change data cannot alter the old value in a later update", async ({
    scope,
  }) => {
    const { client } = scope.client();
    const changes: ChangePayload<TestDB["todos"]>[] = [];
    await client.private.subscribe("todos", (change) => {
      changes.push(structuredClone(change));
      if (change.new) change.new.title = "observer mutation";
    });
    await client.private.from("todos").insert({ id: "x", title: "first", done: false }).queue();
    await expect.poll(() => changes.length).toBe(1);
    await client.private.from("todos").update({ title: "second" }).eq("id", "x").queue();
    await expect.poll(() => changes.length).toBe(2);
    expect(changes[1]?.old?.title).toBe("first");
    expect(changes[1]?.new?.title).toBe("second");
    expect((await client.private.from("todos").local().single()).data?.title).toBe("second");
  });
});
