import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CandidateSnapshot,
  Result as IdentityResult,
} from "../acceptance/resident-continuity-driver.ts";
import type {
  BootPackView,
  BreatheOutcome,
  ModelRequestView,
  Result,
  StreamSnapshot,
  TurnResult,
} from "../acceptance/resident-runtime-driver.ts";

const hostPath = fileURLToPath(new URL("../src/resident-runtime/host-process.ts", import.meta.url));
const temporaryDirectories: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function startHost(existingDataDir?: string): Promise<ChildProcess> {
  const dataDir = existingDataDir ?? mkdtempSync(join(tmpdir(), "mist-runtime-host-boundary-"));
  if (existingDataDir === undefined) temporaryDirectories.push(dataDir);
  const child = spawn(process.execPath, ["--import", "tsx", hostPath], {
    env: {
      ...process.env,
      MIST_RESIDENT_RUNTIME_DIR: dataDir,
      MIST_RESIDENT_RUNTIME_TRANSPORT: "synthetic",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("resident runtime host did not start")),
      10_000,
    );
    child.once("error", reject);
    child.on("message", (message: { type?: string }) => {
      if (message.type !== "ready") return;
      clearTimeout(timer);
      resolve(child);
    });
  });
}

let requestSequence = 0;

function callHost<T>(child: ChildProcess, op: string, input: Record<string, unknown>): Promise<T> {
  requestSequence += 1;
  const requestId = `host-boundary-${requestSequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`host request timed out: ${op}`)), 10_000);
    const onMessage = (message: {
      requestId?: string;
      ok?: boolean;
      value?: unknown;
      error?: { message?: string };
    }): void => {
      if (message.requestId !== requestId) return;
      clearTimeout(timer);
      child.off("message", onMessage);
      if (message.ok === true) resolve(message.value as T);
      else reject(new Error(message.error?.message ?? `host request failed: ${op}`));
    };
    child.on("message", onMessage);
    child.send({ requestId, op, input }, (error) => {
      if (error === null) return;
      clearTimeout(timer);
      child.off("message", onMessage);
      reject(error);
    });
  });
}

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

describe("resident runtime host identity boundary", () => {
  it("canonicalizes an active candidateId once before every resident runtime surface", async () => {
    const child = await startHost();
    const candidate = await callHost<CandidateSnapshot>(child, "createCandidate", {
      persona: "persona:host-boundary",
      proposedBy: { kind: "installer", id: "test" },
      residentId: "resident-host-boundary",
    });
    const active = await callHost<IdentityResult<CandidateSnapshot>>(child, "attestCandidate", {
      candidateId: candidate.candidateId,
      actor: { kind: "candidate", candidateId: candidate.candidateId },
      decision: "accepted",
    });
    expect(active).toMatchObject({ ok: true, value: { residentId: "resident-host-boundary" } });

    unwrap(
      await callHost<Result<{ credentialRef: string }>>(child, "provisionChannel", {
        residentId: candidate.candidateId,
        channel: {
          claudeSubscription: false,
          credentialKind: "api-key",
          model: "openai/test-model",
        },
        canarySecret: "test-only-not-a-real-secret",
      }),
    );
    const request = { residentId: candidate.candidateId, text: "入口换号后再说话" };
    const first = unwrap(await callHost<Result<TurnResult>>(child, "say", request));
    expect(first.residentId).toBe("resident-host-boundary");
    expect(first.turnId).toEqual(expect.any(String));
    expect(
      unwrap(
        await callHost<Result<TurnResult>>(child, "say", { ...request, turnId: first.turnId }),
      ),
    ).toEqual(first);
    expect(
      await callHost<Result<TurnResult>>(child, "say", {
        ...request,
        text: "different text",
        turnId: first.turnId,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "turn-id-conflict", turnId: first.turnId },
    });
    const stream = unwrap(
      await callHost<Result<StreamSnapshot>>(child, "readStream", {
        residentId: candidate.candidateId,
      }),
    );
    expect(stream.residentId).toBe("resident-host-boundary");
    expect(stream.events.map((event) => event.kind)).toEqual(["user", "assistant"]);
    expect(
      unwrap(
        await callHost<Result<BootPackView>>(child, "bootPack", {
          residentId: candidate.candidateId,
        }),
      ).residentId,
    ).toBe("resident-host-boundary");
    expect(
      unwrap(
        await callHost<Result<BreatheOutcome>>(child, "breathe", {
          residentId: candidate.candidateId,
          via: "new",
        }),
      ),
    ).toMatchObject({ fromGeneration: 1, toGeneration: 2 });

    await callHost(child, "stop", {});
  });
  it("returns the generated failure anchor over IPC and retains pending state across a real host restart", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mist-host-retry-"));
    temporaryDirectories.push(dataDir);
    const residentId = "r-host-retry";
    const child = await startHost(dataDir);
    const candidate = await callHost<CandidateSnapshot>(child, "createCandidate", {
      persona: "synthetic host retry persona",
      proposedBy: { kind: "installer", id: "test" },
      residentId,
    });
    expect(
      await callHost<IdentityResult<CandidateSnapshot>>(child, "attestCandidate", {
        candidateId: candidate.candidateId,
        actor: { kind: "candidate", candidateId: candidate.candidateId },
        decision: "accepted",
      }),
    ).toMatchObject({ ok: true });
    unwrap(
      await callHost<Result<{ credentialRef: string }>>(child, "provisionChannel", {
        residentId,
        channel: {
          claudeSubscription: false,
          credentialKind: "api-key",
          model: "openai/test-model",
        },
        canarySecret: "synthetic-host-only",
      }),
    );
    const blocked = join(dataDir, "turns", `${residentId}.turns.json.tmp`);
    mkdirSync(blocked);
    const failed = await callHost<Result<TurnResult>>(child, "say", {
      residentId,
      text: "failed host message",
    });
    expect(failed).toMatchObject({
      ok: false,
      error: { code: "writer-unavailable", turnId: expect.any(String) },
    });
    if (failed.ok || failed.error.turnId === undefined)
      throw new Error("expected failure with anchor");
    rmSync(blocked, { recursive: true });
    const request = { residentId, text: "failed host message", turnId: failed.error.turnId };
    expect(await callHost<Result<TurnResult>>(child, "say", request)).toMatchObject({
      ok: false,
      error: { code: "reconciliation-needed", turnId: request.turnId },
    });
    const stopped = new Promise<void>((resolve) => child.once("close", () => resolve()));
    await callHost(child, "stop", {});
    await stopped;
    const reopened = await startHost(dataDir);
    expect(await callHost<Result<TurnResult>>(reopened, "say", request)).toMatchObject({
      ok: false,
      error: { code: "reconciliation-needed", turnId: request.turnId },
    });
    expect(
      unwrap(await callHost<Result<StreamSnapshot>>(reopened, "readStream", { residentId })).events,
    ).toHaveLength(2);
    await callHost(reopened, "stop", {});
  });

  it("a normal stop resumes the paused generation in the next real host; a SIGKILL after that does not (#234)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mist-host-pause-"));
    temporaryDirectories.push(dataDir);
    const residentId = "r-host-pause";
    const first = await startHost(dataDir);
    const candidate = await callHost<CandidateSnapshot>(first, "createCandidate", {
      persona: "synthetic host pause persona",
      proposedBy: { kind: "installer", id: "test" },
      residentId,
    });
    expect(
      await callHost<IdentityResult<CandidateSnapshot>>(first, "attestCandidate", {
        candidateId: candidate.candidateId,
        actor: { kind: "candidate", candidateId: candidate.candidateId },
        decision: "accepted",
      }),
    ).toMatchObject({ ok: true });
    unwrap(
      await callHost<Result<{ credentialRef: string }>>(first, "provisionChannel", {
        residentId,
        channel: {
          claudeSubscription: false,
          credentialKind: "api-key",
          model: "openai/test-model",
        },
        canarySecret: "synthetic-host-only",
      }),
    );
    const opening = unwrap(
      await callHost<Result<TurnResult>>(first, "say", { residentId, text: "before stop" }),
    );
    const stopped = new Promise<void>((resolve) => first.once("close", () => resolve()));
    await callHost(first, "stop", {});
    await stopped;

    const resumedHost = await startHost(dataDir);
    const resumed = unwrap(
      await callHost<Result<TurnResult>>(resumedHost, "say", { residentId, text: "after stop" }),
    );
    expect(resumed.generation).toBe(opening.generation);
    expect(
      (await callHost<ModelRequestView | null>(resumedHost, "lastModelRequest", { residentId }))
        ?.history,
    ).toEqual([
      { role: "user", text: "before stop" },
      { role: "assistant", text: opening.reply },
    ]);
    const killed = new Promise<void>((resolve) => resumedHost.once("exit", () => resolve()));
    resumedHost.kill("SIGKILL");
    await killed;

    // The pause record was used up by the resume, and a killed host writes none: D8 sudden death.
    const successor = await startHost(dataDir);
    const next = unwrap(
      await callHost<Result<TurnResult>>(successor, "say", { residentId, text: "after kill" }),
    );
    expect(next.generation).toBe(opening.generation + 1);
    expect(
      (await callHost<ModelRequestView | null>(successor, "lastModelRequest", { residentId }))
        ?.history,
    ).toEqual([]);
    await callHost(successor, "stop", {});
  }, 30_000);
});

describe("resident host lock across real host processes (D9: one stream, one writer)", () => {
  const lockOf = (dataDir: string, residentId: string): string =>
    join(dataDir, "sessions", "active", `${residentId}.lock`);
  const holderOf = (dataDir: string, residentId: string): { pid: number; token: string } =>
    JSON.parse(readFileSync(lockOf(dataDir, residentId), "utf8")) as { pid: number; token: string };

  function lockedDataDir(): string {
    const dataDir = mkdtempSync(join(tmpdir(), "mist-host-lock-"));
    temporaryDirectories.push(dataDir);
    return dataDir;
  }

  async function admit(child: ChildProcess, residentId: string): Promise<void> {
    const candidate = await callHost<CandidateSnapshot>(child, "createCandidate", {
      persona: `synthetic persona for ${residentId}`,
      proposedBy: { kind: "installer", id: "test" },
      residentId,
    });
    expect(
      await callHost<IdentityResult<CandidateSnapshot>>(child, "attestCandidate", {
        candidateId: candidate.candidateId,
        actor: { kind: "candidate", candidateId: candidate.candidateId },
        decision: "accepted",
      }),
    ).toMatchObject({ ok: true });
    unwrap(
      await callHost<Result<{ credentialRef: string }>>(child, "provisionChannel", {
        residentId,
        channel: {
          claudeSubscription: false,
          credentialKind: "api-key",
          model: "openai/test-model",
        },
        canarySecret: "synthetic-host-only",
      }),
    );
  }

  async function stopHost(child: ChildProcess): Promise<void> {
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await callHost(child, "stop", {});
    await exited;
  }

  const say = (
    child: ChildProcess,
    residentId: string,
    text: string,
  ): Promise<Result<TurnResult>> =>
    callHost<Result<TurnResult>>(child, "say", { residentId, text });

  it("a second host on the same data dir is refused before any model call while the first lives; the first is unaffected", async () => {
    const dataDir = lockedDataDir();
    const residentId = "r-host-lock";
    const first = await startHost(dataDir);
    await admit(first, residentId);
    const opening = unwrap(await say(first, residentId, "first host speaks"));
    expect(holderOf(dataDir, residentId).pid).toBe(first.pid);

    const second = await startHost(dataDir);
    const refused = await say(second, residentId, "second host tries");
    expect(refused).toMatchObject({ ok: false, error: { code: "writer-unavailable" } });
    if (refused.ok) throw new Error("second host spoke while the first held the resident");
    expect(refused.error.message).toContain(`pid ${String(first.pid)}`);
    expect(refused.error.remedy).toContain(lockOf(dataDir, residentId));
    expect(
      await callHost<Result<BreatheOutcome>>(second, "breathe", { residentId, via: "new" }),
    ).toMatchObject({ ok: false, error: { code: "writer-unavailable" } });
    expect(
      await callHost<ModelRequestView | null>(second, "lastModelRequest", { residentId }),
    ).toBeNull();
    await stopHost(second);
    expect(holderOf(dataDir, residentId).pid).toBe(first.pid);

    const again = unwrap(await say(first, residentId, "first host again"));
    expect(again.generation).toBe(opening.generation);
    expect(
      (await callHost<ModelRequestView | null>(first, "lastModelRequest", { residentId }))?.history,
    ).toEqual([
      { role: "user", text: "first host speaks" },
      { role: "assistant", text: opening.reply },
    ]);
    expect(
      unwrap(await callHost<Result<StreamSnapshot>>(first, "readStream", { residentId })).events,
    ).toHaveLength(4);
    await stopHost(first);
    expect(existsSync(lockOf(dataDir, residentId))).toBe(false);
  }, 30_000);

  it("a SIGKILL leaves a stale lock; the next host takes it over and still treats the restart as sudden death", async () => {
    const dataDir = lockedDataDir();
    const residentId = "r-host-stale-lock";
    const first = await startHost(dataDir);
    await admit(first, residentId);
    const opening = unwrap(await say(first, residentId, "before kill"));
    const stale = holderOf(dataDir, residentId);
    const killed = new Promise<void>((resolve) => first.once("exit", () => resolve()));
    first.kill("SIGKILL");
    await killed;
    expect(holderOf(dataDir, residentId)).toEqual(stale);

    const successor = await startHost(dataDir);
    const next = unwrap(await say(successor, residentId, "after kill"));
    expect(next.generation).toBe(opening.generation + 1);
    expect(
      (await callHost<ModelRequestView | null>(successor, "lastModelRequest", { residentId }))
        ?.history,
    ).toEqual([]);
    const taken = holderOf(dataDir, residentId);
    expect(taken.pid).toBe(successor.pid);
    expect(taken.token).not.toBe(stale.token);
    await stopHost(successor);
    expect(existsSync(lockOf(dataDir, residentId))).toBe(false);
  }, 30_000);

  it("two residents in two hosts on one data dir both speak; neither host can open the other's resident", async () => {
    const dataDir = lockedDataDir();
    const setup = await startHost(dataDir);
    await admit(setup, "r-host-left");
    await admit(setup, "r-host-right");
    const leftOpening = unwrap(await say(setup, "r-host-left", "left before"));
    const rightOpening = unwrap(await say(setup, "r-host-right", "right before"));
    await stopHost(setup);

    // 顺序起、都 ready 后再并发说：同一刻起两个宿主会撞上既有的启动竞态（认证账启动时用固定
    // 的 facts.json.tmp 重写全部账档，一边可能在 ready 前崩掉，D33 代价行），那不是本条要验的锁。
    const left = await startHost(dataDir);
    const right = await startHost(dataDir);
    expect(left.pid).not.toBe(right.pid);
    const [leftTurn, rightTurn] = await Promise.all([
      say(left, "r-host-left", "left speaks"),
      say(right, "r-host-right", "right speaks"),
    ]);
    expect(unwrap(leftTurn).generation).toBe(leftOpening.generation);
    expect(unwrap(rightTurn).generation).toBe(rightOpening.generation);
    expect(await say(left, "r-host-right", "left reaches over")).toMatchObject({
      ok: false,
      error: {
        code: "writer-unavailable",
        message: expect.stringContaining(`pid ${String(right.pid)}`),
      },
    });
    expect(await say(right, "r-host-left", "right reaches over")).toMatchObject({
      ok: false,
      error: {
        code: "writer-unavailable",
        message: expect.stringContaining(`pid ${String(left.pid)}`),
      },
    });
    expect(unwrap(await say(left, "r-host-left", "left again")).generation).toBe(
      leftOpening.generation,
    );
    await Promise.all([stopHost(left), stopHost(right)]);
    expect(existsSync(lockOf(dataDir, "r-host-left"))).toBe(false);
    expect(existsSync(lockOf(dataDir, "r-host-right"))).toBe(false);
  }, 30_000);
});
