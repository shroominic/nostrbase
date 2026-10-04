import { bech32 } from "@scure/base";
import { PrivateKeySigner } from "applesauce-signers";
import { verifyEvent } from "nostr-tools";
import * as nip49 from "nostr-tools/nip49";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NostrbaseAuth } from "../src/auth";
import { NostrbaseError } from "../src/errors";
import type { KeyEncryptionOptions } from "../src/key-backup";
import { decryptKey, encryptKey } from "../src/key-backup";
import { alice, bob } from "./helpers";
import { deferred, required } from "./support/lifecycle";

vi.mock("nostr-tools/nip49", async (original) => {
  const actual = await original<typeof import("nostr-tools/nip49")>();
  return { ...actual, encrypt: vi.fn(actual.encrypt), decrypt: vi.fn(actual.decrypt) };
});
const original = await vi.importActual<typeof import("nostr-tools/nip49")>("nostr-tools/nip49");
const password = "NIP49-DEVELOPMENT-PASSWORD";
const key = () => new Uint8Array(32).fill(3);
const vector =
  "ncryptsec1qgg9947rlpvqu76pj5ecreduf9jxhselq2nae2kghhvd5g7dgjtcxfqtd67p9m0w57lspw8gsq6yphnm8623nsl8xn9j4jdzz84zm3frztj3z7s35vpzmqf6ksu8r89qk5z2zxfmu5gv8th8wclt0h4p";
const vectorKey = Uint8Array.from(
  Buffer.from("3501454135014541350145413501453fefb02227e449e57cf4d3a3ce05378683", "hex"),
);
function bytes(value: string): Uint8Array {
  return bech32.fromWords(bech32.decode(value, 162).words);
}
function encoded(value: Uint8Array, prefix = "ncryptsec"): string {
  return bech32.encode(prefix, bech32.toWords(value), 200);
}
function cleanError(error: NostrbaseError | null): void {
  expect(error).not.toBeNull();
  expect(error?.details).toBeUndefined();
  expect(JSON.stringify(error)).not.toContain(password);
  expect(JSON.stringify(error)).not.toContain(vector);
  expect(error?.message).not.toContain(vector);
  expect(error?.message).not.toContain(password);
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(nip49.encrypt).mockReset().mockImplementation(original.encrypt);
  vi.mocked(nip49.decrypt).mockReset().mockImplementation(original.decrypt);
});

