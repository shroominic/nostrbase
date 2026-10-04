import { describe, expect } from "vitest";
import type { NostrbaseClient } from "../src";
import { encodeRecord } from "../src/protocol";
import type { QueryBuilder } from "../src/query";
import type { TestDB } from "./helpers";
import { alice } from "./helpers";
import { test } from "./support/lifecycle";

async function seed(client: NostrbaseClient<TestDB>) {
  for (const data of [
    {
      id: "a",
      title: "Café RED",
      done: false,
      priority: 1,
      labels: ["red", "blue"],
      details: { note: "x" },
    },
    { id: "b", title: "blue", done: true, priority: 2, labels: ["blue"], details: { note: "y" } },
    { id: "c", title: "red", done: false, priority: 3, labels: [], details: { note: "x" } },
    { id: "d", title: "missing", done: false },
  ]) {
    const { id, ...value } = data;
    client.ingest(await alice.signEvent(encodeRecord("test-app", "todos", id, value, 10, 10)));
  }
}
type TodoQuery = QueryBuilder<TestDB["todos"]>;

describe("observable filter semantics", () => {
  const cases: [string, (query: TodoQuery) => TodoQuery, string[]][] = [
    ["conjunction through match", (q) => q.match({ done: false, priority: 1 }), ["a"]],
    ["inequality includes absent fields", (q) => q.neq("priority", 1), ["b", "c", "d"]],
    ["in membership uses values, not coercion", (q) => q.in("priority", [1, 3]), ["a", "c"]],
    ["exclusive numeric lower bound", (q) => q.gt("priority", 2), ["c"]],
    ["inclusive numeric bounds", (q) => q.gte("priority", 2).lte("priority", 2), ["b"]],
    ["exclusive numeric upper bound", (q) => q.lt("priority", 2), ["a"]],
    ["boolean is", (q) => q.is("done", true), ["b"]],
    ["array subset rather than equality", (q) => q.contains("labels", ["red"]), ["a"]],
    ["object subset", (q) => q.contains("details", { note: "x" }), ["a", "c"]],
    ["deep equality with arrays", (q) => q.eq("labels", ["red", "blue"]), ["a"]],
    ["accent normalization and all search words", (q) => q.textSearch("title", "RED cafe"), ["a"]],
  ];
  for (const [name, build, expected] of cases)
    test(name, async ({ scope }) => {
      const { client, transport } = scope.client();
      await seed(client);
      const result = await build(client.from("todos").local());
      expect(result.error).toBeNull();
      expect(result.data?.map((row) => row.id).sort()).toEqual(expected);
      expect(transport.requests).toEqual([]);
    });

  test("does not confuse missing fields with explicit null or numeric strings", async ({
    scope,
  }) => {
    const { client } = scope.client({ schema: undefined });
    for (const [id, priority] of [
      ["null", null],
      ["number", 2],
      ["string", "2"],
    ] as const)
      client.ingest(
        await alice.signEvent(
          encodeRecord("test-app", "todos", id, { title: id, done: false, priority }, 10, 10),
        ),
      );
    client.ingest(
      await alice.signEvent(
        encodeRecord("test-app", "todos", "missing", { title: "missing", done: false }, 10, 10),
      ),
    );
    expect(
      (await client.from("todos").local().is("priority", null)).data?.map((row) => row.id),
    ).toEqual(["null"]);
    expect(
      (await client.from("todos").local().gte("priority", 2)).data?.map((row) => row.id),
    ).toEqual(["number"]);
  });

  test("applies multiple sort keys, inclusive range, then limit without mutating branches", async ({
    scope,
  }) => {
    const { client } = scope.client();
    await seed(client);
    const base = client.from("todos").local().order("done").order("priority", { ascending: false });
    expect((await base.range(1, 3).limit(2).select("id, title")).data).toEqual([
      { id: "c", title: "red" },
      { id: "a", title: "Café RED" },
    ]);
    // Descending order puts the absent value first; the base keeps all four rows.
    expect((await base).data?.map((row) => row.id)).toEqual(["d", "c", "a", "b"]);
    expect((await base.limit(0)).data).toEqual([]);
  });
});

describe("query builder failure contracts", () => {
  const invalid: [string, (q: TodoQuery) => TodoQuery][] = [
    ["negative limit", (q) => q.limit(-1)],
    ["fractional range", (q) => q.range(0.5, 2)],
    ["reversed range", (q) => q.range(2, 1)],
    ["page outside permitted bounds", (q) => q.page(1001)],
    ["order before cursor", (q) => q.order("title").page(1)],
    ["order after cursor", (q) => q.page(1).order("title")],
    ["range after cursor", (q) => q.page(1).range(0, 1)],
    ["malformed cursor", (q) => q.page(1, { cursor: "%bad" })],
    ["empty author list", (q) => q.author([])],
    ["abbreviated public key", (q) => q.author("abcd")],
    ["queued read", (q) => q.queue()],
    ["invalid projection syntax", (q) => q.select("id,,title" as never) as TodoQuery],
  ];
  for (const [name, build] of invalid)
    test(`rejects ${name} before calling a transport`, async ({ scope }) => {
      const { client, transport } = scope.client();
      const result = await build(client.from("todos"));
      expect(result.error?.code).toBe("INVALID_QUERY");
      expect(result.data).toBeNull();
      expect(transport.requests).toEqual([]);
      expect(transport.published).toEqual([]);
    });

  test("empty id membership cannot widen a network query", async ({ scope }) => {
    const { client, transport } = scope.client();
    await seed(client);
    expect((await client.from("todos").in("id", [])).data).toEqual([]);
    expect(transport.requests).toEqual([]);
    expect((await client.from("todos").in("id", []).delete()).count).toBe(0);
    expect(transport.published).toEqual([]);
  });

  test("memoizes rejected execution and leaves an independent branch executable", async ({
    scope,
  }) => {
    const { client, transport } = scope.client();
    transport.readFailure = true;
    const base = client.from("todos");
    const throwing = base.throwOnError();
    await expect(Promise.resolve(throwing)).rejects.toMatchObject({ code: "RELAY_ERROR" });
    transport.readFailure = false;
    await expect(Promise.resolve(throwing)).rejects.toMatchObject({ code: "RELAY_ERROR" });
    expect(transport.requests).toHaveLength(1);
    expect((await base).error).toBeNull();
    expect(transport.requests).toHaveLength(2);
  });
});
