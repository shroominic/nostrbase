import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { chromium, type Browser, type Page } from "@playwright/test";

const execute = promisify(execFile);
async function groupMembers(group: number): Promise<number[]> {
  const { stdout } = await execute("ps", ["-axo", "pid=,pgid=,stat="], { timeout: 5000 });
  return stdout.split("\n").flatMap((line) => {
    const [pid, pgid, state] = line.trim().split(/\s+/);
    return Number(pgid) === group && !state?.includes("Z") ? [Number(pid)] : [];
  });
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Chromium ${label} timed out.`)), 15_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Launches our own Chromium process group; SIGKILL never targets a user's browser. */
export async function startCrashBrowser(profile: string, origin: string) {
  if (process.platform === "win32")
    throw new Error("Crash recovery requires POSIX process-group SIGKILL.");
  await access(chromium.executablePath(), constants.X_OK).catch((error) => {
    throw new Error("Chromium is missing or cannot run. Run npx playwright install chromium.", {
      cause: error,
    });
  });
  const child = spawn(
    chromium.executablePath(),
    [
      `--user-data-dir=${profile}`,
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-breakpad",
      "--disable-crash-reporter",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-component-update",
      "--disable-sync",
      "--disable-default-apps",
      "--disable-extensions",
      "--metrics-recording-only",
      "--password-store=basic",
      "--use-mock-keychain",
      "about:blank",
    ],
    { detached: true, stdio: ["ignore", "ignore", "pipe"] },
  );
  // A failed spawn can emit error after returning without a PID.
  child.on("error", () => {});
  const pid = child.pid;
  if (!pid) throw new Error("Chromium did not start. Run npx playwright install chromium.");
  const logsPath = resolve("output/environment/crash", `${pid}.log`);
  let logs = "";
  let resolveEndpoint: (endpoint: string) => void = () => {};
  let rejectEndpoint: (error: Error) => void = () => {};
  const endpoint = new Promise<string>((resolveValue, reject) => {
    resolveEndpoint = resolveValue;
    rejectEndpoint = reject;
  });
  child.stderr.on("data", (chunk: Buffer) => {
    logs = (logs + chunk.toString()).slice(-1_000_000);
    const match = /DevTools listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/.exec(logs);
    if (match?.[1]) resolveEndpoint(match[1]);
  });
  child.once("error", (error) =>
    rejectEndpoint(
      new Error("Install Chromium with npx playwright install chromium.", { cause: error }),
    ),
  );
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit) => {
      child.once("exit", (code, signal) => {
        rejectEndpoint(new Error(`Chromium exited before readiness (${signal ?? code}). ${logs}`));
        resolveExit({ code, signal });
      });
    },
  );
  let browser: Browser | undefined;
  let killed = false;
  const kill = async () => {
    if (killed) return;
    killed = true;
    // detached=true makes this PID the group leader. Chromium helpers share this group.
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    const termination = await bounded(exited, "SIGKILL exit");
    await browser?.close().catch(() => {}); // Disconnect CDP after the process has died.
    let remaining = await groupMembers(pid);
    for (let attempt = 0; remaining.length && attempt < 20; attempt++) {
      await delay(50);
      remaining = await groupMembers(pid);
    }
    if (remaining.length)
      throw new Error(`Owned Chromium group retained live processes: ${remaining.join(", ")}`);
    await mkdir(resolve(logsPath, ".."), { recursive: true });
    await writeFile(
      logsPath,
      `Chromium: ${chromium.executablePath()}\nPID/group: ${pid}\nExit: ${JSON.stringify(termination)}\n${logs}`,
    );
    if (termination.signal !== "SIGKILL")
      throw new Error(`Chromium was not killed: ${JSON.stringify(termination)}`);
    return termination;
  };
  try {
    browser = await chromium.connectOverCDP(await bounded(endpoint, "startup"));
    const context = browser.contexts()[0];
    if (!context) throw new Error("Chromium persistent context is missing.");
    const page: Page = context.pages()[0] ?? (await context.newPage());
    page.setDefaultTimeout(15_000);
    await page.goto(origin);
    await page.waitForFunction(() => window.harnessReady);
    return { page, pid, profile, kill, logsPath, version: browser.version() };
  } catch (error) {
    await kill();
    throw error;
  }
}
