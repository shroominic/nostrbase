import { describe, expect } from "vitest";
import type { NostrbaseClient, Result } from "../src";
import { createClient } from "../src";
import { encodeRecord } from "../src/protocol";
import type { QueryBuilder } from "../src/query";
import { alice, bob } from "./helpers";
import type { TestScope } from "./support/lifecycle";
import { required, test } from "./support/lifecycle";
import { relayOptions, WireRelay } from "./support/relay";

interface RecordData {
  title: string;
  rank: number | null;
  labels: string[];
  details: { owner: { name: string; active: boolean }; scores: number[] };
}
interface Database {
  records: RecordData;
}
function checked<T>(result: Result<T>): T {
  expect(result.error).toBeNull();
  return required(result.data);
}
async function relay(scope: TestScope) {
  const node = await new WireRelay().start();
  scope.defer(() => node.close());
  return node;
}
function client(scope: TestScope, node: WireRelay, signer = alice): NostrbaseClient<Database> {
  const db = createClient<Database>({
    namespace: "rich-query-scopes",
    relays: [node.url],
    signer,
    timeout: 2000,
    relayOptions,
    schema: { records: {} },
  });
  scope.defer(() => db.closeAsync());
  return db;
}
const values = [
  {
    id: "a",
    title: "Ada 10%_done",
    rank: 2,
    labels: ["red"],
    details: { owner: { name: "Ada", active: true }, scores: [2, 3] },
  },
  {
    id: "b",
    title: "Grace",
    rank: null,
    labels: ["blue"],
    details: { owner: { name: "Grace", active: false }, scores: [1] },
  },
  {
    id: "c",
    title: "ADA review",
    rank: 1,
    labels: ["red", "blue"],
    details: { owner: { name: "Ada", active: true }, scores: [3] },
  },
  {
    id: "d",
    title: "Ada later",
    rank: 3,
    labels: ["green"],
    details: { owner: { name: "Ada", active: false }, scores: [] },
  },
] satisfies (RecordData & { id: string })[];

