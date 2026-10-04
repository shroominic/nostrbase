import type { NostrbaseClient } from "./client";
import { asError, NostrbaseError } from "./errors";
import { isObject } from "./protocol";
import type { Result, SchemaShape } from "./types";

export interface StorageOptions {
  fetch?: typeof globalThis.fetch;
  timeout?: number;
}
export interface StorageRequestOptions {
  signal?: AbortSignal;
  timeout?: number;
}
export interface StorageDownloadOptions extends StorageRequestOptions {
  /** Send a scoped get token. Public downloads do not require a signer. */ authenticated?: boolean;
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
  }
  from(server: string): BlossomBucket<DB> {
    this.host.assertOpen();
    return new BlossomBucket(this.host, serverURL(server), this.options);
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
      if (!response.ok)
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
  async upload(
    name: string,
    blob: Blob,
    options: StorageRequestOptions = {},
  ): Promise<Result<StoredBlob>> {
    try {
      this.host.assertOpen();
      if (typeof name !== "string" || !name.trim() || name.length > 1024 || !(blob instanceof Blob))
        throw new NostrbaseError("INVALID_RECORD", "Upload requires a file name and Blob.");
      if (options.signal?.aborted)
        throw new NostrbaseError("ABORTED", "Storage operation was aborted.");
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
    } catch (error) {
      return { data: null, error: asError(error) };
    }
  }
  async download(hash: string, options: StorageDownloadOptions = {}): Promise<Result<Blob>> {
    try {
      validHash(hash);
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
