import { getEventHash } from "nostr-tools";
import { NostrbaseError } from "./errors";
import { verify } from "./protocol";
import type { NostrEvent, Signer } from "./types";

/** Durable storage receives ciphertext strings only; one adapter can serve many scoped stores. */
export interface GroupStateAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
  close(): void | Promise<void>;
}

export class MemoryGroupStateAdapter implements GroupStateAdapter {
  private values = new Map<string, string>();
  private closed = false;
  private assertOpen(): void {
    if (this.closed) throw new NostrbaseError("CLIENT_CLOSED", "Group state adapter is closed.");
  }
  async get(key: string): Promise<string | null> {
    this.assertOpen();
    return this.values.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.assertOpen();
    if (typeof value !== "string")
      throw new NostrbaseError(
        "INVALID_RECORD",
        "Group state adapter values must be ciphertext strings.",
      );
    this.values.set(key, value);
  }
  async remove(key: string): Promise<void> {
    this.assertOpen();
    this.values.delete(key);
  }
  async keys(): Promise<string[]> {
    this.assertOpen();
    return [...this.values.keys()];
  }
  close(): void {
    this.closed = true;
  }
}

/** A write resolves only after IndexedDB commits. Close and open failures reject operations. */
export class IndexedDBGroupStateAdapter implements GroupStateAdapter {
  private database: Promise<IDBDatabase>;
  private closed = false;
  private closing?: Promise<void>;
  constructor(name = "nostrbase-groups", factory: IDBFactory | undefined = globalThis.indexedDB) {
    if (!factory)
      throw new NostrbaseError("INVALID_CONFIG", "IndexedDB is unavailable for group state.");
    if (typeof name !== "string" || !name.trim())
      throw new NostrbaseError("INVALID_CONFIG", "Set a group state database name.");
    this.database = new Promise((resolve, reject) => {
      let failed = false;
      const request = factory.open(name, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("state"))
          request.result.createObjectStore("state");
      };
      request.onerror = () => {
        failed = true;
        reject(request.error ?? new Error("Group state database could not open."));
      };
      request.onblocked = () => {
        failed = true;
        reject(new Error("Group state database upgrade is blocked by another tab."));
      };
      request.onsuccess = () => {
        const db = request.result;
        if (failed) {
          db.close();
          reject(
            new NostrbaseError(
              "CLIENT_CLOSED",
              "Group state adapter closed before the database opened.",
            ),
          );
          return;
        }
        if (this.closed) db.close();
        db.onversionchange = () => {
          this.closed = true;
          db.close();
        };
        db.onclose = () => {
          this.closed = true;
        };
        resolve(db);
      };
    });
    void this.database.catch(() => {});
  }
  private assertOpen(): void {
    if (this.closed) throw new NostrbaseError("CLIENT_CLOSED", "Group state adapter is closed.");
  }
  private async transact<T>(
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    this.assertOpen();
    const database = await this.database;
    this.assertOpen();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction("state", mode);
      let request: IDBRequest<T>;
      try {
        request = action(transaction.objectStore("state"));
      } catch (error) {
        transaction.abort();
        reject(error);
        return;
      }
      transaction.oncomplete = () => {
        try {
          this.assertOpen();
          resolve(request.result);
        } catch (error) {
          reject(error);
        }
      };
      transaction.onerror = () =>
        reject(transaction.error ?? request.error ?? new Error("Group state transaction failed."));
      transaction.onabort = () =>
        reject(transaction.error ?? request.error ?? new Error("Group state transaction aborted."));
    });
  }
  async get(key: string): Promise<string | null> {
    const value: unknown = await this.transact("readonly", (store) => store.get(key));
    if (value === undefined) return null;
    if (typeof value !== "string")
      throw new NostrbaseError("INVALID_RECORD", "Stored group state is not a ciphertext string.");
    return value;
  }
  async set(key: string, value: string): Promise<void> {
    if (typeof value !== "string")
      throw new NostrbaseError(
        "INVALID_RECORD",
        "Group state adapter values must be ciphertext strings.",
      );
    await this.transact("readwrite", (store) => store.put(value, key));
  }
  async remove(key: string): Promise<void> {
    await this.transact("readwrite", (store) => store.delete(key));
  }
  async keys(): Promise<string[]> {
    const keys = await this.transact("readonly", (store) => store.getAllKeys());
    if (keys.some((key) => typeof key !== "string"))
      throw new NostrbaseError("INVALID_RECORD", "Group state database contains an invalid key.");
    return keys as string[];
  }
  close(): Promise<void> {
    this.closed = true;
    this.closing ??= this.database.then((database) => database.close());
    return this.closing;
  }
}

