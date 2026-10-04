# Password-encrypted key backup

Nostrbase supports [NIP-49](https://github.com/nostr-protocol/nips/blob/master/49.md) `ncryptsec` backups through `nostr-tools/nip49`. A backup contains a password-encrypted Nostr private key. It can be imported by another client that supports NIP-49 version 2 and the chosen scrypt cost.

This recovers your Nostr identity. It does **not** recover missing MLS device secrets, private group journals, or other local application state. Shared private collections still need the same encrypted device state described in [groups](groups.md). Group device backup is not implemented.

## Export the active local key

```ts
const backup = await db.auth.exportKey(password);
if (backup.error || !backup.data)
  throw backup.error ?? new Error("Backup unavailable");
// Save backup.data as a private file through your application's UI.
```

`exportKey()` returns `Promise<Result<string>>`. It returns only the encrypted `ncryptsec` string. The SDK copies the active `PrivateKeySigner.key`, derives its public key, and checks that it still matches the active account before and after encryption. An account change, sign-out, client close, or changed key discards the result.

Extension, remote, and other external signers return `PERMISSION_DENIED`; the SDK cannot extract their private keys. Use the signer's own backup procedure. This API does not ask an external signer to expose a key.

## Recover an identity

```ts
const restored = await db.auth.signInWithEncryptedKey(ncryptsec, password);
if (restored.error) throw restored.error;
const user = restored.data?.user;
```

`signInWithEncryptedKey()` returns `Promise<Result<Session>>`. It validates and decrypts the backup, creates a local signer from a separate copy, and clears its temporary key bytes. It follows auth revision rules: a later sign-in, sign-out, or close prevents an older operation from installing its signer. A wrong password or tampered backup leaves the existing session in place and emits no successful sign-in.

An attempted sign-in advances the auth revision even when it fails, as `signInWithSigner()` does. `auth.revisionSignal` changes on every revision; the previous signal aborts immediately when a new sign-in starts or the account signs out. Use the current signal to invalidate work bound to that revision. The current signal is also aborted after client close.

## Helpers for explicit key handling

```ts
import { encryptKey, decryptKey } from "nostrbase";

const encrypted = await encryptKey(rawPrivateKey, password);
if (encrypted.error || !encrypted.data)
  throw encrypted.error ?? new Error("Backup unavailable");
const decrypted = await decryptKey(encrypted.data, password);
if (decrypted.error || !decrypted.data)
  throw decrypted.error ?? new Error("Key unavailable");
try {
  // Transfer decrypted.data to your own key store. It is sensitive raw key data.
} finally {
  decrypted.data.fill(0);
}
```

`encryptKey()` accepts a valid 32-byte secp256k1 private scalar as `Uint8Array` and returns `Result<string>`. It copies the input and never clears the caller's array. `decryptKey()` returns `Result<Uint8Array>`; the caller owns the successful plaintext array and must clear it when done. The auth recovery method avoids returning raw key bytes.

## Options and input limits

| Option | Applies to | Default | Meaning |
| --- | --- | --- | --- |
| `logn` | Encryption/export | `16` | scrypt `N = 2 ** logn`, `r = 8`, `p = 1`; integer range `10..18` |
| `keySecurity` | Encryption/export | `2` | NIP-49 marker: `0` known insecure handling, `1` not known insecure handling, `2` untracked |
| `signal` | All four operations | None | Check cancellation before and after crypto and pending auth boundaries |

The default cost uses about 64 MiB for the scrypt table. The maximum accepted cost uses about 256 MiB plus workspace and runtime overhead. A lower cost reduces resistance to password guessing. Choose a strong password and keep the encrypted backup private.

The SDK accepts only 162-character Bech32 `ncryptsec` values with a valid checksum, 91 payload bytes, version `2`, a known security marker, and a scrypt cost within `10..18`. It checks these limits before calling the expensive KDF. Backups with a higher or lower cost are rejected. Uniform uppercase Bech32 is supported; mixed case, whitespace, and `nostr:` URI wrappers are rejected.

Passwords must contain 1 to 4096 UTF-16 code units and normalize to at most 4096 UTF-8 bytes. NIP-49 applies Unicode NFKC normalization. The SDK does not trim the password. Fresh encryption uses a random salt and nonce. Invalid input returns `INVALID_RECORD` or `INVALID_QUERY`; decryption failure returns `AUTH_FAILED`. Errors contain no key, password, backup input, or underlying crypto exception details.

## Cancellation and memory limits

```ts
const controller = new AbortController();
const backup = await db.auth.exportKey(password, { signal: controller.signal });
if (backup.error) throw backup.error;
```

The `nostr-tools` KDF is synchronous. It can block the current JavaScript thread. A signal cannot interrupt it while it runs; cancellation is checked before and after the call. Run explicit helper operations in an application worker when UI responsiveness is required.

Nostrbase clears the temporary raw key arrays it owns. It keeps the active signer's own key and the caller's input intact. JavaScript strings, garbage collector copies, and the crypto library's internal buffers cannot be reliably erased by this wrapper. The API does not claim complete memory erasure.
