import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { deno, revision, source, verifySource } from "../../../integration/blossom/setup.mjs";

async function freePort(): Promise<number> {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP address.");
  const port = address.port;
  await new Promise<void>((done, fail) => socket.close((error) => (error ? fail(error) : done())));
  return port;
}

/** Unmodified, pinned hzrd149/blossom-server; never uses the protocol fixture. */
export class UpstreamBlossom {
  readonly url: string;
  private child?: ChildProcess;
  private logs = "";
  private constructor(
    private directory: string,
    private config: string,
    private logPath: string,
    port: number,
  ) {
    this.url = `http://127.0.0.1:${port}`;
  }

  static async start(): Promise<UpstreamBlossom> {
    verifySource();
    const directory = await mkdtemp(resolve(tmpdir(), "nostrbase-blossom-run-"));
    const port = await freePort();
    const config = resolve(directory, "config.yml");
    const logDirectory = resolve("output/environment/blossom");
    await mkdir(logDirectory, { recursive: true });
    const server = new UpstreamBlossom(
      directory,
      config,
      resolve(logDirectory, `${Date.now()}-${process.pid}.log`),
      port,
    );
    await writeFile(
      config,
      `host: 127.0.0.1\nport: ${port}\ndatabase:\n  path: ${JSON.stringify(resolve(directory, "sqlite.db"))}\nstorage:\n  backend: local\n  local:\n    dir: ${JSON.stringify(resolve(directory, "blobs"))}\n  rules:\n    - type: "*"\n      expiration: 1 day\nupload:\n  workers: 1\n  maxSize: 65536\nlist:\n  enabled: true\n  requireAuth: true\n  allowListOthers: false\nlanding:\n  enabled: false\nmirror:\n  enabled: false\nmedia:\n  enabled: false\n  requirePubkeyInRule: true\nreport:\n  enabled: false\nprune:\n  initialDelayMs: 3600000\n`,
    );
    try {
      await server.launch();
      return server;
    } catch (error) {
      await server.close();
      throw error;
    }
  }

  private async launch(): Promise<void> {
    this.logs += `\nUpstream revision ${revision}; Deno 2.9.6; ${this.url}\n`;
    const child = spawn(deno, ["run", "--frozen", "--cached-only", "-A", "main.ts", this.config], {
      cwd: source,
      env: { ...process.env, BLOSSOM_REQUIRE_CONFIG: "1", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    let failure: Error | undefined;
    child.once("error", (error) => {
      failure = error;
    });
    const append = (bytes: Buffer) => {
      // Tokens are never sent to stdout by the harness. Bound output from a failed upstream.
      this.logs = `${this.logs}${bytes.toString()}`.slice(-100_000);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (failure || child.exitCode !== null)
        throw new Error(
          `Blossom failed to start: ${failure?.message ?? child.exitCode}\n${this.logs}`,
        );
      try {
        const response = await fetch(`${this.url}/list/${"0".repeat(64)}`, {
          signal: AbortSignal.timeout(500),
        });
        if (response.status === 401 && response.headers.get("access-control-allow-origin") === "*")
          return;
      } catch {
        // Retry only connection/readiness failures while the child is running.
      }
      await pause(50);
    }
    throw new Error(`Blossom did not become ready in 60 seconds.\n${this.logs}`);
  }

  private async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    const stopped = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try {
      await stopped;
    } finally {
      clearTimeout(timer);
    }
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.launch();
  }

  async close(): Promise<void> {
    await this.stop();
    await writeFile(this.logPath, this.logs);
    await rm(this.directory, { recursive: true, force: true });
  }
}
