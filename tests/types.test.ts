import { expectTypeOf, it } from "vitest";
import type { ChangePayload, Result, Row } from "../src";
import { createClient } from "../src";
import type { TestDB } from "./helpers";

it("infers schema, projection, cardinality, filters and change payloads", () => {
  const client = createClient<TestDB>({ namespace: "typed", relays: ["wss://relay.test"] });
  const query = client.from("todos").select("id, title").eq("done", false).maybeSingle();
  expectTypeOf<Awaited<typeof query>>().toEqualTypeOf<
    Result<Pick<Row<TestDB["todos"]>, "id" | "title"> | null>
  >();
  expectTypeOf<Awaited<ReturnType<typeof client.from<"todos">>>>().toEqualTypeOf<
    Result<Row<TestDB["todos"]>[]>
  >();
  const groupId = "a1".repeat(32);
  const groupedSelection = client.from("todos").select("id, title").maybeSingle().inGroup(groupId);
  expectTypeOf<Awaited<typeof groupedSelection>>().toEqualTypeOf<
    Result<Pick<Row<TestDB["todos"]>, "id" | "title"> | null>
  >();
  const groupedSingle = client.from("todos").inGroup(groupId).select("done").single();
  expectTypeOf<Awaited<typeof groupedSingle>>().toEqualTypeOf<
    Result<Pick<Row<TestDB["todos"]>, "done">>
  >();
  const groupedInsert = client
    .from("todos")
    .inGroup(groupId)
    .insert({ title: "typed group", done: false })
    .select("id, done");
  expectTypeOf<Awaited<typeof groupedInsert>>().toEqualTypeOf<
    Result<Pick<Row<TestDB["todos"]>, "id" | "done">[]>
  >();
  client.channel("typed").on("nostr_changes", { table: "todos" }, (payload) => {
    expectTypeOf(payload).toEqualTypeOf<ChangePayload<TestDB["todos"]>>();
  });
  function invalidTypesOnly() {
    // @ts-expect-error unknown table
    client.from("missing");
    // @ts-expect-error wrong field type
    client.from("todos").eq("done", "false");
    // @ts-expect-error missing required data
    client.from("todos").insert({ title: "missing done" });
    // @ts-expect-error unknown field
    client.from("todos").eq("missing", true);
    // @ts-expect-error unknown selected field
    client.from("todos").select("id, missing");
    // @ts-expect-error group routing does not weaken selected field inference
    client.from("todos").inGroup(groupId).select("missing");
    // @ts-expect-error group routing does not weaken field value types
    client.from("todos").select("title").inGroup(groupId).eq("done", "false");
    // @ts-expect-error group IDs require strings
    client.from("todos").inGroup(123);
    // @ts-expect-error cannot change record id
    client.from("todos").update({ id: "new" });
  }
  expectTypeOf(invalidTypesOnly).toBeFunction();
  interface InterfaceDatabase {
    todos: { title: string; done: boolean };
  }
  const interfaceClient = createClient<InterfaceDatabase>({
    namespace: "interfaces",
    relays: ["wss://relay.test"],
  });
  expectTypeOf<Awaited<ReturnType<typeof interfaceClient.from<"todos">>>>().toEqualTypeOf<
    Result<Row<InterfaceDatabase["todos"]>[]>
  >();
  interfaceClient.close();
  client.close();
});
