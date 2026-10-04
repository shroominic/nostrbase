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
  if (prepared.error) {
    console.error("KeyPackage receipts", prepared.meta?.receipts);
    throw prepared.error;
  }
  const created = await owner.groups.create({ name: "Team workspace" });
  if (created.error) throw created.error;
  if (!created.data) throw new Error("Group unavailable");
  const group = created.data;
  const inserted = await owner
    .from("tasks")
    .inGroup(group.id)
    .insert({ id: "website", title: "Build the website", done: false });
  if (inserted.error) {
    console.error("Write receipts", inserted.meta?.receipts);
    throw inserted.error;
  }
  const invitation = await group.invite(await bob.getPublicKey());
  if (invitation.error) {
    console.error("Invitation receipts", invitation.meta?.receipts);
    throw invitation.error;
  }
  const invitations = await member.groups.invites();
  if (invitations.error) throw invitations.error;
  const invite = invitations.data?.find((value) => value.joinable);
  if (!invite) throw new Error("No compatible group invitation");
  const joined = await member.groups.join(invite.id);
  if (joined.error) {
    // A partial join can return its group handle and accepted publication receipts.
    console.error("Join recovery", joined.data?.id, joined.meta?.receipts);
    throw joined.error;
  }
  if (!joined.data) throw new Error("Joined group unavailable");
  const result = await member
    .from("tasks")
    .inGroup(joined.data.id)
    .select()
    .author(await alice.getPublicKey());
  if (result.error) throw result.error;
  console.log(result.data);
} finally {
  await Promise.all([owner.closeAsync(), member.closeAsync()]);
}
