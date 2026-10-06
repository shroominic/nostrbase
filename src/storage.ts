import type { NostrbaseClient } from "./client";
import { asError, NostrbaseError } from "./errors";
import type { ImageProcessingOptions, ImageProcessor, ImageTransformOptions } from "./image";
import { CanvasImageProcessor, imageAbort, imageInput, imageOptions } from "./image";
import { isObject } from "./protocol";
import type { Result, SchemaShape } from "./types";

export interface StorageOptions {
  fetch?: typeof globalThis.fetch;
  timeout?: number;
  imageProcessor?: ImageProcessor;
  /** Optional durable adapter for queued file uploads. */
  uploadQueue?: StorageUploadQueueAdapter;
}
export interface StorageRequestOptions {
  signal?: AbortSignal;
  timeout?: number;
}
export interface StorageDownloadOptions extends StorageRequestOptions {
  /** Send a scoped get token. Public downloads do not require a signer. */ authenticated?: boolean;
  transform?: ImageTransformOptions;
}
export interface StorageUploadOptions extends StorageRequestOptions {
  transform?: ImageTransformOptions;
  resumable?: ResumableUploadOptions;
}

export interface ResumableUploadOptions {
  /** Stable id used by the server to identify a partial upload. */
  id?: string;
  /** Chunk size in bytes. Defaults to 1 MiB. */
  chunkSize?: number;
  onProgress?: (progress: UploadProgress) => void;
}
export interface UploadProgress {
  uploaded: number;
  total: number;
  /** True when the server has accepted the complete object. */
  complete: boolean;
}
export interface StorageUploadQueueEntry {
  id: string;
  server: string;
  name: string;
  blob: Blob;
  options?: Omit<StorageUploadOptions, "signal">;
  createdAt: number;
}
export interface StorageUploadQueueAdapter {
  load(server?: string): Promise<StorageUploadQueueEntry[]>;
  put(entry: StorageUploadQueueEntry): Promise<void>;
  remove(id: string): Promise<void>;
  close?(): void | Promise<void>;
}
export interface QueuedUpload {
  id: string;
  name: string;
  server: string;
  createdAt: number;
  size: number;
}

/** In-memory upload queue. Supply a durable adapter for restart recovery. */
export class MemoryStorageUploadQueueAdapter implements StorageUploadQueueAdapter {
  private entries = new Map<string, StorageUploadQueueEntry>();
  async load(server?: string): Promise<StorageUploadQueueEntry[]> {
    return structuredClone(
      [...this.entries.values()]
        .filter((entry) => server === undefined || entry.server === server)
        .map((entry) => entry),
    );
  }
  async put(entry: StorageUploadQueueEntry): Promise<void> {
    this.entries.set(entry.id, structuredClone(entry));
  }
  async remove(id: string): Promise<void> {
    this.entries.delete(id);
  }
}

/** Durable browser upload queue. Entries are removed only after a verified upload succeeds. */
export class IndexedDBStorageUploadQueueAdapter implements StorageUploadQueueAdapter {
  private closed = false;
  private database: Promise<IDBDatabase>;
  constructor(name = "nostrbase-uploads", factory: IDBFactory | undefined = globalThis.indexedDB) {
    if (!factory)
      throw new NostrbaseError("INVALID_CONFIG", "IndexedDB is unavailable for uploads.");
    if (typeof name !== "string" || !name.trim())
      throw new NostrbaseError("INVALID_CONFIG", "Set an upload queue database name.");
    this.database = new Promise((resolve, reject) => {
      const request = factory.open(name, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("uploads"))
          request.result.createObjectStore("uploads", { keyPath: "id" });
      };
      request.onerror = () =>
        reject(request.error ?? new Error("Upload queue database could not open."));
      request.onblocked = () =>
        reject(new NostrbaseError("CLIENT_CLOSED", "Upload queue upgrade is blocked."));
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          this.closed = true;
          db.close();
        };
        resolve(db);
      };
    });
    void this.database.catch(() => {});
  }
  private async transaction<T>(
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    if (this.closed) throw new NostrbaseError("CLIENT_CLOSED", "Upload queue is closed.");
    const db = await this.database;
    if (this.closed) throw new NostrbaseError("CLIENT_CLOSED", "Upload queue is closed.");
    return new Promise((resolve, reject) => {
      const tx = db.transaction("uploads", mode);
      const request = action(tx.objectStore("uploads"));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () =>
        reject(tx.error ?? request.error ?? new Error("Upload queue transaction failed."));
      tx.onabort = () =>
        reject(tx.error ?? request.error ?? new Error("Upload queue transaction aborted."));
    });
  }
  async load(server?: string): Promise<StorageUploadQueueEntry[]> {
    const values = (await this.transaction("readonly", (store) =>
      store.getAll(),
    )) as StorageUploadQueueEntry[];
    return values.filter((entry) => server === undefined || entry.server === server);
  }
  async put(entry: StorageUploadQueueEntry): Promise<void> {
    await this.transaction("readwrite", (store) => store.put(entry));
  }
  async remove(id: string): Promise<void> {
    await this.transaction("readwrite", (store) => store.delete(id));
  }
  close(): Promise<void> {
    this.closed = true;
    return this.database.then((db) => db.close());
  }
}
export interface StorageListOptions extends StorageRequestOptions {
  cursor?: string;
  limit?: number;
}
export interface BlobDescriptor {
  url: string;
  sha256: string;
  size: number;
  type: string;
  uploaded: number;
}
export interface StoredBlob extends BlobDescriptor {
  /** Display metadata only; Blossom objects use the SHA-256 hash as their key. */ name: string;
}
export interface BlobRemoval {
  sha256: string;
  ok: boolean;
  error: NostrbaseError | null;
}

