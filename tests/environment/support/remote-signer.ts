import { fork } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type Operation = "connect" | "sign" | "encrypt" | "decrypt";
export type Policy = "allow" | "deny" | "hold";
interface Approval {
  type: "approval";
  id: number;
  operation: Operation;
}
interface Ready {
  type: "ready";
  uri: string;
  pubkey: string;
  version: string;
  pid: number;
}
interface Response {
  type: "response";
  id: number;
  value: { listening: boolean; relays?: number };
  error?: string;
}

/** Runs the unmodified Applesauce provider in another OS process with its own account key. */
export async function startRemoteSigner(relay: string) {
  const child = fork(resolve("integration/signer/provider.mjs"), [relay], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    execArgv: [],
  });
  const logsPath = resolve("output/environment/signer", `${child.pid}.log`);
  let log = "";
  const record = (bytes: Buffer) => {
    log = (log + bytes.toString()).slice(-1_000_000);
  };
  child.stdout?.on("data", record);
  child.stderr?.on("data", record);
  const approvals: Approval[] = [];
  const commands = new Map<
    number,
    { resolve(value: Response["value"]): void; reject(error: Error): void }
  >();
  let sequence = 0;
  let resolveReady: (value: Ready) => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  const ready = new Promise<Ready>((resolveValue, reject) => {
    resolveReady = resolveValue;
    rejectReady = reject;
  });
  let wakeApproval = () => {};
  child.on("message", (message: Ready | Response | Approval) => {
    if (message.type === "ready") resolveReady(message);
    else if (message.type === "approval") {
      approvals.push(message);
      wakeApproval();
    } else {
      const command = commands.get(message.id);
      commands.delete(message.id);
      if (message.error) command?.reject(new Error(message.error));
      else command?.resolve(message.value);
    }
  });
  const exited = new Promise<number | null>((resolveExit) => {
    child.once("exit", (code) => {
      const error = new Error(`Remote signer exited (${code}). ${log}`);
      rejectReady(error);
      for (const command of commands.values()) command.reject(error);
      commands.clear();
      wakeApproval();
      resolveExit(code);
    });
  });
  child.once("error", rejectReady);
  async function bounded<T>(promise: Promise<T>, operation: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Remote signer ${operation} timed out. ${log}`)),
            15_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  const command = (name: string, fields: Record<string, unknown> = {}) => {
    const id = ++sequence;
    const result = new Promise<Response["value"]>((resolveValue, reject) => {
      commands.set(id, { resolve: resolveValue, reject });
      child.send({ command: name, id, ...fields }, (error) => {
        if (error) {
          commands.delete(id);
          reject(error);
        }
      });
    });
    return bounded(result, name);
  };
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const state = await command("close");
      if (state.listening || state.relays !== 0)
        throw new Error("Signer retained relay resources.");
      if ((await bounded(exited, "exit")) !== 0) throw new Error("Signer exit was not clean.");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await bounded(exited, "kill");
      }
      await mkdir(resolve(logsPath, ".."), { recursive: true });
      await writeFile(logsPath, log);
    }
  };
  try {
    const info = await bounded(ready, "startup");
    return {
      ...info,
      logsPath,
      policy: (policies: Partial<Record<Operation, Policy>>) => command("policy", { policies }),
      release: (approval: number, allow: boolean) => command("release", { approval, allow }),
      stop: () => command("stop"),
      start: () => command("start"),
      async nextApproval(operation: Operation): Promise<Approval> {
        return bounded(
          (async () => {
            while (true) {
              const index = approvals.findIndex((approval) => approval.operation === operation);
              if (index !== -1) return approvals.splice(index, 1)[0] as Approval;
              if (child.exitCode !== null || child.signalCode !== null)
                throw new Error("Signer exited before approval.");
              await new Promise<void>((resolveWake) => {
                wakeApproval = resolveWake;
              });
            }
          })(),
          `approval (${operation})`,
        );
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
