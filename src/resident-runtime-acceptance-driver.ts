/**
 * #194（RT-01～RT-09）的**生产验收驱动**。acceptance/resident-runtime-run.ts import
 * 本文件并调用 createResidentRuntimeDriver()；缺本文件时九盏灯全红（判卷先行的起点）。
 *
 * 真实性纪律（照 src/window-history-acceptance-driver.ts 的口径）：
 *   - startHost() 真 spawn 子进程 src/resident-runtime/host-process.ts（spawn + stdio ipc
 *     + {requestId, ok, value|error} 把手），返回真实 {pid, bootId, dataDir}；bootId/pid
 *     每次 boot 都不同。**第一次用到宿主方法时自动起宿主**（RT-01 全程不调 startHost）。
 *   - 每个方法都转发给正在跑的子进程；killHost 是真 SIGKILL，重启只能从盘上读回。
 *   - 一个 driver 实例一个稳定 dataDir，跨 kill/restart 复用，reset() 才 rm -rf 重建。
 *   - 模型往返经 MIST_RESIDENT_RUNTIME_TRANSPORT 选传输（默认合成通道，见
 *     src/resident-runtime/channels.ts 顶注：公开 CI 不带密钥；真实 pi 传输随 RT-04）。
 *
 * 出处归结构（清单「真灯与桩灯」）：被判的运行时实现在 src/resident-runtime/ 各模块；
 * 正常行为方法只做 IPC 接线。RT-08 的三个故障夹具只在宿主停止时破坏临时数据根，
 * 并由判卷另行读回正对照；它们不实现被判行为。
 *
 * RT-09（#234）：stopHost 走宿主的正常关闭（IPC `stop` → runtime.close()，与终端
 * `/exit`、stdin 结束同一条），只等子进程自己退出；raceHosts 在同一数据根上顺序另起
 * 两个子进程、都 ready 后同一时刻各说一句，每边走到哪一步照实报（不把起不来折成 say 的
 * 结果）；ledgerAlignment 只读 residents/ 下认证账的落盘确认位；appendLedgerFact
 * 经宿主的 host.system() 入账。tamperPauseRecord 是故障夹具：只在宿主停着时按
 * `pause-records.ts` 给的真实路径把一位住户的暂停记录删掉、截断或换成别的窗，不实现
 * 被判行为。
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CandidateSnapshot,
  Result as IdentityResult,
} from "../acceptance/resident-continuity-driver.ts";
import type {
  BootPackView,
  BreathTrigger,
  BreatheOutcome,
  ChannelRoute,
  ChannelSpec,
  ContendedTurn,
  HostDescriptor,
  LedgerAlignmentView,
  LedgerViewportAlignmentView,
  LetterTimeline,
  ModelRequestView,
  PauseRecordFault,
  ResidentRuntimeDriver,
  Result,
  SecretScanReport,
  StreamFileInventory,
  StreamSnapshot,
  TuiStep,
  TuiTranscript,
  TurnResult,
} from "../acceptance/resident-runtime-driver.ts";
import { pauseRecordPath } from "./resident-runtime/pause-records.ts";

/**
 * 判卷桩申报（清单「真灯与桩灯」）：空。RT-09 的暂停记录故障夹具随 #234 施工落地，
 * 其余调用均转发给真实宿主子进程。
 */
export const STUBBED: readonly string[] = [];

const HOST_PROCESS = fileURLToPath(new URL("./resident-runtime/host-process.ts", import.meta.url));
const READY_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 15_000;
/** 正常关闭后等子进程自己退出的上限；超时就是红，不是暂停。 */
const STOP_TIMEOUT_MS = 10_000;

interface HostReply {
  readonly requestId?: string;
  readonly type?: string;
  readonly pid?: number;
  readonly bootId?: string;
  readonly ok?: boolean;
  readonly value?: unknown;
  readonly error?: { readonly name?: string; readonly message?: string };
}

let requestSequence = 0;

class ResidentRuntimeProductionDriver implements ResidentRuntimeDriver {
  readonly #dataDir: string;
  #child: ChildProcess | null = null;
  #descriptor: HostDescriptor | null = null;