const hashPattern = /^[0-9a-f]{64}$/;
function validHash(hash: string): string {
  if (typeof hash !== "string" || !hashPattern.test(hash))
    throw new NostrbaseError("INVALID_QUERY", "Use a lowercase SHA-256 hash.");
  return hash;
}
function serverURL(input: string): URL {
  try {
    const url = new URL(input);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      (url.pathname !== "/" && url.pathname !== "")
    )
      throw new Error();
    return new URL(url.origin);
  } catch {
    throw new NostrbaseError(
      "INVALID_CONFIG",
      "Blossom server must be an HTTP(S) origin with no path, credentials, query, or fragment.",
    );
  }
}
async function sha256(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
const MAX_ATTACHMENT_BYTES = 128 * 1024 * 1024;
const FILE_ENCRYPTION_VERSION = 1;
export interface FileEncryptionMetadata {
  version: 1;
  algorithm: "AES-256-GCM";
  nonce: string;
  type: string;
  size: number;
  name: string;
}
export interface PrivateStoredBlob extends StoredBlob {
  encryption: FileEncryptionMetadata;
  /** Base64url encoded 32-byte AES key. Keep this with the app's Nostr record. */
  key: string;
}
export type FileKey = Uint8Array | string;
function bytesToBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decodeBase64url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(`${normalized}${"=".repeat((4 - (normalized.length % 4)) % 4)}`);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
function base64urlBytes(value: string, label: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value))
    throw new NostrbaseError("INVALID_QUERY", `${label} must be a base64url 32-byte key.`);
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64url(value);
  } catch {
    throw new NostrbaseError("INVALID_QUERY", `${label} must be a base64url 32-byte key.`);
  }
  if (bytes.length !== 32)
    throw new NostrbaseError("INVALID_QUERY", `${label} must be a base64url 32-byte key.`);
  return bytes;
}
function base64urlNonce(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{16}$/.test(value))
    throw new NostrbaseError("INVALID_QUERY", "File nonce must be a base64url 12-byte nonce.");
  const bytes = decodeBase64url(value);
  if (bytes.length !== 12)
    throw new NostrbaseError("INVALID_QUERY", "File nonce must be a base64url 12-byte nonce.");
  return bytes;
}
function fileKeyBytes(key: FileKey): Uint8Array {
  if (typeof key === "string") return base64urlBytes(key, "File key");
  if (!(key instanceof Uint8Array) || key.byteLength !== 32)
    throw new NostrbaseError("INVALID_QUERY", "File key must contain exactly 32 bytes.");
  return new Uint8Array(key);
}
function fileMetadata(value: unknown): FileEncryptionMetadata {
  const size = isObject(value) ? value.size : undefined;
  if (
    !isObject(value) ||
    value.version !== FILE_ENCRYPTION_VERSION ||
    value.algorithm !== "AES-256-GCM" ||
    typeof value.nonce !== "string" ||
    !/^[A-Za-z0-9_-]{16}$/.test(value.nonce) ||
    typeof value.type !== "string" ||
    value.type.length > 256 ||
    typeof value.name !== "string" ||
    value.name.length > 1024 ||
    !Number.isSafeInteger(size) ||
    (size as number) < 0 ||
    (size as number) > MAX_ATTACHMENT_BYTES
  )
    throw new NostrbaseError("INVALID_RECORD", "Invalid encrypted file metadata.");
  return {
    version: 1,
    algorithm: "AES-256-GCM",
    nonce: value.nonce,
    type: value.type,
    size: size as number,
    name: value.name,
  };
}
function fileAssociatedData(meta: FileEncryptionMetadata): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      version: meta.version,
      algorithm: meta.algorithm,
      type: meta.type,
      size: meta.size,
      name: meta.name,
    }),
  );
}
async function encryptFile(
  name: string,
  source: Blob,
  key?: FileKey,
  signal?: AbortSignal,
): Promise<{ blob: Blob; key: string; encryption: FileEncryptionMetadata }> {
  if (!(source instanceof Blob) || source.size > MAX_ATTACHMENT_BYTES)
    throw new NostrbaseError("INVALID_RECORD", "Attachment must be a Blob of at most 128 MiB.");
  if (signal?.aborted) throw new NostrbaseError("ABORTED", "Storage operation was aborted.");
  const rawKey = key === undefined ? crypto.getRandomValues(new Uint8Array(32)) : fileKeyBytes(key);
  const nonceBytes = crypto.getRandomValues(new Uint8Array(12));
  const metadata: FileEncryptionMetadata = {
    version: 1,
    algorithm: "AES-256-GCM",
    nonce: bytesToBase64url(nonceBytes),
    type: source.type || "application/octet-stream",
    size: source.size,
    name,
  };
  const cryptoBytes = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer as ArrayBuffer;
  try {
    const cryptoKey = await crypto.subtle.importKey("raw", cryptoBytes(rawKey), "AES-GCM", false, [
      "encrypt",
    ]);
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: cryptoBytes(nonceBytes),
        additionalData: cryptoBytes(fileAssociatedData(metadata)),
      },
      cryptoKey,
      await source.arrayBuffer(),
    );
    if (signal?.aborted) throw new NostrbaseError("ABORTED", "Storage operation was aborted.");
    return {
      blob: new Blob([ciphertext], { type: "application/octet-stream" }),
      key: bytesToBase64url(rawKey),
      encryption: metadata,
    };
  } finally {
    if (key === undefined) rawKey.fill(0);
  }
}
async function decryptFile(
  source: Blob,
  metadataInput: FileEncryptionMetadata,
  key: FileKey,
  signal?: AbortSignal,
): Promise<Blob> {
  const metadata = fileMetadata(metadataInput);
  if (source.size < 16)
    throw new NostrbaseError("INVALID_RECORD", "Encrypted attachment ciphertext is truncated.");
  if (signal?.aborted) throw new NostrbaseError("ABORTED", "Storage operation was aborted.");
  const rawKey = fileKeyBytes(key);
  const nonce = base64urlNonce(metadata.nonce);
  const cryptoBytes = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer as ArrayBuffer;
  try {
    const cryptoKey = await crypto.subtle.importKey("raw", cryptoBytes(rawKey), "AES-GCM", false, [
      "decrypt",
    ]);
    const plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: cryptoBytes(nonce),
        additionalData: cryptoBytes(fileAssociatedData(metadata)),
      },
      cryptoKey,
      await source.arrayBuffer(),
    );
    if (signal?.aborted) throw new NostrbaseError("ABORTED", "Storage operation was aborted.");
    if (plain.byteLength !== metadata.size)
      throw new NostrbaseError("INVALID_RECORD", "Decrypted attachment size is invalid.");
    return new Blob([plain], { type: metadata.type });
  } catch (error) {
    if (error instanceof NostrbaseError) throw error;
    throw new NostrbaseError("PERMISSION_DENIED", "Could not decrypt the attachment.");
  } finally {
    rawKey.fill(0);
  }
}
function base64url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function descriptor(value: unknown, expectedHash?: string, expectedSize?: number): BlobDescriptor {
  if (
    !isObject(value) ||
    typeof value.sha256 !== "string" ||
    !hashPattern.test(value.sha256) ||
    typeof value.url !== "string" ||
    typeof value.type !== "string" ||
    !Number.isSafeInteger(value.size) ||
    (value.size as number) < 0 ||
    !Number.isSafeInteger(value.uploaded) ||
    (value.uploaded as number) < 0 ||
    (expectedHash !== undefined && value.sha256 !== expectedHash) ||
    (expectedSize !== undefined && value.size !== expectedSize)
  )
    throw new NostrbaseError(
      "INVALID_RECORD",
      "Blossom server returned an invalid blob descriptor.",
    );
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    throw new NostrbaseError("INVALID_RECORD", "Blob descriptor URL is invalid.");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    !new RegExp(`^/${value.sha256}(?:\\.[A-Za-z0-9_-]+)?$`).test(url.pathname)
  )
    throw new NostrbaseError(
      "INVALID_RECORD",
      "Blob descriptor URL must identify its SHA-256 object.",
    );
  return {
    url: url.toString(),
    sha256: value.sha256,
    size: value.size as number,
    type: value.type,
    uploaded: value.uploaded as number,
  };
}