export interface GroupStoreScope {
  namespace: string;
  /** The Nostr account's lowercase public key. */
  account: string;
  /** A stable, random 32-byte device identifier encoded as lowercase hex. */
  device: string;
  bucket: string;
}
export type GroupStoreIdentityGuard = () => void | Promise<void>;

type ValueNode =
  | ["null"]
  | ["undefined"]
  | ["string", string]
  | ["boolean", boolean]
  | ["number", string]
  | ["bigint", string]
  | ["bytes", string]
  | ["array", ValueNode[]]
  | ["object", [string, ValueNode][], boolean];

const toBase64 = (bytes: Uint8Array): string => {
  let output = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    output += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(output);
};
function fromBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
    throw invalidState();
  const decoded = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  if (toBase64(decoded) !== value) throw invalidState();
  return decoded;
}
function isCiphertext(cipher: string): boolean {
  try {
    const bytes = fromBase64(cipher);
    return bytes.length >= 99 && bytes[0] === 2;
  } catch {
    return false;
  }
}
function invalidState(): NostrbaseError {
  return new NostrbaseError(
    "INVALID_RECORD",
    "Encrypted group state has an invalid encoding or binding.",
  );
}
function canonicalNostrObject(value: object): boolean {
  const event = value as NostrEvent;
  const keys = Object.keys(value);
  const unsignedKeys = ["id", "pubkey", "kind", "created_at", "tags", "content"];
  if (
    keys.length === 7 &&
    keys.every((key) => [...unsignedKeys, "sig"].includes(key)) &&
    verify(event)
  )
    return true;
  try {
    return (
      keys.length === 6 &&
      keys.every((key) => unsignedKeys.includes(key)) &&
      /^[0-9a-f]{64}$/.test(event.id) &&
      /^[0-9a-f]{64}$/.test(event.pubkey) &&
      Number.isSafeInteger(event.kind) &&
      event.kind >= 0 &&
      event.kind <= 65535 &&
      Number.isSafeInteger(event.created_at) &&
      event.created_at >= 0 &&
      typeof event.content === "string" &&
      Array.isArray(event.tags) &&
      event.tags.every(
        (tag) => Array.isArray(tag) && tag.every((item) => typeof item === "string"),
      ) &&
      getEventHash(event) === event.id
    );
  } catch {
    return false;
  }
}
function encodeValue(value: unknown, stack = new Set<object>(), depth = 0): ValueNode {
  if (depth > 128) throw new NostrbaseError("INVALID_RECORD", "Group state nesting is too deep.");
  if (value === null) return ["null"];
  if (value === undefined) return ["undefined"];
  if (typeof value === "string") return ["string", value];
  if (typeof value === "boolean") return ["boolean", value];
  if (typeof value === "number") return ["number", Object.is(value, -0) ? "-0" : String(value)];
  if (typeof value === "bigint") return ["bigint", String(value)];
  if (value instanceof Uint8Array) return ["bytes", toBase64(value)];
  if (typeof value !== "object")
    throw new NostrbaseError("INVALID_RECORD", "Group state contains an unsupported value.");
  if (stack.has(value))
    throw new NostrbaseError("INVALID_RECORD", "Group state cannot contain cycles.");
  stack.add(value);
  try {
    if (Array.isArray(value))
      return ["array", Array.from(value, (item) => encodeValue(item, stack, depth + 1))];
    const prototype = Object.getPrototypeOf(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      (Object.getOwnPropertySymbols(value).length > 0 && !canonicalNostrObject(value))
    )
      throw new NostrbaseError(
        "INVALID_RECORD",
        "Group state must contain plain objects, arrays, and supported primitives.",
      );
    return [
      "object",
      Object.entries(value).map(([key, item]) => [key, encodeValue(item, stack, depth + 1)]),
      prototype === null,
    ];
  } finally {
    stack.delete(value);
  }
}
function decodeValue(node: unknown, depth = 0): unknown {
  if (depth > 128 || !Array.isArray(node)) throw invalidState();
  if (node[0] === "null" && node.length === 1) return null;
  if (node[0] === "undefined" && node.length === 1) return undefined;
  if (node[0] === "string" && node.length === 2 && typeof node[1] === "string") return node[1];
  if (node[0] === "boolean" && node.length === 2 && typeof node[1] === "boolean") return node[1];
  if (node[0] === "number" && node.length === 2 && typeof node[1] === "string") {
    if (node[1] === "NaN") return Number.NaN;
    if (node[1] === "Infinity") return Number.POSITIVE_INFINITY;
    if (node[1] === "-Infinity") return Number.NEGATIVE_INFINITY;
    const value = Number(node[1]);
    if (!Number.isFinite(value) || (Object.is(value, -0) ? "-0" : String(value)) !== node[1])
      throw invalidState();
    return value;
  }
  if (
    node[0] === "bigint" &&
    node.length === 2 &&
    typeof node[1] === "string" &&
    /^-?(?:0|[1-9][0-9]*)$/.test(node[1])
  ) {
    const value = BigInt(node[1]);
    if (String(value) !== node[1]) throw invalidState();
    return value;
  }
  if (node[0] === "bytes" && node.length === 2 && typeof node[1] === "string")
    return fromBase64(node[1]);
  if (node[0] === "array" && node.length === 2 && Array.isArray(node[1]))
    return node[1].map((item) => decodeValue(item, depth + 1));
  if (
    node[0] === "object" &&
    node.length === 3 &&
    Array.isArray(node[1]) &&
    typeof node[2] === "boolean"
  ) {
    const value: Record<string, unknown> = node[2] ? Object.create(null) : {};
    const seen = new Set<string>();
    for (const entry of node[1]) {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== "string" ||
        seen.has(entry[0])
      )
        throw invalidState();
      seen.add(entry[0]);
      Object.defineProperty(value, entry[0], {
        value: decodeValue(entry[1], depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return value;
  }
  throw invalidState();
}

interface EncryptedEnvelope {
  v: 1;
  encryption: "nip44-self";
  writeId: string;
  chunks: string[];
}
/**
 * A Marmot GenericKeyValueStore-compatible wrapper. Every value is encrypted to the scoped account.
 * The parent owns adapter close. Identity guards must include account, auth revision, and client lifetime.
 */
export class EncryptedGroupStore<T> {
  readonly prefix: string;
  private scope: GroupStoreScope;
  private crypto: NonNullable<Signer["nip44"]>;
  constructor(
    private adapter: GroupStateAdapter,
    scope: GroupStoreScope,
    private signer: Signer,
    private guard: GroupStoreIdentityGuard,
  ) {
    if (
      !scope ||
      typeof scope.namespace !== "string" ||
      !scope.namespace.trim() ||
      scope.namespace.length > 256 ||
      !/^[0-9a-f]{64}$/.test(scope.account) ||
      !/^[0-9a-f]{64}$/.test(scope.device) ||
      typeof scope.bucket !== "string" ||
      !scope.bucket ||
      scope.bucket.length > 128
    )
      throw new NostrbaseError(
        "INVALID_CONFIG",
        "Set namespace, account, stable device ID, and bucket for encrypted group state.",
      );
    if (!signer.nip44)
      throw new NostrbaseError(
        "AUTH_FAILED",
        "Group state requires a signer with NIP-44 encryption.",
      );
    this.crypto = signer.nip44;
    this.scope = { ...scope };
    this.prefix = `nostrbase-group:v1:${[scope.namespace, scope.account, scope.device, scope.bucket].map(encodeURIComponent).join(":")}:`;
  }
  private key(key: string): string {
    if (typeof key !== "string" || !key || key.length > 2048)
      throw new NostrbaseError(
        "INVALID_QUERY",
        "Group state keys must contain 1 to 2048 characters.",
      );
    return this.prefix + encodeURIComponent(key);
  }
  private async identity(): Promise<void> {
    await this.guard();
    const pubkey = await this.signer.getPublicKey();
    await this.guard();
    if (pubkey !== this.scope.account)
      throw new NostrbaseError(
        "AUTH_FAILED",
        "Group state signer does not match its account scope.",
      );
  }
  async setItem(key: string, value: T): Promise<T> {
    const storageKey = this.key(key);
    const serialized = JSON.stringify(encodeValue(value));
    const bytes = new TextEncoder().encode(serialized);
    await this.identity();
    const parts = Math.max(1, Math.ceil(bytes.length / 24000));
    const writeId = crypto.randomUUID();
    const chunks: string[] = [];
    for (let part = 0; part < parts; part++) {
      await this.guard();
      const plain = JSON.stringify({
        v: 1,
        storageKey,
        writeId,
        part,
        parts,
        body: toBase64(bytes.subarray(part * 24000, (part + 1) * 24000)),
      });
      const cipher = await this.crypto.encrypt(this.scope.account, plain);
      await this.guard();
      if (typeof cipher !== "string" || !isCiphertext(cipher))
        throw new NostrbaseError("AUTH_FAILED", "Signer returned invalid encrypted group state.");
      chunks.push(cipher);
    }
    const envelope: EncryptedEnvelope = { v: 1, encryption: "nip44-self", writeId, chunks };
    await this.guard();
    await this.adapter.set(storageKey, JSON.stringify(envelope));
    await this.guard();
    return decodeValue(JSON.parse(serialized)) as T;
  }
  async getItem(key: string): Promise<T | null> {
    const storageKey = this.key(key);
    await this.identity();
    const saved = await this.adapter.get(storageKey);
    await this.guard();
    if (saved === null) return null;
    let envelope: EncryptedEnvelope;
    try {
      envelope = JSON.parse(saved) as EncryptedEnvelope;
    } catch {
      throw invalidState();
    }
    if (
      envelope?.v !== 1 ||
      envelope.encryption !== "nip44-self" ||
      typeof envelope.writeId !== "string" ||
      !/^[0-9a-f-]{36}$/.test(envelope.writeId) ||
      !Array.isArray(envelope.chunks) ||
      !envelope.chunks.length ||
      envelope.chunks.some((chunk) => typeof chunk !== "string" || !chunk)
    )
      throw invalidState();
    const parts: Uint8Array[] = [];
    let length = 0;
    for (let part = 0; part < envelope.chunks.length; part++) {
      await this.guard();
      const plain = await this.crypto.decrypt(this.scope.account, envelope.chunks[part] as string);
      await this.guard();
      let payload: {
        v?: unknown;
        storageKey?: unknown;
        writeId?: unknown;
        part?: unknown;
        parts?: unknown;
        body?: unknown;
      };
      try {
        payload = JSON.parse(plain);
      } catch {
        throw invalidState();
      }
      if (
        payload?.v !== 1 ||
        payload.storageKey !== storageKey ||
        payload.writeId !== envelope.writeId ||
        payload.part !== part ||
        payload.parts !== envelope.chunks.length ||
        typeof payload.body !== "string"
      )
        throw invalidState();
      const bytes = fromBase64(payload.body);
      parts.push(bytes);
      length += bytes.length;
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    let node: unknown;
    try {
      node = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw invalidState();
    }
    const value = decodeValue(node) as T;
    await this.guard();
    return value;
  }
  async removeItem(key: string): Promise<void> {
    const storageKey = this.key(key);
    await this.identity();
    await this.guard();
    await this.adapter.remove(storageKey);
    await this.guard();
  }
  async keys(): Promise<string[]> {
    await this.identity();
    const stored = await this.adapter.keys();
    await this.guard();
    return stored
      .filter((key) => key.startsWith(this.prefix))
      .map((key) => {
        try {
          const decoded = decodeURIComponent(key.slice(this.prefix.length));
          if (this.key(decoded) !== key) throw invalidState();
          return decoded;
        } catch {
          throw invalidState();
        }
      });
  }
  async clear(): Promise<void> {
    const keys = await this.keys();
    for (const key of keys) await this.removeItem(key);
  }
}
