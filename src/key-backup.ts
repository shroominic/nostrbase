import { bech32 } from "@scure/base";
import { getPublicKey } from "nostr-tools";
import * as nip49 from "nostr-tools/nip49";
import type { ErrorCode } from "./errors";
import { NostrbaseError } from "./errors";
import type { Result } from "./types";

export interface KeyEncryptionOptions {
  /** NIP-49 scrypt cost. Defaults to 16 (about 64 MiB); supported range is 10 to 18. */
  logn?: number;
  /** NIP-49 key handling marker: insecure, not known insecure, or untracked (default). */
  keySecurity?: 0 | 1 | 2;
  signal?: AbortSignal;
}
export interface KeyDecryptionOptions {
  signal?: AbortSignal;
}

const encodedLength = 162;
const maxPasswordLength = 4096;
const minLogn = 10;
const maxLogn = 18;
// scrypt r=8, p=1: the main table and workspace need 128*r*(N+p+1) bytes.
const maxKdfBytes = 128 * 8 * (2 ** maxLogn + 2);
class BackupFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}
function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new BackupFailure("ABORTED", "Key operation was aborted.");
}
function passwordInput(password: string): void {
  if (typeof password !== "string" || !password.length || password.length > maxPasswordLength)
    throw new BackupFailure("INVALID_QUERY", "Use a password with 1 to 4096 characters.");
  if (new TextEncoder().encode(password.normalize("NFKC")).length > maxPasswordLength)
    throw new BackupFailure("INVALID_QUERY", "Normalized password exceeds 4096 UTF-8 bytes.");
}
function cost(logn: number, code: ErrorCode): void {
  if (
    !Number.isSafeInteger(logn) ||
    logn < minLogn ||
    logn > maxLogn ||
    128 * 8 * (2 ** logn + 2) > maxKdfBytes
  )
    throw new BackupFailure(code, "Supported NIP-49 scrypt logn is 10 to 18.");
}
function privateKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.length !== 32)
    throw new BackupFailure("INVALID_RECORD", "Use a valid 32-byte private key.");
  try {
    getPublicKey(key);
  } catch {
    throw new BackupFailure("INVALID_RECORD", "Use a valid 32-byte private key.");
  }
}
function envelope(value: string): void {
  if (
    typeof value !== "string" ||
    value.length !== encodedLength ||
    !/^(ncryptsec1[023456789acdefghjklmnpqrstuvwxyz]+|NCRYPTSEC1[023456789ACDEFGHJKLMNPQRSTUVWXYZ]+)$/.test(
      value,
    )
  )
    throw new BackupFailure("INVALID_RECORD", "Use a valid NIP-49 encrypted private key.");
  let bytes: Uint8Array;
  try {
    const decoded = bech32.decode(value, encodedLength);
    if (decoded.prefix !== "ncryptsec") throw new Error();
    bytes = bech32.fromWords(decoded.words);
  } catch {
    throw new BackupFailure("INVALID_RECORD", "Use a valid NIP-49 encrypted private key.");
  }
  if (bytes.length !== 91 || bytes[0] !== 2 || ![0, 1, 2].includes(bytes[42] ?? -1))
    throw new BackupFailure("INVALID_RECORD", "Encrypted key has an unsupported NIP-49 format.");
  cost(bytes[1] ?? -1, "INVALID_RECORD");
}
function failure(error: unknown, message: string): NostrbaseError {
  return error instanceof BackupFailure
    ? new NostrbaseError(error.code, error.message)
    : new NostrbaseError("AUTH_FAILED", message);
}

/** Encrypt a copied raw private key as an interoperable NIP-49 ncryptsec string. */
export async function encryptKey(
  key: Uint8Array,
  password: string,
  options: KeyEncryptionOptions = {},
): Promise<Result<string>> {
  let copy: Uint8Array | undefined;
  try {
    if (!options || typeof options !== "object" || Array.isArray(options))
      throw new BackupFailure("INVALID_QUERY", "Use key encryption options.");
    cancelled(options.signal);
    passwordInput(password);
    const logn = options.logn ?? 16;
    const marker = options.keySecurity ?? 2;
    cost(logn, "INVALID_QUERY");
    if (![0, 1, 2].includes(marker))
      throw new BackupFailure("INVALID_QUERY", "Key security marker must be 0, 1, or 2.");
    privateKey(key);
    copy = new Uint8Array(key);
    await Promise.resolve();
    cancelled(options.signal);
    const data = nip49.encrypt(copy, password, logn, marker);
    cancelled(options.signal);
    return { data, error: null };
  } catch (error) {
    return { data: null, error: failure(error, "Key encryption failed.") };
  } finally {
    copy?.fill(0);
  }
}

/** Decrypt a bounded NIP-49 envelope. The caller owns and must clear successful key bytes. */
export async function decryptKey(
  ncryptsec: string,
  password: string,
  options: KeyDecryptionOptions = {},
): Promise<Result<Uint8Array>> {
  let key: Uint8Array | undefined;
  try {
    if (!options || typeof options !== "object" || Array.isArray(options))
      throw new BackupFailure("INVALID_QUERY", "Use key decryption options.");
    cancelled(options.signal);
    passwordInput(password);
    envelope(ncryptsec);
    await Promise.resolve();
    cancelled(options.signal);
    key = nip49.decrypt(ncryptsec, password);
    cancelled(options.signal);
    privateKey(key);
    const data = key;
    key = undefined;
    return { data, error: null };
  } catch (error) {
    return { data: null, error: failure(error, "Could not decrypt the private key.") };
  } finally {
    key?.fill(0);
  }
}