/** Blossom uses an explicitly selected file server alongside Nostr relays. */
export class NostrbaseStorage<DB extends SchemaShape<DB>> {
  constructor(
    private host: NostrbaseClient<DB>,
    private options: StorageOptions = {},
  ) {
    if (
      options.timeout !== undefined &&
      (!Number.isSafeInteger(options.timeout) || options.timeout <= 0)
    )
      throw new NostrbaseError("INVALID_CONFIG", "Storage timeout must be a positive integer.");
    if (
      options.imageProcessor !== undefined &&
      (!options.imageProcessor || typeof options.imageProcessor.process !== "function")
    )
      throw new NostrbaseError(
        "INVALID_CONFIG",
        "Storage imageProcessor must implement process().",
      );
  }
  from(server: string): BlossomBucket<DB> {
    this.host.assertOpen();
    return new BlossomBucket(this.host, serverURL(server), this.options);
  }
  /** Process image bytes locally. This method does not contact a server. */
  async processImage(blob: Blob, options: ImageProcessingOptions = {}): Promise<Result<Blob>> {
    try {
      this.host.assertOpen();
      const { signal: callerSignal, ...input } = options;
      const transform = imageOptions(input);
      const signal = this.host.signal(callerSignal);
      await imageInput(blob, signal);
      const data = await (this.options.imageProcessor ?? new CanvasImageProcessor()).process(
        blob,
        transform,
        signal,
      );
      imageAbort(signal);
      await imageInput(data, signal);
      return { data, error: null };
    } catch (error) {
      return { data: null, error: asError(error, "INVALID_RECORD") };
    }
  }
}

