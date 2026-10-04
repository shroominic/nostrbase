import { createClient, PrivateKeySigner } from "nostrbase";

// Application code must obtain the password from its own secure input UI.
export async function recoverIdentity(password: string): Promise<void> {
  const source = createClient({
    namespace: "key-backup-example",
    relays: ["wss://your-relay.example"],
    signer: new PrivateKeySigner(),
  });
  const recovered = createClient({
    namespace: "key-backup-example",
    relays: ["wss://your-relay.example"],
  });
  try {
    const backup = await source.auth.exportKey(password);
    if (backup.error || !backup.data)
      throw backup.error ?? new Error("Encrypted backup unavailable");
    // Save backup.data as a private file in the application. Do not publish it to relays.
    const result = await recovered.auth.signInWithEncryptedKey(backup.data, password);
    if (result.error || !result.data) throw result.error ?? new Error("Identity recovery failed");
    console.log("Recovered public identity", result.data.user.pubkey);
    // This restores the identity only. Missing MLS device state is not recovered.
  } finally {
    await Promise.all([source.closeAsync(), recovered.closeAsync()]);
  }
}
