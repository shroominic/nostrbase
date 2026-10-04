import { describe, expect, vi } from "vitest";
import type { NostrbaseClient } from "../src";
import { NostrbaseError } from "../src/errors";
import { encodeRecord } from "../src/protocol";
import type { QueryHost, QueryState } from "../src/query";
import { QueryBuilder } from "../src/query";
import type { Result, Row } from "../src/types";
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

const firstGroup = "a1".repeat(32);
const secondGroup = "b2".repeat(32);
function routingHost(result: Result<Row<TestDB["todos"]>[]> = { data: [], error: null }) {
  const calls: { groupId?: string; table: string; state: QueryState }[] = [];
  const host: QueryHost = {
    async execute<T extends object>(table: string, state: QueryState): Promise<Result<Row<T>[]>> {
      calls.push({ table, state });
      return result as unknown as Result<Row<T>[]>;
    },
    async executeInGroup<T extends object>(
      groupId: string,
      table: string,
      state: QueryState,
    ): Promise<Result<Row<T>[]>> {
      calls.push({ groupId, table, state });
      return result as unknown as Result<Row<T>[]>;
    },
  };
  return { host, calls, query: new QueryBuilder<TestDB["todos"]>(host, "todos") };
}
const routedRow: Row<TestDB["todos"]> = {
  id: "one",
  title: "Private group row",
  done: false,
  _nostr: { pubkey: "11".repeat(32), eventId: "22".repeat(32), createdAt: 10, updatedAt: 11 },
};