  constructor() {
    // 稳定的每实例落盘根：跨 kill/restart 复用，reset() 才清掉重建。
    this.#dataDir = mkdtempSync(join(tmpdir(), "mist-resident-runtime-"));
  }

  // —— 真实宿主：起得来、杀得死、拉得起 ——

  async startHost(): Promise<HostDescriptor> {
    if (this.#child !== null) await this.killHost();
    return this.#spawnHost();
  }

  async killHost(): Promise<void> {
    const child = this.#child;
    if (child === null) return;
    this.#child = null;
    this.#descriptor = null;
    await killHostChild(child);
  }

  async stopHost(): Promise<void> {
    const child = this.#child;
    if (child === null) return;
    this.#child = null;
    this.#descriptor = null;
    await stopHostChild(child);
  }

  async hostDescriptor(): Promise<HostDescriptor> {
    return this.#requireDescriptor();
  }

  async reset(): Promise<void> {
    await this.killHost();
    rmSync(this.#dataDir, { recursive: true, force: true });
    mkdirSync(this.#dataDir, { recursive: true });
  }

  // —— 通道（D25） ——

  provisionChannel(input: {
    residentId: string;
    channel: ChannelSpec;
    canarySecret: string;
  }): Promise<Result<ProvisionedChannelForward>> {
    return this.#ensureActiveResident(input.residentId).then(() =>
      this.#call("provisionChannel", { input }),
    );
  }

  async revokeCredential(input: { residentId: string }): Promise<void> {
    await this.#call("revokeCredential", { input });
  }

  resolveChannelRoute(input: { channel: ChannelSpec }): Promise<Result<ChannelRoute>> {
    return this.#call("resolveChannelRoute", { input });
  }

  // —— 对话往返 ——

  say(input: { residentId: string; text: string; turnId?: string }): Promise<Result<TurnResult>> {
    return this.#ensureActiveResident(input.residentId).then(() => this.#call("say", { input }));
  }

  modelInvocationCount(): Promise<number> {
    return this.#call("modelInvocationCount", {});
  }

  async armTurnConfirmationWriteFault(input: { residentId: string }): Promise<void> {
    await this.#ensureActiveResident(input.residentId);
    mkdirSync(join(this.#dataDir, "turns"), { recursive: true });
    mkdirSync(this.#turnReceiptTemporaryPath(input.residentId));
  }

  repairTurnConfirmationWriteFault(input: { residentId: string }): Promise<void> {
    rmSync(this.#turnReceiptTemporaryPath(input.residentId), { recursive: true, force: true });
    return Promise.resolve();
  }

  async crashAfterUserWrite(input: { residentId: string; turnId: string }): Promise<void> {
    assertFixtureResidentId(input.residentId);
    await this.killHost();
    const streamPath = join(this.#dataDir, "streams", `${input.residentId}.stream.json`);
    const record = parseObjectFile(streamPath);
    const events = requireArray(record.events, "stream events");
    const idempotency = requireArray(record.idempotency, "stream idempotency");
    const matching = events.filter((event) => eventTurnId(event) === input.turnId);
    const user = matching.find((event) => eventRole(event) === "user");
    const assistant = matching.find((event) => eventRole(event) === "assistant");
    if (user === undefined || assistant === undefined || matching.length !== 2) {
      throw new Error(`cannot create orphan fixture for ${input.residentId}/${input.turnId}`);
    }
    const assistantId = requireString(assistant.eventId, "assistant eventId");
    const retainedEvents = events.filter((event) => event !== assistant);
    const retainedIdempotency = idempotency.filter(
      (entry) => idempotencyEventId(entry) !== assistantId,
    );
    if (retainedIdempotency.length !== idempotency.length - 1) {
      throw new Error(`assistant idempotency row missing for ${input.residentId}/${input.turnId}`);
    }
    writeFileSync(
      streamPath,
      JSON.stringify({
        ...record,
        nextSeq: retainedEvents.length + 1,
        events: retainedEvents,
        idempotency: retainedIdempotency,
      }),
      "utf8",
    );

    const turnsPath = join(this.#dataDir, "turns", `${input.residentId}.turns.json`);
    if (existsSync(turnsPath)) {
      const turnsRecord = parseObjectFile(turnsPath);
      const turns = requireArray(turnsRecord.turns, "turn confirmations");
      writeFileSync(
        turnsPath,
        JSON.stringify({
          ...turnsRecord,
          turns: turns.filter((entry) => objectString(entry, "turnId") !== input.turnId),
        }),
        "utf8",
      );
    }
    await this.startHost();
  }

  lastModelRequest(input: { residentId: string }): Promise<ModelRequestView | null> {
    return this.#call("lastModelRequest", { input });
  }

  // —— 认证事实账（RT-09） ——

  appendLedgerFact(input: { residentId: string; body: string }): Promise<Result<{ seq: number }>> {
    return this.#ensureActiveResident(input.residentId).then(() =>
      this.#call("appendLedgerFact", { input }),
    );
  }

  ledgerAlignment(input: { residentId: string }): Promise<Result<LedgerAlignmentView>> {
    // 只读落盘那份：宿主停着也读得到，且不经 IPC——调宿主方法会把停着的宿主拉起来，
    // 判卷在正常退出与下次启动之间要核的恰恰是「暂停本身没动确认位」。
    assertFixtureResidentId(input.residentId);
    const path = join(this.#dataDir, "residents", `${input.residentId}.facts.json`);
    if (!existsSync(path)) {
      return Promise.resolve({
        ok: false,
        error: {
          code: "resident-not-found",
          message: `这位住户没有认证事实账：${input.residentId}`,
          remedy: "先让住户入住（attestCandidate 物化房间时开账）再读确认位",
          residentId: input.residentId,
        },
      });
    }
    const record = parseObjectFile(path);
    const entries = requireArray(record.entries, "ledger entries");
    const viewports = requireArray(record.viewports, "ledger viewports").map(toAlignmentRow);
    return Promise.resolve({
      ok: true,
      value: { residentId: input.residentId, latestSeq: entries.length, viewports },
    });
  }

  // —— 暂停记录与并发（RT-09，#234） ——

  async tamperPauseRecord(input: { residentId: string; fault: PauseRecordFault }): Promise<void> {
    assertFixtureResidentId(input.residentId);
    if (this.#child !== null) {
      throw new Error("tamperPauseRecord 只在宿主停着时用：先 stopHost");
    }
    const path = pauseRecordPath(this.#dataDir, input.residentId);
    if (!existsSync(path)) {
      // 没有记录可弄坏就不是「坏记录」夹具：静默放过会让三种坏法塌成同一个「本来就没有」。
      throw new Error(`${input.residentId} 没有暂停记录可弄坏——正常退出没给这位住户落记录`);
    }
    if (input.fault === "missing") {
      rmSync(path);
    } else if (input.fault === "garbled") {
      const raw = readFileSync(path, "utf8");
      writeFileSync(path, raw.slice(0, Math.floor(raw.length / 2)), "utf8");
    } else {
      // 记录完好可读、字段齐全，只是指向另一扇窗：不是这位住户这扇窗这一代的那笔。
      const record = parseObjectFile(path);
      const windowId = requireString(record.windowId, "pause record windowId");
      const foreign = `${windowId.slice(0, -1)}${windowId.endsWith("0") ? "1" : "0"}`;
      writeFileSync(path, JSON.stringify({ ...record, windowId: foreign }), "utf8");
    }
  }

  async raceHosts(input: {
    residentId: string;
    texts: readonly [string, string];
  }): Promise<readonly [ContendedTurn, ContendedTurn]> {
    assertFixtureResidentId(input.residentId);
    if (this.#child !== null) {
      throw new Error("raceHosts 要求驱动自己的宿主先停（stopHost）——不许有第三个宿主同时在场");
    }
    // 顺序起：先起一个等它 ready，再起第二个等它 ready。同一刻起两个会撞上既有的认证账
    // 启动竞态（固定的 facts.json.tmp），一边在 ready 前崩掉——那不是这里要验的（PR #235
    // 验收席 P1-1）。暂停记录认领与住户锁都在第一句 say 上，下面同一时刻发出两句时真撞。
    const first = spawnHostChild(this.#dataDir);
    const firstReady = await settle(first.ready);
    const second = spawnHostChild(this.#dataDir);
    const secondReady = await settle(second.ready);
    const outcomes: ContendedTurn[] = [];
    try {
      const [left, right] = await Promise.all([
        contend(first.child, firstReady, input.residentId, input.texts[0]),
        contend(second.child, secondReady, input.residentId, input.texts[1]),
      ]);
      outcomes.push(left, right);
      return [left, right];
    } finally {
      // 说完话的正常关闭（同 stopHost）；没起来或请求抛错的直接杀掉，不留孤儿进程。
      await Promise.all(
        [first, second].map((contender, index) =>
          outcomes[index]?.stage === "said"
            ? stopHostChild(contender.child)
            : killHostChild(contender.child),
        ),
      );
    }
  }

  // —— 一窗流只读 ——

  readStream(input: { residentId: string }): Promise<Result<StreamSnapshot>> {
    return this.#call("readStream", { input });
  }

  streamFiles(): Promise<Result<StreamFileInventory>> {
    return this.#call("streamFiles", {});
  }

  // —— 启动包与交接信 ——

  bootPack(input: { residentId: string }): Promise<Result<BootPackView>> {
    return this.#call("bootPack", { input });
  }

  letterTimeline(input: { residentId: string }): Promise<Result<LetterTimeline>> {
    return this.#call("letterTimeline", { input });
  }

  // —— 换气（D8，RT-03 的地盘） ——

  setBreathThreshold(input: {
    residentId: string;
    windowId: string;
    generation: number;
    thresholdTokens: number;
    authority: "window" | "owner";
  }): Promise<Result<void>> {
    return this.#call("setBreathThreshold", { input });
  }

  breathe(input: { residentId: string; via: BreathTrigger }): Promise<Result<BreatheOutcome>> {
    return this.#call("breathe", { input });
  }

  async suddenDeath(input: { residentId: string }): Promise<void> {
    await this.#call("suddenDeath", { input });
  }

  archivedTranscript(input: {
    residentId: string;
    generation: number;
  }): Promise<Result<StreamSnapshot>> {
    return this.#call("archivedTranscript", { input });
  }

  // —— TUI（RT-05 的地盘） ——

  tuiTranscript(input: {
    residentId: string;
    channel: ChannelSpec;
    script: readonly TuiStep[];
  }): Promise<Result<TuiTranscript>> {
    return this.#ensureActiveResident(input.residentId).then(() =>
      this.#call("tuiTranscript", { input }),
    );
  }

  // —— 静态审计的检索根（RT-07） ——

  auditRoots(): Promise<readonly string[]> {
    // 「mist 当宿主，pi 当零件库」：pi 扩展不另起写入面，无扩展根可追加。
    return Promise.resolve([]);
  }

  // —— 凭证扫描（RT-06） ——

  secretScan(input: { residentId: string; needle: string }): Promise<Result<SecretScanReport>> {
    return this.#call("secretScan", { input });
  }

  // —— IPC ——

  async #spawnHost(): Promise<HostDescriptor> {
    const spawned = spawnHostChild(this.#dataDir);
    this.#child = spawned.child;
    const descriptor = await spawned.ready;
    this.#descriptor = descriptor;
    return descriptor;
  }

  #requireDescriptor(): Promise<HostDescriptor> {
    if (this.#descriptor !== null) return Promise.resolve(this.#descriptor);
    return this.#spawnHost();
  }

  #call<T>(op: string, payload: Record<string, unknown>): Promise<T> {
    return this.#requireDescriptor().then(() => {
      const child = this.#child;
      if (child === null) return Promise.reject(new Error("resident runtime host is not running"));
      return callHost<T>(child, op, payload);
    });
  }

  async #ensureActiveResident(residentId: string): Promise<void> {
    const current = await this.#call<IdentityResult<unknown>>("requireActiveResident", {
      input: { referenceId: residentId },
    });
    if (current.ok) return;
    if (current.reason !== "resident-not-found") {
      throw new Error(`acceptance resident ${residentId} is not activatable: ${current.reason}`);
    }
    const candidate = await this.#call<CandidateSnapshot>("createCandidate", {
      input: {
        persona: `acceptance-persona:${residentId}`,
        proposedBy: { kind: "installer", id: "resident-runtime-acceptance" },
        residentId,
      },
    });
    const attested = await this.#call<IdentityResult<CandidateSnapshot>>("attestCandidate", {
      input: {
        candidateId: candidate.candidateId,
        actor: { kind: "candidate", candidateId: candidate.candidateId },
        decision: "accepted",
      },
    });
    if (!attested.ok || attested.value.residentId !== residentId) {
      throw new Error(`failed to activate acceptance resident ${residentId}`);
    }
  }