export class BlossomBucket<DB extends SchemaShape<DB>> {
  readonly server: string;
  private fetcher: typeof globalThis.fetch;
  constructor(
    private host: NostrbaseClient<DB>,
    private origin: URL,
    private options: StorageOptions,
  ) {
    this.server = origin.origin;
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  }
  private async token(
    action: "upload" | "delete" | "get" | "list",
    hash?: string,
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const event = await this.host.sign({
      kind: 24242,
      created_at: now - 1,
      content: `${action.charAt(0).toUpperCase()}${action.slice(1)} blob${hash ? ` ${hash}` : "s"} on ${this.origin.hostname}`,
      tags: [
        ["t", action],
        ["expiration", String(now + 300)],
        ["server", this.origin.hostname.toLowerCase()],
        ...(hash ? [["x", hash]] : []),
      ],
    });
    return `Nostr ${base64url(JSON.stringify(event))}`;
  }
  private async request<T>(
    path: string,
    init: RequestInit,
    options: StorageRequestOptions,
    read: (response: Response) => Promise<T>,
    acceptedStatuses: readonly number[] = [],
  ): Promise<T> {
    const timeout = options.timeout ?? this.options.timeout ?? this.host.timeout;
    if (!Number.isSafeInteger(timeout) || timeout <= 0)
      throw new NostrbaseError("INVALID_QUERY", "Storage timeout must be a positive integer.");
    const timed = new AbortController();
    const signal = AbortSignal.any([this.host.signal(options.signal), timed.signal]);
    const timer = setTimeout(() => timed.abort(), timeout);
    try {
      if (signal.aborted) throw new NostrbaseError("ABORTED", "Storage operation was aborted.");
      const response = await this.fetcher(new URL(path, this.origin).toString(), {
        ...init,
        signal,
        redirect: "error",
        credentials: "omit",
      });
      if (!response.ok && !acceptedStatuses.includes(response.status))
        throw new NostrbaseError(
          response.status === 404
            ? "NOT_FOUND"
            : response.status === 401 || response.status === 403
              ? "PERMISSION_DENIED"
              : "RELAY_ERROR",
          `Blossom server returned HTTP ${response.status}.`,
        );
      const result = await read(response);
      if (signal.aborted) throw new NostrbaseError("ABORTED", "Storage operation was aborted.");
      return result;
    } catch (error) {
      if (signal.aborted)
        throw new NostrbaseError(
          "ABORTED",
          timed.signal.aborted ? "Storage operation timed out." : "Storage operation was aborted.",
        );
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  private async uploadBytes(
    name: string,
    blob: Blob,
    options: StorageUploadOptions,
  ): Promise<Result<StoredBlob>> {
    const hash = await sha256(blob);
    const authorization = await this.token("upload", hash);
    const data = await this.request(
      "/upload",
      {
        method: "PUT",
        headers: {
          Authorization: authorization,
          "Content-Type": blob.type || "application/octet-stream",
          "X-SHA-256": hash,
        },
        body: blob,
      },
      options,
      async (response) => descriptor(await response.json(), hash, blob.size),
    );
    return { data: { ...data, name }, error: null };
  }
  async upload(
    name: string,
    blob: Blob,
    options: StorageUploadOptions = {},
  ): Promise<Result<StoredBlob>> {
    try {
      this.host.assertOpen();
      if (typeof name !== "string" || !name.trim() || name.length > 1024 || !(blob instanceof Blob))
        throw new NostrbaseError("INVALID_RECORD", "Upload requires a file name and Blob.");
      if (options.signal?.aborted)
        throw new NostrbaseError("ABORTED", "Storage operation was aborted.");
      if (options.transform !== undefined) {
        const processed = await this.host.storage.processImage(blob, {
          ...imageOptions(options.transform),
          signal: options.signal,
        });
        if (processed.error || !processed.data)
          throw processed.error ?? new NostrbaseError("INVALID_RECORD", "Image processing failed.");
        blob = processed.data;
      }
      if (options.resumable) return await this.uploadResumable(name, blob, options);
      return await this.uploadBytes(name, blob, options);
    } catch (error) {
      return { data: null, error: asError(error) };
    }
  }
  /** Upload an encrypted attachment. The returned key must be shared separately through Nostr. */
  async uploadPrivate(
    name: string,
    blob: Blob,
    options: StorageUploadOptions & { key?: FileKey } = {},
  ): Promise<Result<PrivateStoredBlob>> {
    try {
      this.host.assertOpen();
      const encrypted = await encryptFile(name, blob, options.key, options.signal);
      const uploaded = options.resumable
        ? await this.uploadResumable(name, encrypted.blob, {
            ...options,
            transform: undefined,
          })
        : await this.uploadBytes(name, encrypted.blob, {
            ...options,
            transform: undefined,
            resumable: options.resumable,
          });
      if (uploaded.error || !uploaded.data) return { data: null, error: uploaded.error };
      return {
        data: { ...uploaded.data, encryption: encrypted.encryption, key: encrypted.key },
        error: null,
      };
    } catch (error) {
      return { data: null, error: asError(error) };
    }
  }
  /** Download and authenticate an encrypted attachment. Metadata is authenticated as AAD. */
  async downloadPrivate(
    hash: string,
    encryption: FileEncryptionMetadata,
    key: FileKey,
    options: StorageDownloadOptions = {},
  ): Promise<Result<Blob>> {
    try {
      const downloaded = await this.download(hash, { ...options, transform: undefined });
      if (downloaded.error || !downloaded.data) return { data: null, error: downloaded.error };
      return {
        data: await decryptFile(downloaded.data, encryption, key, options.signal),
        error: null,
      };
    } catch (error) {
      return { data: null, error: asError(error) };
    }
  }
  /** Queue an upload in the configured adapter. Blob bytes are retained locally until replay. */
  async queueUpload(
    name: string,
    blob: Blob,
    options: Omit<StorageUploadOptions, "signal"> = {},
  ): Promise<Result<QueuedUpload>> {
    try {
      const queue = this.options.uploadQueue;
      if (!queue)
        throw new NostrbaseError("INVALID_CONFIG", "Configure storage.uploadQueue first.");
      if (typeof name !== "string" || !name.trim() || !(blob instanceof Blob))
        throw new NostrbaseError("INVALID_RECORD", "Upload requires a file name and Blob.");
      const id = crypto.randomUUID();
      const entry: StorageUploadQueueEntry = {
        id,
        server: this.server,
        name,
        blob,
        options: { ...options },
        createdAt: Date.now(),
      };
      await queue.put(entry);
      return {
        data: { id, name, server: this.server, createdAt: entry.createdAt, size: blob.size },
        error: null,
      };
    } catch (error) {
      return { data: null, error: asError(error, "INVALID_RECORD") };
    }
  }
  async listQueuedUploads(): Promise<Result<QueuedUpload[]>> {
    try {
      if (!this.options.uploadQueue)
        throw new NostrbaseError("INVALID_CONFIG", "Configure storage.uploadQueue first.");
      const entries = await this.options.uploadQueue.load(this.server);
      return {
        data: entries.map(({ id, name, server, createdAt, blob }) => ({
          id,
          name,
          server,
          createdAt,
          size: blob.size,
        })),
        error: null,
      };
    } catch (error) {
      return { data: null, error: asError(error) };
    }
  }
  async replayUploads(options: StorageRequestOptions = {}): Promise<Result<StoredBlob[]>> {
    const data: StoredBlob[] = [];
    try {
      if (!this.options.uploadQueue)
        throw new NostrbaseError("INVALID_CONFIG", "Configure storage.uploadQueue first.");
      const entries = await this.options.uploadQueue.load(this.server);
      for (const entry of entries) {
        try {
          const result = await this.upload(entry.name, entry.blob, {
            ...entry.options,
            ...options,
          });
          if (result.error || !result.data)
            throw result.error ?? new NostrbaseError("PUBLISH_FAILED", "Queued upload failed.");
          data.push(result.data);
          await this.options.uploadQueue.remove(entry.id);
        } catch (error) {
          return { data: data.length ? data : null, error: asError(error) };
        }
      }
      return { data, error: null, count: data.length };
    } catch (error) {
      return { data: data.length ? data : null, error: asError(error), count: data.length };
    }
  }
  private async uploadResumable(
    name: string,
    blob: Blob,
    options: StorageUploadOptions,
  ): Promise<Result<StoredBlob>> {
    const resumable = options.resumable;
    if (!resumable) return this.uploadBytes(name, blob, options);
    const chunkSize = resumable.chunkSize ?? 1024 * 1024;
    if (!Number.isSafeInteger(chunkSize) || chunkSize < 64 * 1024 || chunkSize > 16 * 1024 * 1024)
      throw new NostrbaseError("INVALID_QUERY", "Resumable chunkSize must be 64 KiB to 16 MiB.");
    const id = resumable.id ?? crypto.randomUUID();
    const hash = await sha256(blob);
    const authorization = await this.token("upload", hash);
    let offset = 0;
    try {
      offset = await this.request(
        "/upload",
        {
          method: "HEAD",
          headers: {
            Authorization: authorization,
            "X-Upload-ID": id,
            "X-SHA-256": hash,
          },
        },
        options,
        async (response) => Number(response.headers.get("Upload-Offset") ?? "0"),
      );
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > blob.size)
        throw new NostrbaseError("INVALID_RECORD", "Blossom returned an invalid upload offset.");
    } catch (error) {
      if (!(error instanceof NostrbaseError) || error.code !== "NOT_FOUND") throw error;
    }
    while (offset < blob.size) {
      if (options.signal?.aborted)
        throw new NostrbaseError("ABORTED", "Storage operation was aborted.");
      const end = Math.min(blob.size, offset + chunkSize);
      const response = await this.request(
        "/upload",
        {
          method: "PUT",
          headers: {
            Authorization: authorization,
            "Content-Type": blob.type || "application/octet-stream",
            "X-SHA-256": hash,
            "X-Upload-ID": id,
            "Content-Range": `bytes ${offset}-${end - 1}/${blob.size}`,
          },
          body: blob.slice(offset, end),
        },
        options,
        async (result) => {
          if (result.status === 308) return undefined;
          return descriptor(await result.json(), hash, blob.size);
        },
        [308],
      );
      offset = end;
      try {
        resumable.onProgress?.({
          uploaded: offset,
          total: blob.size,
          complete: offset === blob.size,
        });
      } catch {
        /* Progress observers cannot abort storage. */
      }
      if (offset === blob.size) {
        if (!response)
          throw new NostrbaseError(
            "RELAY_ERROR",
            "Blossom resumable upload did not return a descriptor.",
          );
        return { data: { ...response, name }, error: null };
      }
    }
    throw new NostrbaseError(
      "RELAY_ERROR",
      "Blossom resumable upload did not return a descriptor.",
    );
  }
  async download(hash: string, options: StorageDownloadOptions = {}): Promise<Result<Blob>> {
    try {
      validHash(hash);
      const transform =
        options.transform === undefined ? undefined : imageOptions(options.transform);
      const headers: Record<string, string> = {};
      if (options.authenticated) headers.Authorization = await this.token("get", hash);
      const data = await this.request(
        `/${hash}`,
        { method: "GET", headers },
        options,
        async (response) => {
          const blob = await response.blob();
          if ((await sha256(blob)) !== hash)
            throw new NostrbaseError(
              "INVALID_RECORD",
              "Downloaded bytes do not match the requested SHA-256 hash.",
            );
          return blob;
        },
      );
      if (transform)
        return this.host.storage.processImage(data, { ...transform, signal: options.signal });
      return { data, error: null };
    } catch (error) {
      return { data: null, error: asError(error) };
    }
  }
  async remove(
    hashes: readonly string[],
    options: StorageRequestOptions = {},
  ): Promise<Result<BlobRemoval[]>> {
    const data: BlobRemoval[] = [];
    try {
      if (!Array.isArray(hashes))
        throw new NostrbaseError("INVALID_QUERY", "Remove requires an array of hashes.");
      for (const hash of hashes) validHash(hash);
      for (const hash of [...new Set(hashes)]) {
        try {
          const authorization = await this.token("delete", hash);
          await this.request(
            `/${hash}`,
            { method: "DELETE", headers: { Authorization: authorization } },
            options,
            async () => undefined,
          );
          data.push({ sha256: hash, ok: true, error: null });
        } catch (error) {
          data.push({ sha256: hash, ok: false, error: asError(error) });
        }
      }
      const failures = data.filter((item) => !item.ok);
      return {
        data,
        error: failures.length
          ? new NostrbaseError(
              "PUBLISH_FAILED",
              `${failures.length} blob deletion(s) failed.`,
              failures.map((item) => ({ sha256: item.sha256, code: item.error?.code })),
            )
          : null,
        count: data.filter((item) => item.ok).length,
      };
    } catch (error) {
      return {
        data: data.length ? data : null,
        error: asError(error),
        count: data.filter((item) => item.ok).length,
      };
    }
  }
  async list(pubkey?: string, options: StorageListOptions = {}): Promise<Result<BlobDescriptor[]>> {
    try {
      const key = pubkey ?? (await this.host.auth.requireSigner()).session.user.pubkey;
      if (!hashPattern.test(key))
        throw new NostrbaseError("INVALID_QUERY", "List requires a full hex public key.");
      const query = new URLSearchParams();
      if (options.cursor !== undefined) query.set("cursor", validHash(options.cursor));
      if (options.limit !== undefined) {
        if (!Number.isSafeInteger(options.limit) || options.limit <= 0)
          throw new NostrbaseError(
            "INVALID_QUERY",
            "Storage list limit must be a positive integer.",
          );
        query.set("limit", String(options.limit));
      }
      const authorization = await this.token("list");
      const data = await this.request(
        `/list/${key}${query.size ? `?${query}` : ""}`,
        { method: "GET", headers: { Authorization: authorization } },
        options,
        async (response) => {
          const result: unknown = await response.json();
          if (!Array.isArray(result))
            throw new NostrbaseError("INVALID_RECORD", "Blossom list response must be an array.");
          return result.map((value) => descriptor(value));
        },
      );
      return { data, error: null, count: data.length };
    } catch (error) {
      return { data: null, error: asError(error) };
    }
  }
}