describe("bounded interoperable NIP-49 key backup", () => {
  it("decrypts the independent published NIP-49 vector and its uppercase Bech32 form", async () => {
    // Source: https://github.com/nostr-protocol/nips/blob/master/49.md#decryption
    for (const value of [vector, vector.toUpperCase()]) {
      const result = await decryptKey(value, "nostr");
      expect(result.error).toBeNull();
      expect(result.data).toEqual(vectorKey);
      result.data?.fill(0);
    }
  });

  it("uses fresh salts/nonces, NFKC password normalization, and upstream encryption/decryption in both directions", async () => {
    const raw = key();
    const snapshot = raw.slice();
    const first = await encryptKey(raw, "ÅΩẛ̣", { logn: 10, keySecurity: 1 });
    const second = await encryptKey(raw, "ÅΩṩ", { logn: 10, keySecurity: 1 });
    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    const a = required(first.data);
    const b = required(second.data);
    expect(a).not.toBe(b);
    expect(bytes(a).slice(2, 18)).not.toEqual(bytes(b).slice(2, 18));
    expect(bytes(a).slice(18, 42)).not.toEqual(bytes(b).slice(18, 42));
    expect(bytes(a)[42]).toBe(1);
    const recovered = original.decrypt(a, "ÅΩṩ");
    expect(recovered).toEqual(snapshot);
    recovered.fill(0);
    const foreign = original.encrypt(raw, "ÅΩẛ̣", 10, 0);
    const imported = await decryptKey(foreign, "ÅΩṩ");
    expect(imported.error).toBeNull();
    expect(imported.data).toEqual(snapshot);
    imported.data?.fill(0);
    expect(raw).toEqual(snapshot);
  });

  it("defaults to logn16 and an untracked handling marker, and clears only its own raw key copy", async () => {
    const raw = key();
    const result = await encryptKey(raw, password);
    expect(result.error).toBeNull();
    expect(bytes(required(result.data)).slice(0, 2)).toEqual(new Uint8Array([2, 16]));
    expect(bytes(required(result.data))[42]).toBe(2);
    const copied = required(vi.mocked(nip49.encrypt).mock.calls[0]?.[0]);
    expect(copied).not.toBe(raw);
    expect(copied.every((value) => value === 0)).toBe(true);
    expect(raw).toEqual(key());
  });

  it("interoperates at the maximum supported logn18 cost", async () => {
    const result = await encryptKey(key(), password, { logn: 18 });
    expect(result.error).toBeNull();
    expect(bytes(required(result.data))[1]).toBe(18);
    const recovered = await decryptKey(required(result.data), password);
    expect(recovered.error).toBeNull();
    expect(recovered.data).toEqual(key());
    recovered.data?.fill(0);
  });

  it("rejects an authenticated envelope containing an invalid private scalar and clears its plaintext", async () => {
    const encrypted = original.encrypt(new Uint8Array(32).fill(255), password, 10);
    let temporary: Uint8Array | undefined;
    vi.mocked(nip49.decrypt).mockImplementationOnce((value, secret) => {
      temporary = original.decrypt(value, secret);
      return temporary;
    });
    const result = await decryptKey(encrypted, password);
    expect(result.data).toBeNull();
    expect(result.error?.code).toBe("INVALID_RECORD");
    expect(required(temporary).every((value) => value === 0)).toBe(true);
  });

  it("rejects invalid private scalars and unsafe encryption options before invoking the KDF", async () => {
    for (const invalid of [
      new Uint8Array(31),
      new Uint8Array(32),
      new Uint8Array(32).fill(255),
      new Uint8Array(33),
    ]) {
      const result = await encryptKey(invalid, password, { logn: 10 });
      expect(result.error?.code).toBe("INVALID_RECORD");
      cleanError(result.error);
    }
    for (const logn of [0, 9, 19, 255, 10.5, NaN, Infinity]) {
      expect((await encryptKey(key(), password, { logn })).error?.code).toBe("INVALID_QUERY");
    }
    for (const invalid of ["", "x".repeat(4097), "é".repeat(4096)]) {
      expect((await encryptKey(key(), invalid, { logn: 10 })).error?.code).toBe("INVALID_QUERY");
    }
    expect(
      (await encryptKey(key(), password, { keySecurity: 3 } as unknown as KeyEncryptionOptions))
        .error?.code,
    ).toBe("INVALID_QUERY");
    expect(nip49.encrypt).not.toHaveBeenCalled();
  });

  it("bounds envelope format, checksum, payload length, version, security marker, and encoded KDF before decrypting", async () => {
    const payload = bytes(vector);
    const malformed = [
      "CIPHER-DO-NOT-LOG",
      `${vector}q`,
      vector.slice(0, -1),
      `nostr:${vector}`,
      `${vector.slice(0, -1)}q`,
      `N${vector.slice(1)}`,
      encoded(payload, "wrong"),
    ];
    for (const index of [0, 1, 42]) {
      const copy = payload.slice();
      copy[index] = index === 1 ? 255 : 3;
      malformed.push(encoded(copy));
    }
    for (const length of [90, 92]) malformed.push(encoded(new Uint8Array(length)));
    for (const logn of [0, 9, 19, 31, 255]) {
      const copy = payload.slice();
      copy[1] = logn;
      malformed.push(encoded(copy));
    }
    for (const value of malformed) {
      const result = await decryptKey(value, password);
      expect(result.data).toBeNull();
      expect(result.error?.code).toBe("INVALID_RECORD");
      cleanError(result.error);
      expect(result.error?.message).not.toContain(value);
    }
    expect(nip49.decrypt).not.toHaveBeenCalled();
  });

  it("rejects wrong passwords and authenticated ciphertext tampering without including secret inputs in errors", async () => {
    const encrypted = original.encrypt(key(), password, 10);
    const payload = bytes(encrypted);
    payload[55] = (payload[55] ?? 0) ^ 1;
    for (const [cipher, secret] of [
      [encrypted, "wrong"],
      [encoded(payload), password],
    ]) {
      const result = await decryptKey(required(cipher), required(secret));
      expect(result.data).toBeNull();
      expect(result.error?.code).toBe("AUTH_FAILED");
      cleanError(result.error);
    }
    vi.mocked(nip49.decrypt).mockImplementationOnce(() => {
      throw new NostrbaseError("AUTH_FAILED", password, { cipher: vector });
    });
    cleanError((await decryptKey(encrypted, password)).error);
  });

  it("checks cancellation before crypto and clears decrypted bytes if cancellation occurs during crypto", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      (await encryptKey(key(), password, { logn: 10, signal: controller.signal })).error?.code,
    ).toBe("ABORTED");
    expect((await decryptKey(vector, password, { signal: controller.signal })).error?.code).toBe(
      "ABORTED",
    );
    expect(nip49.encrypt).not.toHaveBeenCalled();
    expect(nip49.decrypt).not.toHaveBeenCalled();
    const encryptionAbort = new AbortController();
    vi.mocked(nip49.encrypt).mockImplementationOnce((...args) => {
      const data = original.encrypt(...args);
      encryptionAbort.abort();
      return data;
    });
    const cancelledExport = await encryptKey(key(), password, {
      logn: 10,
      signal: encryptionAbort.signal,
    });
    expect(cancelledExport.data).toBeNull();
    expect(cancelledExport.error?.code).toBe("ABORTED");
    const later = new AbortController();
    const encrypted = original.encrypt(key(), password, 10);
    let temporary: Uint8Array | undefined;
    vi.mocked(nip49.decrypt).mockImplementationOnce((value, secret) => {
      temporary = original.decrypt(value, secret);
      later.abort();
      return temporary;
    });
    const result = await decryptKey(encrypted, password, { signal: later.signal });
    expect(result.error?.code).toBe("ABORTED");
    expect(result.data).toBeNull();
    expect(required(temporary).every((value) => value === 0)).toBe(true);
  });
});