describe("rich filters through verified local relay records", () => {
  test("exact counts include newer records outside a cold cursor window and exclude signed tombstones", async ({
    scope,
  }) => {
    const node = await relay(scope);
    const publisher = client(scope, node);
    for (const [offset, record] of [
      required(values[0]),
      required(values[2]),
      required(values[3]),
    ].entries()) {
      const { id, ...data } = record;
      checked(
        await publisher.events.publishSigned(
          await alice.signEvent(
            encodeRecord(
              "rich-query-scopes",
              "records",
              id,
              data,
              (offset + 1) * 10,
              (offset + 1) * 10,
            ),
          ),
        ),
      );
    }
    const firstReader = client(scope, node);
    const first = await firstReader.from("records").ilike("title", "Ada%").page(2);
    expect(checked(first).map((row) => row.id)).toEqual(["d", "c"]);
    const coldReader = client(scope, node);
    const after = await coldReader
      .from("records")
      .ilike("title", "Ada%")
      .page(2, { cursor: required(first.meta?.nextCursor) })
      .select("id", { count: "exact" });
    expect(checked(after)).toEqual([{ id: "a" }]);
    expect(after.count).toBe(3);
    expect((await publisher.from("records").eq("id", "c").delete()).error).toBeNull();
    const lastReader = client(scope, node);
    const deleted = await lastReader
      .from("records")
      .not("rank", "is", "null")
      .select("*", { count: "exact", head: true })
      .limit(0);
    expect(checked(deleted)).toEqual([]);
    expect(deleted.count).toBe(2);
  });

  test("uses the same logical/JSON/containment filters, exact count, null ordering and mutation selection in all three scopes", async ({
    scope,
  }) => {
    const node = await relay(scope);
    const db = client(scope, node);
    const group = checked(await db.groups.create({ name: "Rich predicates" }));
    const scopes: [string, () => QueryBuilder<RecordData>][] = [
      ["public", () => db.from("records")],
      ["personal", () => db.private.from("records")],
      ["group", () => db.from("records").inGroup(group.id)],
    ];
    for (const [name, from] of scopes) {
      for (const value of values)
        expect(
          (await from().insert({ ...value, title: `${name}:${value.title}` })).error,
        ).toBeNull();
      const rich = await from()
        .contains("details", { owner: { name: "Ada" } })
        .or("and(labels.ov.{red},details->owner->active.eq.true),id.eq.d");
      expect(
        checked(rich)
          .map((row) => row.id)
          .sort(),
      ).toEqual(["a", "c", "d"]);
      const literal = await from().like("title", `${name}:Ada 10\\%\\_done`);
      expect(checked(literal).map((row) => row.id)).toEqual(["a"]);
      const ordered = await from().order("rank", { ascending: false, nullsFirst: false });
      expect(checked(ordered).map((row) => row.id)).toEqual(["d", "a", "c", "b"]);
      const count = await from()
        .not("rank", "is", null)
        .select("id", { count: "exact", head: true })
        .limit(1);
      expect(checked(count)).toEqual([]);
      expect(count.count).toBe(3);
      const first = await from()
        .contains("details", { owner: { name: "Ada" } })
        .page(2)
        .select("id", { count: "exact" });
      expect(checked(first)).toHaveLength(2);
      expect(first.count).toBe(3);
      const cursor = required(first.meta?.nextCursor);
      const second = await from()
        .contains("details", { owner: { name: "Ada" } })
        .page(2, { cursor })
        .select("id", { count: "exact" });
      expect(checked(second)).toHaveLength(1);
      expect(second.count).toBe(3);
      expect([...checked(first), ...checked(second)].map((row) => row.id).sort()).toEqual([
        "a",
        "c",
        "d",
      ]);
      const changed = await from()
        .update({ rank: 9 })
        .or("and(labels.ov.{red},details->owner->active.eq.true),id.eq.d")
        .select("id");
      expect(
        checked(changed)
          .map((row) => row.id)
          .sort(),
      ).toEqual(["a", "c", "d"]);
      expect(
        checked(await from().eq("rank", 9))
          .map((row) => row.id)
          .sort(),
      ).toEqual(["a", "c", "d"]);
      expect(checked(await from().eq("id", "b").single()).rank).toBeNull();
    }
    const wire = JSON.stringify([...node.events.values()]);
    expect(wire).not.toContain("personal:Ada");
    expect(wire).not.toContain("group:Ada");
  }, 30000);

  test("OR/NOT id branches do not become narrowing relay hints or escape author ownership", async ({
    scope,
  }) => {
    const node = await relay(scope);
    const own = client(scope, node);
    const foreign = client(scope, node, bob);
    for (const value of values) expect((await own.from("records").insert(value)).error).toBeNull();
    expect(
      (
        await foreign
          .from("records")
          .insert({ ...required(values[0]), id: "foreign", title: "FOREIGN-UNCHANGED" })
      ).error,
    ).toBeNull();
    const result = await own.from("records").or("id.eq.a,rank.gte.3");
    expect(
      checked(result)
        .map((row) => row.id)
        .sort(),
    ).toEqual(["a", "d"]);
    const updated = await own
      .from("records")
      .or("id.eq.foreign,id.eq.c")
      .update({ title: "OWN-CHANGED" })
      .select();
    expect(checked(updated).map((row) => row.id)).toEqual(["c"]);
    expect(
      checked(
        await foreign
          .from("records")
          .author(await bob.getPublicKey())
          .eq("id", "foreign")
          .single(),
      ).title,
    ).toBe("FOREIGN-UNCHANGED");
    const removed = await own.from("records").not("id", "in", ["a", "b", "c"]).delete().select();
    expect(checked(removed).map((row) => row.id)).toEqual(["d"]);
    expect(checked(await own.from("records").or("id.eq.a,id.eq.foreign"))).toHaveLength(2);
  });

  test("malformed logical mutations fail before any socket frame or signed event", async ({
    scope,
  }) => {
    const node = await relay(scope);
    const db = client(scope, node);
    const group = checked(await db.groups.create({ name: "Validation" }));
    const frames = node.frames.length;
    for (const query of [
      db.from("records"),
      db.private.from("records"),
      db.from("records").inGroup(group.id),
    ]) {
      const result = await query
        .or("or(id.eq.a,rank.unknown.1)")
        .update({ title: "MUST-NOT-ESCAPE" })
        .select();
      expect(result.error?.code).toBe("INVALID_QUERY");
      expect(result.data).toBeNull();
    }
    expect(node.frames).toHaveLength(frames);
    expect(node.events.size).toBe(0);
  });
});
