import { type ChildProcess, execFileSync, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  RoomEvent as AcceptanceRoomEvent,
  GroupChatCheckId,
  GroupChatCommand,
  GroupChatHostDriver,
  GroupChatHostRun,
  groupChatSyntheticFixture,
} from "../acceptance/group-chat-driver.ts";
import type {
  RoomBindingGrant,
  RoomMessageEnvelope,
  RoomPostResult,
} from "./group-chat/post-room-message.ts";
import type { RoomEvent } from "./group-chat/room-event-store.ts";

type ResponseMessage =
  | { readonly kind: "ready"; readonly pid: number }
  | { readonly id: string; readonly ok: true; readonly value?: unknown }
  | { readonly id: string; readonly ok: false; readonly error: string };

interface PendingResponse {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

class HostProcessClient {
  readonly #pending = new Map<string, PendingResponse>();
  readonly #ready: Promise<void>;
  readonly #stderrChunks: string[] = [];
  readonly #child: ChildProcess;
  #resolveReady!: () => void;
  #rejectReady!: (error: Error) => void;

  constructor(child: ChildProcess) {
    this.#child = child;
    this.#ready = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => this.#stderrChunks.push(chunk));
    child.on("message", (message: ResponseMessage) => this.#onMessage(message));
    child.once("error", (error) => this.#fail(error));
    child.once("exit", (code, signal) => {
      const detail = `host exited ${String(code)}/${String(signal)}${this.#stderrChunks.join("")}`;
      this.#fail(new Error(detail));
    });
  }

  get pid(): number {
    if (this.#child.pid === undefined) throw new Error("host process has no pid");
    return this.#child.pid;
  }

  async waitReady(): Promise<void> {
    await this.#ready;
  }

  async request<T>(kind: string, fields: Record<string, unknown> = {}): Promise<T> {
    await this.#ready;
    const id = randomUUID();
    const response = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.#child.send({ id, kind, ...fields }, (error) => {
      if (error !== null) {
        const pending = this.#pending.get(id);
        this.#pending.delete(id);
        pending?.reject(error);
      }
    });
    return (await response) as T;
  }

  waitForExit(): Promise<void> {
    if (this.#child.exitCode !== null) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.#child.once("exit", (code, signal) => {
        if (code === 0 || code === null) resolve();
        else reject(new Error(`host exited ${String(code)}/${String(signal)}`));
      });
    });
  }

  terminate(): void {
    if (this.#child.exitCode === null) this.#child.kill();
  }

  #onMessage(message: ResponseMessage): void {
    if ("kind" in message && message.kind === "ready") {
      this.#resolveReady();
      return;
    }
    if (!("id" in message)) return;
    const pending = this.#pending.get(message.id);
    if (pending === undefined) return;
    this.#pending.delete(message.id);
    if (message.ok) pending.resolve(message.value);
    else pending.reject(new Error(message.error));
  }

  #fail(error: Error): void {
    this.#rejectReady(error);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

type FixtureWithTrustedBinding = Omit<typeof groupChatSyntheticFixture, "trustedOwnerBinding"> & {
  readonly trustedOwnerBinding?: unknown;
};

/** Real child-process adapter for the durable room-write slice; unsupported lamps fail explicitly. */
export function createGroupChatHostDriver(): GroupChatHostDriver & {
  restartHost(): Promise<GroupChatHostRun>;
} {
  const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
  const hostEntry = fileURLToPath(new URL("./group-chat/host-process.ts", import.meta.url));
  const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), "mist-group-chat-")));
  let client: HostProcessClient | null = null;
  process.once("exit", () => rmSync(dataRoot, { recursive: true, force: true }));

  const startHost = async (): Promise<GroupChatHostRun> => {
    if (client !== null) throw new Error("group-chat host is already running");
    const child = fork(hostEntry, [], {
      cwd: repositoryRoot,
      execPath: process.execPath,
      execArgv: ["--import", "tsx"],
      env: { ...process.env, MIST_GROUP_CHAT_DATA_ROOT: dataRoot },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    const started = new HostProcessClient(child);
    client = started;
    try {
      await started.waitReady();
    } catch (error) {
      client = null;
      child.kill();
      await started.waitForExit();
      throw error;
    }
    const run = {
      pid: started.pid,
      commit: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repositoryRoot,
        encoding: "utf8",
      }).trim(),
      dataRoot,
    };
    return run;
  };

  const stopHost = async (): Promise<void> => {
    const current = client;
    if (current === null) return;
    client = null;
    try {
      await current.request("shutdown");
    } catch (error) {
      current.terminate();
      await current.waitForExit();
      throw error;
    }
    await current.waitForExit();
  };

  const active = (): HostProcessClient => {
    if (client === null) throw new Error("group-chat host is not running");
    return client;
  };

  return {
    kind: "mist-host",
    startHost,
    restartHost: async () => {
      if (client !== null) await stopHost();
      return startHost();
    },
    stopHost,
    resetScenario: async (_id: GroupChatCheckId, fixture: FixtureWithTrustedBinding) => {
      const trustedBinding = fixture.trustedOwnerBinding;
      const grants: RoomBindingGrant[] =
        typeof trustedBinding === "string"
          ? [fixture.humanId, fixture.residentIds.a].map((principalId) => ({
              principalId,
              roomId: fixture.roomId,
              bindingId: trustedBinding,
            }))
          : [];
      await active().request("reset", { grants });
    },
    perform: async (command: GroupChatCommand) => {
      if (command.kind !== "post")
        throw new Error(`unsupported group-chat host command: ${command.kind}`);
      const { kind: _kind, ...rawFields } = command;
      void _kind;
      const envelope = { ...rawFields, operationId: randomUUID() } as RoomMessageEnvelope;
      await active().request<RoomPostResult>("post", {
        principal: { principalId: command.principalId },
        envelope,
      });
    },
    readRoomEvents: async (roomId?: string) => {
      const rows = await active().request<readonly RoomEvent[]>("read-room-events", { roomId });
      return rows.map(toAcceptanceRoomEvent);
    },
    readSystemReceipts: () => active().request("read-system-receipts"),
    readDeliveries: unsupported("readDeliveries"),
    readMemories: unsupported("readMemories"),
    readResidentContext: unsupported("readResidentContext"),
    readRoster: unsupported("readRoster"),
    readRosterPath: unsupported("readRosterPath"),
    readMentionDecisions: unsupported("readMentionDecisions"),
    readCallLedger: unsupported("readCallLedger"),
    readContextCommits: unsupported("readContextCommits"),
    readSurface: unsupported("readSurface"),
    readAccessAudit: unsupported("readAccessAudit"),
    readReactions: unsupported("readReactions"),
  };
}

function toAcceptanceRoomEvent(event: RoomEvent): AcceptanceRoomEvent {
  return {
    id: event.id,
    roomId: event.roomId,
    position: event.position,
    authorId: event.authorId,
    body: event.body,
    visibility: event.visibility,
  };
}

function unsupported<T>(operation: string): (...args: never[]) => Promise<T> {
  return async () => {
    throw new Error(`group-chat host does not implement ${operation}`);
  };
}
