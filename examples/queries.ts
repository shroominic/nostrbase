import { createClient } from "nostrbase";

interface Database {
  tasks: {
    title: string;
    done: boolean;
    rank: number | null;
    labels: string[];
    details: { owner: { name: string; active: boolean }; scores: number[] };
  };
}
const db = createClient<Database>({
  namespace: "com.example.rich-queries",
  relays: ["wss://relay.example"],
  schema: { tasks: {} },
});
try {
  const base = db
    .from("tasks")
    .eq("done", false)
    .contains("details", { owner: { name: "Ada" } });
  const result = await base
    .or('and(rank.gte.2,labels.ov.{red}),title.ilike."%review%"')
    .order("rank", { ascending: false, nullsFirst: false })
    .select("id,title", { count: "exact" })
    .range(0, 9);
  if (result.error) throw result.error;
  console.log(result.data, result.count);
  const head = await base.select("*", { count: "exact", head: true });
  if (head.error) throw head.error;
  console.log("Matching verified records:", head.count);
  const local = await db
    .from("tasks")
    .local()
    .eq("details->owner->>active", "true")
    .not("labels", "ov", ["archived"])
    .like("title", "10\\%\\_done%");
  if (local.error) throw local.error;
  console.log(local.data);
} finally {
  await db.closeAsync();
}