describe("explicit group query routing", () => {
  test("keeps public and distinct group branches immutable and executes each awaited branch once", async () => {
    const setup = routingHost({ data: [routedRow], error: null });
    const base = setup.query.eq("done", false);
    const first = base.inGroup(firstGroup);
    const second = base.inGroup(secondGroup);
    await Promise.all([Promise.resolve(first), Promise.resolve(first)]);
    await second;
    await base;
    expect(setup.calls.map((call) => call.groupId)).toEqual([firstGroup, secondGroup, undefined]);
    expect(
      setup.calls.every((call) => call.table === "todos" && call.state.predicates.length === 1),
    ).toBe(true);
    expect(setup.calls.map((call) => call.state.groupId)).toEqual([
      firstGroup,
      secondGroup,
      undefined,
    ]);
  });
  test("preserves mutation, filter, pagination, queue, signal, projection and cardinality settings across routing", async () => {
    const setup = routingHost({ data: [routedRow], error: null, count: 1 });
    const signal = new AbortController().signal;
    const base = setup.query
      .update({ done: true })
      .eq("id", "one")
      .author(routedRow._nostr.pubkey)
      .all()
      .queue()
      .abortSignal(signal)
      .page(1)
      .limit(1)
      .select("id, title")
      .single();
    const result = await base.inGroup(firstGroup);
    expect(result.data).toEqual({ id: "one", title: "Private group row" });
    expect(setup.calls).toHaveLength(1);
    expect(setup.calls[0]?.state).toMatchObject({
      operation: "update",
      groupId: firstGroup,
      patch: { done: true },
      predicates: [{ field: "id", op: "eq", value: "one" }],
      authors: [routedRow._nostr.pubkey],
      allowAll: true,
      queue: true,
      local: true,
      returning: true,
      signal,
      page: { size: 1 },
      limit: 1,
    });
    const ordered = await setup.query
      .inGroup(secondGroup)
      .order("title", { ascending: false })
      .range(0, 2)
      .limit(1);
    expect(ordered.error).toBeNull();
    expect(setup.calls[1]?.state).toMatchObject({
      order: [{ field: "title", ascending: false }],
      range: [0, 2],
      limit: 1,
    });
  });
  test("preserves partial publication metadata and selected data from the group executor", async () => {
    const error = new NostrbaseError("PUBLISH_FAILED", "Only one relay accepted.");
    const receipt = {
      id: "one",
      eventId: "33".repeat(32),
      relays: [
        { url: "wss://relay.test", ok: true },
        { url: "wss://other.test", ok: false },
      ],
    };
    const meta = { relays: receipt.relays, receipts: [receipt], partial: true };
    const setup = routingHost({ data: [routedRow], error, count: 1, meta });
    const result = await setup.query.inGroup(firstGroup).select("title").maybeSingle();
    expect(result.data).toEqual({ title: "Private group row" });
    expect(result.error).toBe(error);
    expect(result.meta).toBe(meta);
    expect(result.count).toBe(1);
    await expect(Promise.resolve(setup.query.inGroup(firstGroup).throwOnError())).rejects.toBe(
      error,
    );
    expect(setup.calls.every((call) => call.groupId === firstGroup)).toBe(true);
  });
  const invalidGroupIds = [
    "",
    "abcd",
    "AB".repeat(32),
    "a".repeat(63),
    "a".repeat(65),
    "gg".repeat(32),
    undefined,
    null,
    10,
  ];
  for (const id of invalidGroupIds)
    test(`rejects invalid group ID ${String(id)} before either executor`, async () => {
      const setup = routingHost();
      const result = await setup.query.inGroup(id as string);
      expect(result.data).toBeNull();
      expect(result.error?.code).toBe("INVALID_QUERY");
      expect(setup.calls).toEqual([]);
    });
  test("keeps an invalid group error sticky after a valid route and preserves earlier validation errors", async () => {
    const setup = routingHost();
    const groupInvalid = setup.query.inGroup("short");
    expect(
      (await groupInvalid.inGroup(firstGroup).select("title").maybeSingle()).error?.message,
    ).toContain("Group ID");
    const prior = setup.query.limit(-1);
    expect((await prior.inGroup(firstGroup)).error?.message).toContain("Limit");
    expect((await prior.inGroup("short")).error?.message).toContain("Limit");
    expect(setup.calls).toEqual([]);
  });
  test("fails closed on unsupported public or personal hosts without invoking their ordinary executor", async () => {
    const execute = vi.fn(async () => ({ data: [], error: null }));
    const host: QueryHost = { execute: execute as QueryHost["execute"] };
    const grouped = new QueryBuilder<TestDB["todos"]>(host, "todos").inGroup(firstGroup);
    expect((await grouped).error?.code).toBe("INVALID_QUERY");
    expect((await grouped).error?.code).toBe("INVALID_QUERY");
    expect(execute).not.toHaveBeenCalled();
    await expect(Promise.resolve(grouped.throwOnError())).rejects.toMatchObject({
      code: "INVALID_QUERY",
    });
    expect(execute).not.toHaveBeenCalled();
  });
  test("memoizes a group lookup failure and never retries it against the public executor", async () => {
    const setup = routingHost();
    const execute = vi.spyOn(setup.host, "execute");
    const failure = new NostrbaseError("NOT_FOUND", "Group is not stored here.");
    const group = vi.spyOn(setup.host, "executeInGroup").mockRejectedValue(failure);
    const query = setup.query.inGroup(firstGroup);
    expect((await query).error).toBe(failure);
    expect((await query).error).toBe(failure);
    expect(group).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("rich Supabase-style predicates", () => {
  const cases: [string, (query: TodoQuery) => TodoQuery, string[]][] = [
    [
      "LIKE keeps case and uses single-character and string wildcards",
      (q) => q.like("title", "C_fé%"),
      ["a"],
    ],
    ["ILIKE ignores case without removing accents", (q) => q.ilike("title", "%RED"), ["a", "c"]],
    ["LIKE does not coerce a number", (q) => q.like("priority", "%"), []],
    ["array overlaps", (q) => q.overlaps("labels", ["red", "none"]), ["a"]],
    ["raw negative membership", (q) => q.not("id", "in", "(a,b)"), ["c", "d"]],
    ["raw array containment", (q) => q.not("labels", "cs", "{red}"), ["b", "c", "d"]],
    ["raw boolean equality", (q) => q.filter("done", "eq", "true"), ["b"]],
    ["raw scalar number", (q) => q.filter("priority", "eq", "2"), ["b"]],
    ["raw quoted numeric string stays a string", (q) => q.filter("priority", "eq", '"2"'), []],
    ["raw quoted array member", (q) => q.filter("labels", "ov", '{"red","blue"}'), ["a", "b"]],
    [
      "containedBy reverses array containment",
      (q) => q.containedBy("labels", ["blue"]),
      ["b", "c"],
    ],
    [
      "explicit negation retains missing-field inequality",
      (q) => q.not("priority", "eq", 1),
      ["b", "c", "d"],
    ],
    ["filter operator aliases", (q) => q.filter("labels", "cs", ["red"]), ["a"]],
    [
      "OR combines with other chained filters",
      (q) => q.eq("done", false).or("title.eq.red,priority.eq.1"),
      ["a", "c"],
    ],
    [
      "nested AND, OR and NOT",
      (q) => q.or("and(done.eq.false,or(priority.eq.1,priority.eq.3)),not(title.eq.missing)"),
      ["a", "b", "c"],
    ],
    ["negative logical group", (q) => q.or("not.or(priority.eq.1,priority.eq.3)"), ["b", "d"]],
    ["negative leaf", (q) => q.or("priority.not.in.(1,3)"), ["b", "d"]],
    ["arrow JSON extraction", (q) => q.eq("details->note", "x"), ["a", "c"]],
    ["text JSON extraction", (q) => q.ilike("details->>note", "X"), ["a", "c"]],
    ["logical PostgREST array literal", (q) => q.or("labels.ov.{red,green}"), ["a"]],
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

  test("quotes reserved logical values and escapes literal LIKE wildcards", async ({ scope }) => {
    const { client } = scope.client();
    for (const [id, title] of [
      ["literal", 'rate 10%_done, ("yes")'],
      ["wild", 'rate 100Xdone, ("yes")'],
      ["emoji", "🌍"],
    ])
      client.ingest(
        await alice.signEvent(
          encodeRecord("test-app", "todos", id ?? "", { title, done: false }, 10, 10),
        ),
      );
    expect(
      (await client.from("todos").local().like("title", "rate 10\\%\\_done%")).data?.map(
        (row) => row.id,
      ),
    ).toEqual(["literal"]);
    expect(
      (
        await client
          .from("todos")
          .local()
          .or(`title.eq.${JSON.stringify('rate 10%_done, ("yes")')}`)
      ).data?.map((row) => row.id),
    ).toEqual(["literal"]);
    expect(
      (await client.from("todos").local().like("title", "_")).data?.map((row) => row.id),
    ).toEqual(["emoji"]);
  });

  test("contains recursively matches JSON subsets and never walks a prototype", async ({
    scope,
  }) => {
    const { client } = scope.client({ schema: undefined });
    client.ingest(
      await alice.signEvent(
        encodeRecord(
          "test-app",
          "todos",
          "deep",
          {
            title: "deep",
            done: false,
            details: {
              note: "x",
              owner: { name: "Ada", role: "editor" },
              entries: [{ score: 3, extra: true }],
            },
          },
          10,
          10,
        ),
      ),
    );
    const query = client.from("todos").local();
    expect(
      (
        await query.contains("details", {
          owner: { name: "Ada" },
          entries: [{ score: 3 }],
        } as never)
      ).data?.map((row) => row.id),
    ).toEqual(["deep"]);
    expect((await query.eq("details->owner->>name", "Ada")).data?.map((row) => row.id)).toEqual([
      "deep",
    ]);
    expect((await query.eq("details->entries->0->>score", "3")).data?.map((row) => row.id)).toEqual(
      ["deep"],
    );
    expect((await query.eq("details->toString", "[object Object]")).data).toEqual([]);
    expect((await query.eq("details->owner->role", "Editor")).data).toEqual([]);
  });

  test("native field names are literal own keys while raw and arrow paths stay strict", async ({
    scope,
  }) => {
    const { client, transport } = scope.client({ schema: undefined });
    const data = {
      title: "literal",
      done: false,
      "first-name": "Ada",
      姓名: "Ada",
      "meta.note": "literal-dot",
      "items[0]": "literal-bracket",
      details: { note: "nested" },
    };
    client.ingest(
      await alice.signEvent(encodeRecord("test-app", "todos", "literal", data, 10, 10)),
    );
    type Literal = typeof data;
    const native = new QueryBuilder<Literal>(client, "todos").local();
    for (const result of [
      await native.eq("first-name", "Ada"),
      await native.match({ 姓名: "Ada" }),
      await native.filter("meta.note", "eq", "literal-dot"),
      await native.not("items[0]", "eq", "different"),
      await native.order("first-name"),
    ]) {
      expect(result.error).toBeNull();
      expect(result.data?.map((row) => row.id)).toEqual(["literal"]);
    }
    expect((await native.eq("details->note", "nested")).data).toHaveLength(1);
    expect((await native.eq("details.note" as never, "nested" as never)).data).toEqual([]);
    expect((await native.eq("toString" as never, "[object Object]" as never)).data).toEqual([]);
    for (const expression of [
      "meta.note.eq.literal-dot",
      "items[0].eq.literal-bracket",
      "姓名.eq.Ada",
      "first-name.eq.Ada",
    ]) {
      expect((await native.or(expression)).error?.code).toBe("INVALID_QUERY");
    }
    expect((await native.eq("details->>note->x", "x")).error?.code).toBe("INVALID_QUERY");
    expect(transport.requests).toEqual([]);
  });

  test("copies nested predicate inputs for contains, match and membership branches", async ({
    scope,
  }) => {
    const { client } = scope.client();
    await seed(client);
    const details = { note: "x" };
    const labels = ["red", "blue"];
    const members = [labels];
    const base = client.from("todos").local();
    const byContains = base.contains("details", details);
    const byMatch = base.match({ details });
    const byMembership = base.in("labels", members);
    details.note = "changed";
    labels[0] = "changed";
    members.push([]);
    expect((await byContains).data?.map((row) => row.id).sort()).toEqual(["a", "c"]);
    expect((await byMatch).data?.map((row) => row.id).sort()).toEqual(["a", "c"]);
    expect((await byMembership).data?.map((row) => row.id)).toEqual(["a"]);
    expect((await base).data).toHaveLength(4);
  });

  test("nullsFirst is independent of descending direction and keeps missing/null distinct in filters", async ({
    scope,
  }) => {
    const { client } = scope.client({ schema: undefined });
    for (const [id, priority, time] of [
      ["null", null, 12],
      ["one", 1, 13],
      ["two", 2, 14],
    ] as const)
      client.ingest(
        await alice.signEvent(
          encodeRecord("test-app", "todos", id, { title: id, done: false, priority }, time, time),
        ),
      );
    client.ingest(
      await alice.signEvent(
        encodeRecord("test-app", "todos", "missing", { title: "missing", done: false }, 11, 11),
      ),
    );
    const base = client.from("todos").local();
    expect(
      (await base.order("priority", { ascending: false, nullsFirst: false })).data?.map(
        (row) => row.id,
      ),
    ).toEqual(["two", "one", "null", "missing"]);
    expect(
      (await base.order("priority", { ascending: true, nullsFirst: true })).data?.map(
        (row) => row.id,
      ),
    ).toEqual(["null", "missing", "one", "two"]);
    expect((await base.is("priority", null)).data?.map((row) => row.id)).toEqual(["null"]);
    expect((await base.eq("priority", undefined)).data?.map((row) => row.id)).toEqual(["missing"]);
  });

  const invalid: [string, (q: TodoQuery) => TodoQuery][] = [
    ["unknown filter operator", (q) => q.filter("title", "wat" as never, "x" as never)],
    ["empty logical term", (q) => q.or("title.eq.x,")],
    ["empty OR group", (q) => q.or("or()")],
    ["unclosed logical group", (q) => q.or("and(title.eq.x,done.eq.false")],
    ["trailing logical syntax", (q) => q.or("title.eq.x)")],
    ["unclosed quote", (q) => q.or('title.eq."x')],
    ["unsupported logical operator", (q) => q.or("title.wat.x")],
    ["malformed membership", (q) => q.or("priority.in.1")],
    ["multi-term NOT", (q) => q.or("not(title.eq.x,done.eq.false)")],
    ["malformed JSON", (q) => q.or('details.cs.{"note":}')],
    ["unsupported JSON dot path", (q) => q.or("details.note.eq.x")],
    ["trailing JSON arrow", (q) => q.eq("details->", "x")],
    ["text extraction followed by more traversal", (q) => q.eq("details->>note->x", "x")],
    ["unsupported metadata path", (q) => q.or("_nostr.__proto__.eq.x")],
    ["incomplete LIKE escape", (q) => q.like("title", "x\\")],
    ["wrong array filter shape", (q) => q.filter("labels", "ov", "red")],
    ["wrong is value", (q) => q.filter("done", "is", "wrong")],
    ["raw expression injection", (q) => q.filter("title", "eq", "x,id.eq.a")],
    ["raw membership injection", (q) => q.not("id", "in", "(a),id.eq.b")],
    ["raw quoted injection remains one string", (q) => q.filter("title", "is", '"null,id.eq.a"')],
    ["null containment", (q) => q.contains("details", null as never)],
    ["head mutation", (q) => q.select("*", { head: true }).delete()],
    ["head single", (q) => q.select("*", { head: true }).single() as unknown as TodoQuery],
    [
      "head maybeSingle",
      (q) => q.maybeSingle().select("*", { head: true }) as unknown as TodoQuery,
    ],
    ["unsupported count", (q) => q.select("*", { count: "estimated" as never })],
    ["invalid head value", (q) => q.select("*", { head: 1 as never })],
    ["null select options", (q) => q.select("*", null as never)],
    ["invalid nullable ordering", (q) => q.order("priority", { nullsFirst: "yes" as never })],
    ["order plus cursor", (q) => q.page(1).order("priority", { nullsFirst: true })],
    [
      "parser term bound",
      (q) => q.or(Array.from({ length: 257 }, () => "done.eq.false").join(",")),
    ],
    ["parser depth bound", (q) => q.or(`${"or(".repeat(17)}done.eq.false${")".repeat(17)}`)],
  ];
  for (const [name, build] of invalid)
    test(`rejects ${name} before public/group execution`, async () => {
      const setup = routingHost();
      const result = await build(setup.query).inGroup(firstGroup);
      expect(result.data).toBeNull();
      expect(result.error?.code).toBe("INVALID_QUERY");
      expect(setup.calls).toEqual([]);
    });

  test("cyclic and accessor predicate values fail before executing any branch", async () => {
    const setup = routingHost();
    const cyclic: { note: string; loop?: unknown } = { note: "x" };
    cyclic.loop = cyclic;
    const accessor = Object.defineProperty({}, "note", {
      enumerable: true,
      get: () => {
        throw new Error("getter must not run");
      },
    });
    for (const value of [cyclic, accessor]) {
      expect((await setup.query.contains("details", value as never)).error?.code).toBe(
        "INVALID_QUERY",
      );
      expect((await setup.query.match({ details: value } as never)).error?.code).toBe(
        "INVALID_QUERY",
      );
    }
    expect(setup.calls).toEqual([]);
  });
});
