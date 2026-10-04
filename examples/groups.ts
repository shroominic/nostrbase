import { createClient, PrivateKeySigner } from "../src";

interface Database {
  tasks: { title: string; done: boolean };
}
// For development only. Keep real keys in a signer or secure app key store.
const alice = PrivateKeySigner.fromKey(new Uint8Array(32).fill(1));
const bob = PrivateKeySigner.fromKey(new Uint8Array(32).fill(2));
const options = { namespace: "private-team-example", relays: ["wss://your-relay.example"] };
const owner = createClient<Database>({ ...options, signer: alice });
const member = createClient<Database>({ ...options, signer: bob });
try {
  const prepared = await member.groups.publishKeyPackage();
  if (prepared.error) throw prepared.error;
  const group = await owner.groups.create({ name: "Team workspace" });
  const inserted = await group
    .from("tasks")
    .insert({ id: "website", title: "Build the website", done: false });
  if (inserted.error) throw inserted.error;
  const invitation = await group.invite(await bob.getPublicKey());
  if (invitation.error) throw invitation.error;
  const invite = (await member.groups.invites()).find((value) => value.joinable);
  if (!invite) throw new Error("No compatible group invitation");
  const shared = await member.groups.join(invite.id);
  const result = await shared
    .from("tasks")
    .select()
    .author(await alice.getPublicKey());
  if (result.error) throw result.error;
  console.log(result.data);
} finally {
  await Promise.all([owner.closeAsync(), member.closeAsync()]);
}
