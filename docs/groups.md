# Shared private collections

Private groups use [Marmot](https://github.com/marmot-protocol/marmot), the protocol used by White Noise. Marmot combines Nostr identity and relay delivery with MLS group encryption. Applesauce remains the relay transport.

This is an **experimental** integration. The pinned Marmot engine is an unreleased 0.6.0 source snapshot. Its authors say it is not ready for production. This SDK has not had an independent cryptographic audit. Local relay tests do not establish compatibility with a released White Noise application. See [vendor provenance](../vendor/README.md).

## Is this the Supabase API?

Queries use the same builder as public tables: `.select()`, `.insert()`, `.upsert()`, `.update()`, `.delete()`, filters, field selection, sorting, and pagination.

Supabase has no built-in `groups.create()` or `group.from()`. A Supabase app usually stores group IDs and memberships in tables, then uses Row Level Security. Here, a group handle selects an encrypted Marmot scope. Members can read records in that scope. Each author can change their own records. Admins can add or remove members. There are no configurable SQL access policies.

## Create and invite

```ts
import { createClient, IndexedDBGroupStateAdapter } from "nostrbase";

// Generate this random device ID once, and save it in app settings.
// Each separate device needs its own ID and private state.
const deviceId = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const adapter = new IndexedDBGroupStateAdapter("my-app-private-groups");
const db = createClient({
  namespace: "my-app",
  relays: ["wss://your-relay.example"],
  groups: { deviceId, adapter },
});
await db.auth.signInWithExtension(); // Signer must support NIP-44.

const group = await db.groups.create({ name: "Team workspace" });
const write = await group.from("tasks").insert({
  id: "task-1", title: "Build the website", done: false,
}).select();
if (write.error) throw write.error;

// Bob must first call publishKeyPackage() on his own client and device.
const bobPubkey = "b".repeat(64); // Replace with Bob's actual public key.
const invitation = await group.invite(bobPubkey);
if (invitation.error) throw invitation.error;
```

`create()`, `get()`, `list()`, `invites()`, and `join()` return their value directly and throw on failure. Query builders and publication methods return `{ data, error, meta }`. Check their errors and receipts.

On the recipient's client:

```ts
const prepared = await db.groups.publishKeyPackage();
if (prepared.error) throw prepared.error;
// The admin can now invite this device's account.
const invitations = await db.groups.invites();
const invitation = invitations.find(value => value.joinable);
if (!invitation) throw new Error("No compatible invitation");
const group = await db.groups.join(invitation.id);
const { data, error } = await group.from("tasks").select();
```

The device advertises a kind-30443 KeyPackage and kind-10002/10050 relay lists. These public events contain cryptographic discovery data. `publishKeyPackage()` replaces this device's addressable slot. Do not rotate an unused slot repeatedly while invitations are in flight.

All group network destinations must be in the client's relay configuration. An invitation cannot silently send the client to an arbitrary peer-selected server. To join a group on other relays, configure those relays first.

## Records, history, and live changes

```ts
await group.from("tasks").update({ done: true }).eq("id", "task-1");
await group.from("tasks").delete().eq("id", "task-1");

const subscription = group.subscribe("tasks", change => {
  console.log(change.eventType, change.new, change.old);
});
await group.sync();
subscription.unsubscribe();
```

A record is identified by namespace, private MLS group ID, table, author, and record ID. Two authors can use the same ID. Use `.author(pubkey)` when selecting one author's record. A write cannot impersonate another author. Admin status gives membership control, not permission to rewrite another author's records.

The app signs each record or deletion proof. The SDK puts that proof inside an unsigned Marmot application event. MLS authenticates the sender and encrypts the whole payload. Only the signed ciphertext envelope goes to the relay. The nested proof is never published as a public record or put into the ordinary EventStore.

New members do not get past MLS secrets. After an invitation, the admin sends an encrypted snapshot of accepted record proofs and deletion requests. Original author signatures remain verifiable. The admin attests that these historical proofs were admitted to this collection. Snapshots can arrive in several messages and are not an atomic database transfer.

The engine selects the canonical MLS branch. The SDK retains record versions with that branch's confirmation tag. When convergence withdraws a branch, the projection also withdraws its records and updates subscribers. Relay timestamps and event arrival order do not select MLS state. Record version selection still uses highest signed record timestamp, then lowest event ID.

`sync()` fetches retained group envelopes with ordinary Nostr queries. Group sync currently does not use Negentropy. `db.sync` applies to public and personal record events. Relay EOSE is not proof of a complete collection.

## Membership

```ts
const status = group.info;
await group.remove(bobPubkey); // Admin only; removes the account's device leaves.
await group.rotate();         // Rotate this device's MLS leaf key.
await group.leave();          // Publish a departure proposal and close this handle.
```

Joining performs the required leaf update after reading the Welcome. Membership operations are MLS commits or proposals, not database transactions. Other members must receive the commit before they use the new epoch. A removal stops access to future epoch secrets. It cannot erase plaintext or old keys already held by the removed member.

The SDK rejects newly admitted record mutations from authors that are absent from its current canonical membership. It keeps records already admitted before removal. This rule depends on receiving the membership commit; disconnected clients cannot know a change that they have not received.

## Offline writes and recovery

```ts
await group.from("tasks").insert({ title: "Write offline", done: false }).queue();
await group.flush(); // First sync membership; then encrypt queued signed intents.

await db.groups.flush(); // Replay existing exact envelopes and retry Welcomes.
const reopened = await db.groups.get(group.id);
```

Queued group writes store signed application intents under self encryption. They are not put into the canonical local projection until publication is accepted. On flush, the SDK first catches up membership and encrypts the intent for the current epoch. Once ciphertext has been prepared, retry uses that exact envelope. An unresolved publication blocks new sends until recovery.

The SDK saves an encrypted publication journal before ciphertext leaves the device. It retains the parent and child MLS states for commits, consumed sender ratchets, exact envelopes, application proofs, and unfinished Welcome deliveries. Accepted acknowledgements are preserved even if local completion fails. A failed batch retains accepted rows and receipts. `minWriteAcks` affects SDK success reporting; one real acknowledgement already means a commit left the device, so recovery must preserve it.

If recovery changes stored MLS state, old handles are closed. Get a fresh handle after `db.groups.flush()`. Sign-out and account changes also close existing handles and clear the plaintext projection.

Memory storage is the default. Durable restart requires the same Nostr account, stable random device ID, and encrypted adapter. Back up device state before changing browser profiles. A Nostr private key alone does not reconstruct device MLS secrets. Ordinary event backups do not include private group state. Do not share one MLS device state between concurrent tabs or processes; coordinate one writer in the app.

The SDK closes an adapter it creates. The app owns a supplied adapter:

```ts
await db.closeAsync();
await adapter.close();
```

## Limits

Relays do not receive plaintext group names or the private MLS group ID. Local storage keys can contain the group ID and account/device scope; their values are encrypted. Relays still see configured destinations, random routing IDs, ciphertext sizes and timing. KeyPackage accounts and invitation recipients are public routing data.

Group queries, schema validation, search, and pagination run on the client. The group API does not add SQL joins, foreign key enforcement, global uniqueness, arbitrary RLS, server functions, atomic batches, automatic encrypted attachments, or guaranteed permanent relay storage. Retained history and journals need app storage planning.