describe("auth encrypted key recovery and export", () => {
  it("exports and imports only encrypted key data, preserving a usable recovered signer and the live/caller key", async () => {
    const raw = key();
    const signer = new PrivateKeySigner(raw);
    const auth = new NostrbaseAuth(signer);
    const recovered = new NostrbaseAuth();
    try {
      await auth.getSession();
      const result = await auth.exportKey(password, { logn: 10 });
      expect(result.error).toBeNull();
      expect(result.data).toMatch(/^ncryptsec1/);
      expect(raw).toEqual(key());
      const signedIn = await recovered.signInWithEncryptedKey(required(result.data), password);
      expect(signedIn.error).toBeNull();
      expect(signedIn.data?.user.pubkey).toBe(await signer.getPublicKey());
      const active = await recovered.requireSigner();
      const event = await active.signer.signEvent({
        kind: 1,
        content: "usable recovered signer",
        tags: [],
        created_at: 10,
      });
      expect(verifyEvent(event)).toBe(true);
      expect(event.pubkey).toBe(await signer.getPublicKey());
      const copied = required(vi.mocked(nip49.encrypt).mock.calls[0]?.[0]);
      expect(copied.every((value) => value === 0)).toBe(true);
      expect((active.signer as PrivateKeySigner).key).toEqual(key());
    } finally {
      auth.dispose();
      recovered.dispose();
    }
  });

  it("preserves a working session and emits no sign-in on wrong password or tampered backup", async () => {
    const auth = new NostrbaseAuth(alice);
    const encrypted = original.encrypt(key(), password, 10);
    try {
      await auth.getSession();
      const events: string[] = [];
      auth.onAuthStateChange((event) => events.push(event));
      expect((await auth.signInWithEncryptedKey(encrypted, "wrong")).error?.code).toBe(
        "AUTH_FAILED",
      );
      const payload = bytes(encrypted);
      payload[55] = (payload[55] ?? 0) ^ 1;
      expect((await auth.signInWithEncryptedKey(encoded(payload), password)).error?.code).toBe(
        "AUTH_FAILED",
      );
      expect((await auth.requireSigner()).signer).toBe(alice);
      expect(events).not.toContain("SIGNED_IN");
    } finally {
      auth.dispose();
    }
  });

  it("refuses export from external signers, even if they expose a key-shaped field", async () => {
    const external = {
      key: key(),
      getPublicKey: alice.getPublicKey.bind(alice),
      signEvent: alice.signEvent.bind(alice),
    };
    const auth = new NostrbaseAuth(external);
    try {
      await auth.getSession();
      const result = await auth.exportKey(password, { logn: 10 });
      expect(result.data).toBeNull();
      expect(result.error?.code).toBe("PERMISSION_DENIED");
      cleanError(result.error);
      expect(nip49.encrypt).not.toHaveBeenCalled();
      expect(external.key).toEqual(key());
    } finally {
      auth.dispose();
    }
  });

  it.each(["replacement", "signout", "close", "mutation"] as const)(
    "discards export if %s changes the active key during encryption",
    async (mode) => {
      const signer = new PrivateKeySigner(key());
      const auth = new NostrbaseAuth(signer);
      try {
        await auth.getSession();
        vi.mocked(nip49.encrypt).mockImplementationOnce((...args) => {
          if (mode === "replacement") void auth.signInWithSigner(bob);
          if (mode === "signout") void auth.signOut();
          if (mode === "close") auth.dispose();
          if (mode === "mutation") signer.key.fill(2);
          return original.encrypt(...args);
        });
        const result = await auth.exportKey(password, { logn: 10 });
        expect(result.data).toBeNull();
        expect(result.error?.code).toBe(mode === "close" ? "CLIENT_CLOSED" : "AUTH_FAILED");
        cleanError(result.error);
        expect(signer.key).toEqual(new Uint8Array(32).fill(mode === "mutation" ? 2 : 3));
        expect(
          required(vi.mocked(nip49.encrypt).mock.calls[0]?.[0]).every((value) => value === 0),
        ).toBe(true);
      } finally {
        auth.dispose();
      }
    },
  );

  it.each(["replacement", "same-key", "signout", "close", "abort"] as const)(
    "does not commit decrypted sign-in after %s while its public key is pending",
    async (mode) => {
      const auth = new NostrbaseAuth(alice);
      const encrypted = original.encrypt(key(), password, 10);
      const entered = deferred();
      const release = deferred();
      let temporary: PrivateKeySigner | undefined;
      const controller = new AbortController();
      const get = PrivateKeySigner.prototype.getPublicKey;
      await auth.getSession();
      const lookup = vi
        .spyOn(PrivateKeySigner.prototype, "getPublicKey")
        .mockImplementation(async function (this: PrivateKeySigner) {
          if (this !== alice && this !== bob) {
            temporary = this;
            entered.resolve();
            await release.promise;
          }
          return get.call(this);
        });
      try {
        const pending = auth.signInWithEncryptedKey(encrypted, password, {
          signal: controller.signal,
        });
        await entered.promise;
        if (mode === "replacement") expect((await auth.signInWithSigner(bob)).error).toBeNull();
        if (mode === "same-key") expect((await auth.signInWithSigner(alice)).error).toBeNull();
        if (mode === "signout") await auth.signOut();
        if (mode === "close") auth.dispose();
        if (mode === "abort") controller.abort();
        release.resolve();
        const result = await pending;
        expect(result.data).toBeNull();
        expect(result.error?.code).toBe(
          mode === "close" ? "CLIENT_CLOSED" : mode === "abort" ? "ABORTED" : "AUTH_FAILED",
        );
        expect(required(temporary).key.every((value) => value === 0)).toBe(true);
        if (mode === "replacement") expect((await auth.requireSigner()).signer).toBe(bob);
        if (mode === "same-key" || mode === "abort")
          expect((await auth.requireSigner()).signer).toBe(alice);
        if (mode === "signout" || mode === "close")
          expect((await auth.getSession()).data).toBeNull();
      } finally {
        release.resolve();
        lookup.mockRestore();
        auth.dispose();
      }
    },
  );

  it("aborts revision signals at sign-in start, sign-out and close, including reentrant replacements", async () => {
    const auth = new NostrbaseAuth(alice);
    await auth.getSession();
    const prior = auth.revisionSignal;
    const pubkey = deferred<string>();
    const pending = auth.signInWithSigner({
      getPublicKey: () => pubkey.promise,
      signEvent: alice.signEvent.bind(alice),
    });
    expect(prior.aborted).toBe(true);
    const replacing = auth.revisionSignal;
    expect(replacing.aborted).toBe(false);
    await auth.signOut();
    expect(replacing.aborted).toBe(true);
    pubkey.resolve(await alice.getPublicKey());
    expect((await pending).error?.code).toBe("AUTH_FAILED");
    auth.revisionSignal.addEventListener(
      "abort",
      () => {
        void auth.signInWithSigner(bob);
      },
      { once: true },
    );
    expect((await auth.signInWithSigner(alice)).error?.code).toBe("AUTH_FAILED");
    expect((await auth.requireSigner()).signer).toBe(bob);
    auth.dispose();
    expect(auth.revisionSignal.aborted).toBe(true);
  });

  it("settles only the current auth transition and wakes the retained identity after failed sign-in", async () => {
    const auth = new NostrbaseAuth(alice);
    const first = deferred<string>();
    const second = deferred<string>();
    const callbacks: boolean[] = [];
    await auth.getSession();
    const subscription = auth.onRevisionSettled(() => callbacks.push(auth.revisionSettled));
    try {
      const oldAttempt = auth.signInWithSigner({
        getPublicKey: () => first.promise,
        signEvent: alice.signEvent.bind(alice),
      });
      expect(auth.revisionSettled).toBe(false);
      const currentAttempt = auth.signInWithSigner({
        getPublicKey: () => second.promise,
        signEvent: alice.signEvent.bind(alice),
      });
      first.resolve(await alice.getPublicKey());
      expect((await oldAttempt).error?.code).toBe("AUTH_FAILED");
      expect(auth.revisionSettled).toBe(false);
      expect(callbacks).toEqual([]);
      second.resolve("invalid-public-key");
      expect((await currentAttempt).error?.code).toBe("AUTH_FAILED");
      expect(auth.revisionSettled).toBe(true);
      expect((await auth.requireSigner()).signer).toBe(alice);
      expect(callbacks).toEqual([true]);
      expect(
        (await auth.signInWithEncryptedKey(original.encrypt(key(), password, 10), "wrong")).error
          ?.code,
      ).toBe("AUTH_FAILED");
      expect(callbacks).toEqual([true, true]);
      subscription.unsubscribe();
      await auth.signOut();
      expect(auth.revisionSettled).toBe(true);
      expect(callbacks).toEqual([true, true]);
    } finally {
      first.resolve("invalid-public-key");
      second.resolve("invalid-public-key");
      subscription.unsubscribe();
      auth.dispose();
    }
  });

  it("prioritizes client close when encrypted recovery fails during decryption", async () => {
    const auth = new NostrbaseAuth(alice);
    const encrypted = original.encrypt(key(), password, 10);
    try {
      await auth.getSession();
      vi.mocked(nip49.decrypt).mockImplementationOnce(() => {
        auth.dispose();
        throw new Error("decryption failure");
      });
      expect((await auth.signInWithEncryptedKey(encrypted, password)).error?.code).toBe(
        "CLIENT_CLOSED",
      );
    } finally {
      auth.dispose();
    }
  });
});