  #turnReceiptTemporaryPath(residentId: string): string {
    assertFixtureResidentId(residentId);
    return join(this.#dataDir, "turns", `${residentId}.turns.json.tmp`);
  }
}

/** 结构与契约 ProvisionedChannel 相同；host 走 JSON，这里只做转发类型。 */
type ProvisionedChannelForward = ChannelRoute & { readonly credentialRef: string };

function assertFixtureResidentId(residentId: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(residentId)) {
    throw new Error(`unsafe acceptance residentId: ${residentId}`);
  }
}

function parseObjectFile(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`expected object in ${path}`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, name: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`${name} entry must be an object`);
    }
    return entry as Record<string, unknown>;
  });
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} must be a string`);
  return value;
}

function objectString(value: Record<string, unknown>, key: string): string | null {
  const member = value[key];
  return typeof member === "string" ? member : null;
}

function eventTurnId(event: Record<string, unknown>): string | null {
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  return objectString(payload as Record<string, unknown>, "turnId");
}

function eventRole(event: Record<string, unknown>): string | null {
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  return objectString(payload as Record<string, unknown>, "role");
}

function idempotencyEventId(entry: Record<string, unknown>): string | null {
  const receipt = entry.receipt;
  if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt)) return null;
  return objectString(receipt as Record<string, unknown>, "eventId");
}

function toAlignmentRow(row: Record<string, unknown>): LedgerViewportAlignmentView {
  const identity = row.identity;
  const generation =
    typeof identity === "object" && identity !== null && !Array.isArray(identity)
      ? (identity as Record<string, unknown>).generation
      : null;
  const baselineSeq = row.baselineSeq;
  const ackedSeq = row.ackedSeq;
  if (typeof baselineSeq !== "number" || typeof ackedSeq !== "number") {
    throw new Error("ledger viewport row has no numeric baselineSeq/ackedSeq");
  }
  return {
    windowId: requireString(row.viewportId, "ledger viewportId"),
    generation: typeof generation === "number" ? generation : null,
    baselineSeq,
    ackedSeq,
  };
}

function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return promise.then(
    (value): PromiseSettledResult<T> => ({ status: "fulfilled", value }),
    (reason: unknown): PromiseSettledResult<T> => ({ status: "rejected", reason }),
  );
}

/**
 * 并发夹具里一个宿主的结局，照实报走到了哪一步：起不来是 `not-ready`，请求抛错是
 * `request-failed`，都不折成 say 的结果；只有 say 真返回了才是 `said`。
 */
async function contend(
  child: ChildProcess,
  ready: PromiseSettledResult<HostDescriptor>,
  residentId: string,
  text: string,
): Promise<ContendedTurn> {
  const pid = child.pid ?? null;
  if (ready.status === "rejected") {
    return {
      stage: "not-ready",
      pid,
      readyPid: null,
      result: null,
      failure: `宿主没起来：${describeError(ready.reason)}`,
    };
  }
  const readyPid = ready.value.pid;
  try {
    const result = await callHost<Result<TurnResult>>(child, "say", {
      input: { residentId, text },
    });
    return { stage: "said", pid, readyPid, result, failure: null };
  } catch (error) {
    return {
      stage: "request-failed",
      pid,
      readyPid,
      result: null,
      failure: `宿主请求失败：${describeError(error)}`,
    };
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function spawnHostChild(dataDir: string): {
  readonly child: ChildProcess;
  readonly ready: Promise<HostDescriptor>;
} {
  const child = spawn(process.execPath, ["--import", "tsx", HOST_PROCESS], {
    env: { ...process.env, MIST_RESIDENT_RUNTIME_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  return { child, ready: waitForReady(child, dataDir) };
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (hasExited(child)) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function killHostChild(child: ChildProcess): Promise<void> {
  if (hasExited(child)) return;
  const exited = waitForExit(child);
  child.kill("SIGKILL");
  await exited;
}

/**
 * 正常关闭一个宿主子进程：发 `stop`（宿主跑 runtime.close() 后断开 IPC），只等它自己
 * 退出。限时内不退、或退出码非 0 就抛错；超时那一下的 SIGKILL 只是清场不留孤儿进程，
 * 抛出的错照样把这次关闭判成「不是正常退出」。
 */
async function stopHostChild(child: ChildProcess): Promise<void> {
  if (hasExited(child)) {
    throw new Error(
      `resident runtime host exited before normal close (${String(child.exitCode)}/${String(child.signalCode)})`,
    );
  }
  const exited = waitForExit(child);
  try {
    await callHost(child, "stop", {});
  } catch (error) {
    await killHostChild(child);
    throw new Error(`resident runtime host normal close failed: ${describeError(error)}`);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), STOP_TIMEOUT_MS);
  });
  const outcome = await Promise.race([exited, timedOut]);
  clearTimeout(timer);
  if (outcome === null) {
    await killHostChild(child);
    throw new Error(
      `resident runtime host did not exit by itself within ${STOP_TIMEOUT_MS}ms after normal close`,
    );
  }
  if (outcome.code !== 0 || outcome.signal !== null) {
    throw new Error(
      `resident runtime host exited ${String(outcome.code)}/${String(outcome.signal)} after normal close`,
    );
  }
}

function callHost<T>(
  child: ChildProcess,
  op: string,
  payload: Record<string, unknown>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    requestSequence += 1;
    const requestId = `rr-request-${requestSequence}`;
    const timer = setTimeout(
      () => cleanup(new Error(`resident runtime host request timed out: ${op} (${requestId})`)),
      REQUEST_TIMEOUT_MS,
    );
    const onMessage = (message: HostReply): void => {
      if (message.requestId !== requestId) return;
      if (message.ok === true) {
        cleanupDone();
        resolve(message.value as T);
      } else {
        cleanup(new Error(message.error?.message ?? `host op failed: ${op}`));
      }
    };
    const onExit = (): void => {
      cleanup(new Error(`resident runtime host exited before answering ${op}`));
    };
    const cleanupDone = (): void => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    const cleanup = (error: Error): void => {
      cleanupDone();
      reject(error);
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.send({ op, requestId, ...payload }, (error) => {
      if (error === null) return;
      cleanup(error);
    });
  });
}

function waitForReady(child: ChildProcess, dataDir: string): Promise<HostDescriptor> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(
      () => cleanup(new Error(`resident runtime host startup timed out: ${stderr}`)),
      READY_TIMEOUT_MS,
    );
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const onMessage = (message: HostReply): void => {
      if (message.type !== "ready") return;
      if (typeof message.pid !== "number" || typeof message.bootId !== "string") return;
      cleanupDone();
      resolve({ pid: message.pid, bootId: message.bootId, dataDir });
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup(
        new Error(
          `resident runtime host exited ${String(code)}/${String(signal)} before ready: ${stderr}`,
        ),
      );
    };
    function cleanupDone(): void {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
    }
    function cleanup(error: Error): void {
      cleanupDone();
      reject(error);
    }
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

export function createResidentRuntimeDriver(): ResidentRuntimeDriver {
  return new ResidentRuntimeProductionDriver();
}
