import { expectTypeOf, it } from "vitest";
import type { Result, Row } from "../src";
import { createClient } from "../src";

interface Database {
  tasks: {
    title: string;
    done: boolean;
    rank: number | null;
    labels: string[];
    details: { owner: { name: string; active: boolean }; scores: number[] };
  };
}
it("keeps strict plain fields and infers nested JSON values across query projections", () => {
  const db = createClient<Database>({ namespace: "query-types", relays: ["wss://relay.test"] });
  const base = db.from("tasks");
  const query = base
    .eq("details->owner->name", "Ada")
    .eq("details->scores->0", 3)
    .eq("details->owner->>active", "true")
    .contains("details", { owner: { name: "Ada" } })
    .filter("rank", "in", [1, null])
    .select("id,title")
    .maybeSingle();
  expectTypeOf<Awaited<typeof query>>().toEqualTypeOf<
    Result<Pick<Row<Database["tasks"]>, "id" | "title"> | null>
  >();
  base
    .like("title", "A%")
    .ilike("details->owner->>name", "a%")
    .overlaps("labels", ["x"])
    .not("done", "eq", false)
    .containedBy("labels", ["a", "b"])
    .order("rank", { nullsFirst: true })
    .select("*", { count: "exact", head: true });
  base.not("id", "in", "(a,b)").not("labels", "cs", "{red}").filter("rank", "is", "null");
  function invalid() {
    // @ts-expect-error wrong plain-field type remains rejected
    base.eq("done", "false");
    // @ts-expect-error unknown plain field is not admitted by JSON path overloads
    base.eq("missing", true);
    // @ts-expect-error primitive fields do not have JSON paths
    base.eq("title->name", "Ada");
    // @ts-expect-error known JSON numeric values retain their type
    base.eq("details->scores->0", "3");
    // @ts-expect-error known nested boolean values retain their type
    base.eq("details->owner->active", "true");
    // @ts-expect-error text extraction returns text
    base.eq("details->owner->>active", true);
    // @ts-expect-error filter does not widen a known field to arbitrary values
    base.filter("done", "eq", 1);
    // @ts-expect-error not does not widen a known field to arbitrary values
    base.not("done", "eq", 1);
    // @ts-expect-error unknown plain filter field
    base.filter("missing", "eq", "x");
    // @ts-expect-error invalid known nested containment value
    base.contains("details", { owner: { active: "true" } });
    // @ts-expect-error unsupported count contract
    base.select("*", { count: "planned" });
    // @ts-expect-error unsupported operator
    base.filter("title", "search", "x");
  }
  expectTypeOf(invalid).toBeFunction();
  db.close();
});
