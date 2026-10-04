import { createHash } from "node:crypto";
import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { verifyEvent } from "nostr-tools";
import type { NostrEvent } from "../../src";
import { deferred, required } from "./async";

interface StoredObject {
  bytes: Buffer;
  type: string;
  author: string;
}

/** Real HTTP, independently verified Blossom authorization and content hashes. */
export class BlossomServer {
  private server = createServer((request, response) => {
    void this.handle(request, response).catch((error: unknown) => {
      response.writeHead(500).end(String(error));
    });
  });
  readonly objects = new Map<string, StoredObject>();
  readonly requests: { method: string; path: string; token?: NostrEvent }[] = [];
  readonly bodyStarted = deferred();
  readonly bodyClosed = deferred();
  stallBody = false;
  corruptDownload = false;
  redirectUpload = false;
  deniedDeletes = new Set<string>();
  url = "";

  async start(): Promise<this> {
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }
  private token(request: IncomingMessage, action: string, hash?: string): NostrEvent | undefined {
    try {
      const header = request.headers.authorization;
      if (!header?.startsWith("Nostr ")) return;
      const event = JSON.parse(Buffer.from(header.slice(6), "base64url").toString()) as NostrEvent;
      const now = Math.floor(Date.now() / 1000);
      if (
        !verifyEvent(event) ||
        event.kind !== 24242 ||
        event.created_at > now ||
        !event.tags.some((tag) => tag[0] === "t" && tag[1] === action) ||
        !event.tags.some((tag) => tag[0] === "server" && tag[1] === "127.0.0.1") ||
        !event.tags.some((tag) => tag[0] === "expiration" && Number(tag[1]) > now) ||
        (hash && !event.tags.some((tag) => tag[0] === "x" && tag[1] === hash))
      )
        return;
      return event;
    } catch {
      return;
    }
  }
  private descriptor(hash: string, object: StoredObject) {
    return {
      url: `${this.url}/${hash}`,
      sha256: hash,
      size: object.bytes.length,
      type: object.type,
      uploaded: 1,
    };
  }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("Access-Control-Allow-Origin", "*");
    if (request.method === "OPTIONS") {
      response
        .writeHead(204, {
          "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type, X-SHA-256",
        })
        .end();
      return;
    }
    const url = new URL(request.url ?? "/", this.url);
    const method = request.method ?? "GET";
    const action =
      method === "PUT"
        ? "upload"
        : method === "DELETE"
          ? "delete"
          : url.pathname.startsWith("/list/")
            ? "list"
            : "get";
    const hash =
      action === "upload"
        ? (request.headers["x-sha-256"] as string)
        : action === "list"
          ? undefined
          : url.pathname.slice(1);
    const token = this.token(request, action, hash);
    this.requests.push({ method, path: request.url ?? "/", token });
    if ((action !== "get" || request.headers.authorization) && !token) {
      response.writeHead(401).end();
      return;
    }
    if (action === "upload") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      if (createHash("sha256").update(bytes).digest("hex") !== hash) {
        response.writeHead(400).end();
        return;
      }
      if (this.redirectUpload) {
        response.writeHead(307, { Location: `${this.url}/redirect-target` }).end();
        return;
      }
      const object = {
        bytes,
        type: request.headers["content-type"] ?? "application/octet-stream",
        author: required(token, "authorized token").pubkey,
      };
      this.objects.set(required(hash, "object hash"), object);
      response
        .writeHead(201, { "Content-Type": "application/json" })
        .end(JSON.stringify(this.descriptor(required(hash, "object hash"), object)));
    } else if (action === "list") {
      const author = url.pathname.slice("/list/".length);
      const values = [...this.objects]
        .filter(([, object]) => object.author === author)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .filter(
          ([hash]) =>
            !url.searchParams.has("cursor") || hash > required(url.searchParams.get("cursor")),
        )
        .slice(0, Number(url.searchParams.get("limit") ?? 100));
      response
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify(values.map(([hash, object]) => this.descriptor(hash, object))));
    } else if (action === "delete") {
      const object = this.objects.get(required(hash, "object hash"));
      if (
        this.deniedDeletes.has(required(hash, "object hash")) ||
        (object && object.author !== required(token, "authorized token").pubkey)
      ) {
        response.writeHead(403).end();
        return;
      }
      this.objects.delete(required(hash, "object hash"));
      response.writeHead(204).end();
    } else {
      const object = this.objects.get(required(hash, "object hash"));
      if (!object) {
        response.writeHead(404).end();
        return;
      }
      if (this.stallBody) {
        response.writeHead(200, { "Content-Type": object.type });
        response.write(object.bytes.subarray(0, 1));
        response.on("close", () => this.bodyClosed.resolve());
        this.bodyStarted.resolve();
        return;
      }
      response
        .writeHead(200, { "Content-Type": object.type })
        .end(this.corruptDownload ? Buffer.from("corrupt bytes") : object.bytes);
    }
  }
  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
