/**
 * RT-01～RT-09 **判卷自身**的回归测试。
 *
 * 为什么要测判卷：判卷没被测过，等于判卷没被验过。#200 审读第 1 条就是这么漏的——
 * 原七盏灯共用一个住户、`reset()` 从没被调用，正确实现会被判红，而判卷自己全绿，
 * 谁也看不出来。这个文件用一份**内存合成驱动**做两件事：
 *
 * 1. 正对照：合规实现跑九盏全绿，连跑（模拟 runner 的循环）也全绿。
 * 2. 反对照：逐条改坏，断言**预期的那一盏**真的变红。
 *
 * 合成驱动不碰真实持久目录（落盘清单是内存数组 + `os.tmpdir()` 下的临时夹具），
 * 也不需要任何密钥（AGENTS.md：不许引入需要密钥才能跑通的代码路径）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { residentRuntimeChecks } from "../acceptance/resident-runtime-checks.ts";
import type {
  BootPackView,
  BreathTrigger,
  BreatheOutcome,
  ChannelRoute,
  ChannelSpec,
  ContendedTurn,
  HostDescriptor,
  LedgerAlignmentView,
  LetterItemView,
  LetterView,
  MemoryEntryView,
  ModelHistoryMessageView,
  ModelRequestView,
  PauseRecordFault,
  ProvisionedChannel,
  ResidentRuntimeCheckResult,
  ResidentRuntimeDriver,
  Result,
  SecretHit,
  SecretScanReport,
  StreamEventView,
  StreamFileInventory,
  StreamSnapshot,
  TuiFrame,
  TuiStep,
  TuiTranscript,
  TurnResult,
} from "../acceptance/resident-runtime-driver.ts";
import { cloneResidentRuntimeDriverBoundary } from "../acceptance/resident-runtime-driver.ts";

/** 一次 say 烧掉的 token 数。配合 1 与 1_000_000 两条触发线，换不换代算得清。 */
const TOKENS_PER_SAY = 500_000;

/**
 * 改坏开关。每个开关对应一条判据——开了它，预期的那一盏必须变红。
 * 少了这些开关，「判据被破坏会变红」这件事本身就没有证据。
 */
interface Faults {
  /** `reset()` 是空函数：灯之间的状态漏（#200 审读第 1 条）。 */
  resetDoesNothing: boolean;
  /** 落盘目录长出第二个一窗流文件（D9「一条生命线」）。 */
  secondStreamFile: boolean;
  /** 重启假装换了进程：pid / bootId 复用。 */
  restartReusesIdentity: boolean;
  /** 重启换了落盘目录：读回的就不是同一份底。 */
  restartChangesDataDir: boolean;
  /** 重启时悄悄改写一条旧事件（改史）。 */
  restartMutatesStream: boolean;
  /** 「没配凭证」与「凭证失效」塌成同一个码。 */
  collapseCredentialCodes: boolean;
  /** 失败时 `remedy` 为空（静默失败，不给可操作提示）。 */
  emptyRemedy: boolean;
  /** 失败的 say 也落账（失败伪造回复）。 */
  failedSayStillRecords: boolean;
  /** 窗开工后还能给自己改线（D8「给自己续命」）。 */
  windowCanRetune: boolean;
  /** 主人改线当刻生效，而不是从下一代生效。 */
  ownerRetuneAppliesImmediately: boolean;
  /** say 根本不看触发线，永不换代。 */
  thresholdNotEnforced: boolean;
  /** `/compact` 不换代：这就是自动 compact。 */
  compactDoesNotRotate: boolean;
  /** 换气把 windowId 换了。 */
  breatheChangesWindow: boolean;
  /** 换气改写旧流水（改史，不是长新枝）。 */
  breatheRewritesStream: boolean;
  /** 交接信签名用错代际（冒署）。 */
  letterAuthorWrongGen: boolean;
  /** 交接信缺标题（D8 补记四）。 */
  letterNoTitle: boolean;
  /** 各代交接信内容完全相同（写死模板）——**不该**判红，是回归钉。 */
  lettersShareTemplate: boolean;
  /** 启动包注入的信是转抄不是原件。 */
  bootpackLetterTranscribed: boolean;
  /** 猝死那代的原始流水自己进了继任者上下文（D8 三）。 */
  suddenDeathCarriesStream: boolean;
  /** 通道路由接反（D25 三）。 */
  routeSwapped: boolean;
  /** 换通道换了 residentId（D25 五）。 */
  switchChannelChangesResident: boolean;
  /** 换通道改了记忆集合（D25 五）。 */
  switchChannelMutatesMemory: boolean;
  /** 换通道改写了一窗流旧条目。 */
  switchChannelRewritesStream: boolean;
  /** 流式回复只有 1 个增量（不是流式吐出）。 */
  singleStreamChunk: boolean;
  /** 画面长出会话列表（D9 / D11 四）。 */
  sessionListShown: boolean;
  /** 状态栏缺模型。 */
  statusMissingModel: boolean;
  /** 出错却静默（errorText 为 null）。 */
  silentFailure: boolean;
  /** `credentialRef` 就是密钥明文。 */
  credentialRefIsPlaintext: boolean;
  /** 扫描器恒返回空命中（正对照失效）。 */
  scannerAlwaysEmpty: boolean;
  /** 密钥明文漏进一窗流。 */
  secretLeaksIntoStream: boolean;
  /** 检索根里多一份 `buildBootPack` 定义（pi 扩展另起副本，#200 审读第 2 条假绿）。 */
  secondBootPackDefinition: boolean;
  /** 代际原点写成 0（现役栈是 1 起点）——#200 技术门第 1 条。 */
  generationZeroOrigin: boolean;
  /** 窗改线的锁在回合起之前就合上（比现役 turn-gate 严）——#200 技术门第 2 条。 */
  windowRefusesBeforeTurn: boolean;
  /** suddenDeath 是空操作：不换继任者——#200 技术门第 3 条。 */
  suddenDeathNoSuccessor: boolean;
  /** suddenDeath 把那代原始流水直接丢了，归档查不到——#200 技术门第 3 条正面。 */
  suddenDeathDropsArchive: boolean;
  /** RT-08：缺确认的回合直接回放成功，制造假绿。 */
  recoveryPendingFalseGreen: boolean;
  /** RT-08：恢复拒绝前仍调用模型。 */
  recoveryRetryCallsModel: boolean;
  /** RT-08：恢复拒绝仍追加正文。 */
  recoveryRetryWritesBody: boolean;
  /** RT-08：跨代孤立 user 被重新生成。 */
  recoveryCrossGenerationRegenerates: boolean;
  /** RT-08：写后失败不返回 runtime 自造的锚。 */
  recoveryDropsFailureAnchor: boolean;
  /** RT-09：正常退出也开新一代——现役行为：每次启动都按猝死。 */
  pauseAlwaysNewGeneration: boolean;
  /** RT-09：硬杀后不看暂停记录，照样接着上一代。 */
  resumeAfterHardKill: boolean;
  /** RT-09：损坏或身份对不上的暂停记录也照接。 */
  resumeOnTamperedRecord: boolean;
  /** RT-09：暂停记录接回后不作废，再硬杀还能接一次。 */
  pauseRecordReusable: boolean;
  /** RT-09：接回后把上一段流水又写进一窗流一遍。 */
  resumeDuplicatesStream: boolean;
  /** RT-09：接回同一代，模型请求却不带上一段。 */
  resumeDropsHistory: boolean;
  /** RT-09：接回时认证账按同一身份重新登记（baseline 挪到接回那一刻）。 */
  resumeReregistersLedger: boolean;
  /** RT-09：接回时开了一扇新窗，新窗的第 1 代冒充「同一代」。 */
  resumeChangesWindow: boolean;
  /** RT-09：正常退出时把账上还没交付的缺口直接确认掉。 */
  pauseAcksGap: boolean;
  /** RT-09：硬杀后开了新一代，却把上一代原始流水塞进模型请求（D8 三）。 */
  hardKillCarriesHistory: boolean;
  /** RT-09：两个宿主同时起，都接回了暂停那一代。 */
  raceBothResume: boolean;
  /** RT-09 夹具改坏：把「第二个宿主 ready 前就崩了」折成一句被拒的 say（PR #235 P1-1 假绿）。 */
  raceFoldsPreReadyCrash: boolean;
  /** RT-09：第二个宿主没起到 ready（如实报 not-ready）。 */
  raceLoserNotReady: boolean;
  /** RT-09：第二个宿主起来了，但 say 请求本身抛错（如实报 request-failed）。 */
  raceLoserRequestFailed: boolean;
  /** RT-09：两边报的 ready pid 是同一个进程。 */
  raceSamePid: boolean;
  /** RT-09：输的一边是 say 返回的失败，但不是 writer-unavailable。 */
  raceLoserNotWriterUnavailable: boolean;
  /** RT-09 夹具改坏：弄坏暂停记录时把那一代的归档也抹了。 */
  tamperDropsArchive: boolean;
  /** RT-09 观察口改坏：模型请求的历史恒为空（正对照失效）。 */
  requestHistoryAlwaysEmpty: boolean;
  /** RT-09 观察口改坏：确认位读数冻在第一次读到的样子（正对照失效）。 */
  alignmentObserverFrozen: boolean;
}

const NO_FAULTS: Faults = {
  resetDoesNothing: false,
  secondStreamFile: false,
  restartReusesIdentity: false,
  restartChangesDataDir: false,
  restartMutatesStream: false,
  collapseCredentialCodes: false,
  emptyRemedy: false,
  failedSayStillRecords: false,
  windowCanRetune: false,
  ownerRetuneAppliesImmediately: false,
  thresholdNotEnforced: false,
  compactDoesNotRotate: false,
  breatheChangesWindow: false,
  breatheRewritesStream: false,
  letterAuthorWrongGen: false,
  letterNoTitle: false,
  lettersShareTemplate: false,
  bootpackLetterTranscribed: false,
  suddenDeathCarriesStream: false,
  routeSwapped: false,
  switchChannelChangesResident: false,
  switchChannelMutatesMemory: false,
  switchChannelRewritesStream: false,
  singleStreamChunk: false,
  sessionListShown: false,
  statusMissingModel: false,
  silentFailure: false,
  credentialRefIsPlaintext: false,
  scannerAlwaysEmpty: false,
  secretLeaksIntoStream: false,
  secondBootPackDefinition: false,
  generationZeroOrigin: false,
  windowRefusesBeforeTurn: false,
  suddenDeathNoSuccessor: false,
  suddenDeathDropsArchive: false,
  recoveryPendingFalseGreen: false,
  recoveryRetryCallsModel: false,
  recoveryRetryWritesBody: false,
  recoveryCrossGenerationRegenerates: false,
  recoveryDropsFailureAnchor: false,
  pauseAlwaysNewGeneration: false,
  resumeAfterHardKill: false,
  resumeOnTamperedRecord: false,
  pauseRecordReusable: false,
  resumeDuplicatesStream: false,
  resumeDropsHistory: false,
  resumeReregistersLedger: false,
  resumeChangesWindow: false,
  pauseAcksGap: false,
  hardKillCarriesHistory: false,
  raceBothResume: false,
  raceFoldsPreReadyCrash: false,
  raceLoserNotReady: false,
  raceLoserRequestFailed: false,
  raceSamePid: false,
  raceLoserNotWriterUnavailable: false,
  tamperDropsArchive: false,
  requestHistoryAlwaysEmpty: false,
  alignmentObserverFrozen: false,
};

interface SynthCredential {
  readonly ref: string;
  readonly secret: string;
  active: boolean;
}

interface SynthResident {
  identity: string;
  events: StreamEventView[];
  memories: MemoryEntryView[];
  commitments: string[];
  letters: LetterView[];
  credential: SynthCredential | null;
  generation: number;
  /** 当代是否已经起过回合（起了之后窗才无权给自己改线，对齐现役 turn-gate）。 */
  turnStarted: boolean;
  /** 按代归档的原始流水：换代/猝死时把当代流水封存进来，供 archivedTranscript 按代查。 */
  archive: Map<number, StreamEventView[]>;
  windowId: string;
  windowOpen: boolean;
  /** 当前这一代生效的触发线（开工时定死）。 */
  threshold: number | null;
  /** 主人改的、从下一代生效的线。 */
  pendingThreshold: number | null;
  tokensSinceBreath: number;
  streamFile: string | null;
  channel: ChannelSpec | null;
  /** 换过几次通道（第二次起算「换通道」）。 */
  provisions: number;
  /** 换通道后对外冒充的住户标识（改坏用）。 */
  effectiveId: string | null;
  /** 每条事件落在哪一代：RT-09 按代算模型请求的历史与猝死归档。 */
  eventGenerations: Map<string, number>;
  /** 当前这一代是第几次启动里开的窗；null = 从没开过。 */
  activeBoot: number | null;
  /** 正常退出落下的「这一代暂停」；硬杀不落。 */
  pauseRecord: SynthPauseRecord | null;
  /** 本次启动里接回时流里已有几条（resumeDropsHistory 用它切掉上一段）。 */
  resumedAtEvent: number | null;
  /** resumeDuplicatesStream：接回后的第一回合落完再把上一段写一遍。 */
  duplicatePending: boolean;
  /** tamperDropsArchive：这位住户下次猝死时那代归档不留。 */
  archiveLost: boolean;
  /** 认证事实账账尾。 */
  ledgerSeq: number;
  /** 认证事实账上这扇窗的确认位。 */
  alignment: SynthAlignment | null;
}

interface SynthPauseRecord {
  readonly generation: number;
  readonly state: "valid" | Exclude<PauseRecordFault, "missing">;
}

interface SynthAlignment {
  windowId: string;
  generation: number;
  baselineSeq: number;
  ackedSeq: number;
}

interface SynthTurn {
  readonly text: string;
  readonly result: TurnResult;
  readonly userEventId: string;
  readonly assistantEventId: string;
  status: "complete" | "pending" | "orphan";
}

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

type ErrorCode = Extract<Result<never>, { readonly ok: false }>["error"]["code"];

function err<T>(
  code: ErrorCode,
  message: string,
  remedy: string,
  residentId: string,
  turnId?: string,
): Result<T> {
  return {
    ok: false,
    error: { code, message, remedy, residentId, ...(turnId === undefined ? {} : { turnId }) },
  };
}

class SyntheticDriver implements ResidentRuntimeDriver {
  readonly faults: Faults = { ...NO_FAULTS };

  #residents = new Map<string, SynthResident>();
  #files: string[] = [];
  #logs: string[] = [];
  #host: HostDescriptor = { pid: 4100, bootId: "boot-0", dataDir: "/synthetic/data" };
  #pid = 4100;
  #boots = 0;
  #eventSeq = 0;
  #letterSeq = 0;
  #turnSeq = 0;
  #modelCalls = 0;
  #turns = new Map<string, Map<string, SynthTurn>>();
  #confirmationFaults = new Set<string>();
  #fixtureRoot = mkdtempSync(join(tmpdir(), "mist-rt-synth-"));
  /** 宿主进程在不在跑：停着时调宿主方法会像真驱动一样把它拉起来。 */
  #hostRunning = true;
  /** 本次启动以来每位住户最近一次模型请求（RT-09 观察口）。 */
  #lastRequests = new Map<string, ModelRequestView>();
  /** alignmentObserverFrozen：第一次读到的确认位。 */
  #frozenAlignments = new Map<string, LedgerAlignmentView>();

  async reset(): Promise<void> {
    if (this.faults.resetDoesNothing) return;
    this.#residents.clear();
    this.#files = [];
    this.#logs = [];
    this.#eventSeq = 0;
    this.#letterSeq = 0;
    this.#turnSeq = 0;
    this.#modelCalls = 0;
    this.#turns.clear();
    this.#confirmationFaults.clear();
    this.#lastRequests.clear();
    this.#frozenAlignments.clear();
    this.#hostRunning = true;
  }

  async startHost(): Promise<HostDescriptor> {
    this.#boots += 1;
    this.#hostRunning = true;
    this.#lastRequests.clear();
    if (this.faults.restartReusesIdentity) {
      this.#host = { ...this.#host };
    } else {
      this.#pid += 1;
      this.#host = {
        pid: this.#pid,
        bootId: `boot-${this.#boots}`,
        dataDir: this.faults.restartChangesDataDir
          ? `/synthetic/data-${this.#boots}`
          : "/synthetic/data",
      };
    }
    return this.#host;
  }

  async killHost(): Promise<void> {
    // 硬杀不落暂停记录：这次启动里开着的窗全按猝死，下次启动开新一代。
    this.#hostRunning = false;
    if (this.faults.restartMutatesStream) {
      for (const resident of this.#residents.values()) {
        const first = resident.events[0];
        if (first !== undefined) {
          resident.events[0] = { ...first, text: `${first.text}~改史` };
        }
      }
    }
  }

  async stopHost(): Promise<void> {
    if (!this.#hostRunning) return;
    // 正常退出：这次启动里开着的每扇窗落一笔「这一代暂停」。
    for (const resident of this.#residents.values()) {
      if (resident.activeBoot !== this.#boots) continue;
      resident.pauseRecord = { generation: resident.generation, state: "valid" };
      if (this.faults.pauseAcksGap && resident.alignment !== null) {
        resident.alignment.ackedSeq = resident.ledgerSeq;
      }
    }
    this.#hostRunning = false;
  }

  async hostDescriptor(): Promise<HostDescriptor> {
    await this.#ensureRunning();
    return this.#host;
  }

  async provisionChannel(input: {
    residentId: string;
    channel: ChannelSpec;
    canarySecret: string;
  }): Promise<Result<ProvisionedChannel>> {
    const resident = this.#ensure(input.residentId);
    // 第二次 provision 就是「换通道」。D25 五要求换通道不换住户、不动记忆。
    resident.provisions += 1;
    if (resident.provisions > 1) {
      if (this.faults.switchChannelChangesResident) resident.effectiveId = `${input.residentId}-x`;
      if (this.faults.switchChannelMutatesMemory) {
        resident.memories.push({
          id: `mem-x${resident.memories.length}`,
          content: "换通道时被改的记忆",
          supersededBy: null,
        });
      }
    }
    const ref = this.faults.credentialRefIsPlaintext
      ? input.canarySecret
      : `cred://${input.residentId}/${input.channel.credentialKind}`;
    resident.credential = { ref, secret: input.canarySecret, active: true };
    resident.channel = input.channel;
    this.#logs.push(`provisioned ${input.residentId} via ${this.#adapterFor(input.channel)}`);
    if (this.faults.secretLeaksIntoStream) {
      this.#append(input.residentId, "user", `debug token ${input.canarySecret}`);
    }
    return ok({
      adapterId: this.#adapterFor(input.channel),
      credentialKind: input.channel.credentialKind,
      model: input.channel.model,
      credentialRef: ref,
    });
  }

  async revokeCredential(input: { residentId: string }): Promise<void> {
    const resident = this.#ensure(input.residentId);
    if (resident.credential !== null) resident.credential.active = false;
  }

  async resolveChannelRoute(input: { channel: ChannelSpec }): Promise<Result<ChannelRoute>> {
    return ok({
      adapterId: this.faults.routeSwapped
        ? this.#otherAdapterFor(input.channel)
        : this.#adapterFor(input.channel),
      credentialKind: input.channel.credentialKind,
      model: input.channel.model,
    });
  }

  async say(input: {
    residentId: string;
    text: string;
    turnId?: string;
  }): Promise<Result<TurnResult>> {
    await this.#ensureRunning();
    const resident = this.#ensure(input.residentId);
    const credential = resident.credential;
    if (credential === null) {
      if (this.faults.failedSayStillRecords) this.#append(input.residentId, "user", input.text);
      return err(
        this.faults.collapseCredentialCodes ? "credential-invalid" : "credential-missing",
        "这个住户还没有配模型通道",
        this.faults.emptyRemedy ? "" : "跑 npm run setup 配一条通道后再来",
        input.residentId,
      );
    }
    if (!credential.active) {
      if (this.faults.failedSayStillRecords) this.#append(input.residentId, "user", input.text);
      return err(
        this.faults.collapseCredentialCodes ? "credential-missing" : "credential-invalid",
        "凭证已失效",
        this.faults.emptyRemedy ? "" : "重新跑 npm run setup 换一条凭证",
        input.residentId,
      );
    }

    const turnId = input.turnId ?? `synth-turn-${input.residentId}-${++this.#turnSeq}`;
    const existing = this.#turns.get(input.residentId)?.get(turnId);
    if (existing !== undefined) {
      if (existing.text !== input.text) {
        return err(
          "turn-id-conflict",
          "turnId 已被另一条正文占用",
          "换一个 turnId，或带原文重试",
          input.residentId,
          turnId,
        );
      }
      if (existing.status === "complete") return ok(existing.result);
      if (this.faults.recoveryRetryCallsModel) this.#modelCalls += 1;
      if (this.faults.recoveryRetryWritesBody) {
        this.#append(input.residentId, "assistant", `错误恢复 ${input.text}`);
      }
      if (existing.status === "pending" && this.faults.recoveryPendingFalseGreen) {
        return ok(existing.result);
      }
      if (existing.status === "orphan" && this.faults.recoveryCrossGenerationRegenerates) {
        this.#modelCalls += 1;
        this.#append(input.residentId, "assistant", `跨代重生 ${input.text}`);
      }
      return err(
        "reconciliation-needed",
        "回合需要协调",
        "保留原锚，不再调用模型",
        input.residentId,
        turnId,
      );
    }

    this.#openWindow(resident);
    this.#recordRequest(resident, input.residentId, input.text);
    this.#modelCalls += 1;
    const userEvent = this.#append(input.residentId, "user", input.text);
    resident.tokensSinceBreath += TOKENS_PER_SAY;
    // 回合已起：从这一刻起窗无权给自己改线（对齐现役 turn-gate 的 beforeTurn 锁点）。
    resident.turnStarted = true;

    // 回复落在的那一代（换代发生在这句之后：D8 补记一，撞线回合先跑完，信在其后）。
    const generationOfReply = resident.generation;

    const crossed =
      !this.faults.thresholdNotEnforced &&
      resident.threshold !== null &&
      resident.tokensSinceBreath >= resident.threshold;
    if (crossed) this.#breatheInPlace(resident, input.residentId);

    const reply = `回复 ${input.text}`;
    const assistantEvent = this.#append(input.residentId, "assistant", reply);
    if (this.faults.switchChannelRewritesStream && resident.events.length > 2) {
      const first = resident.events[0];
      if (first !== undefined) resident.events[0] = { ...first, text: `${first.text}~改史` };
    }
    // 回合交付完：认证账确认位前进到账尾（接回的那次激活也一样，只经真实交付前进）。
    if (resident.alignment !== null) resident.alignment.ackedSeq = resident.ledgerSeq;
    if (resident.duplicatePending) {
      resident.duplicatePending = false;
      const replayed = resident.events.slice(0, resident.resumedAtEvent ?? 0);
      for (const event of replayed) this.#append(input.residentId, event.kind, event.text);
    }

    const result: TurnResult = {
      residentId: resident.effectiveId ?? input.residentId,
      model: resident.channel?.model ?? "model-alpha",
      // 正确实现报「回复落在的那一代」；generationZeroOrigin 故障把它整体减 1，
      // 模拟一个 0 起点/差一错的驱动——判卷的 1 起点断言应当把它判红。
      generation: this.faults.generationZeroOrigin ? generationOfReply - 1 : generationOfReply,
      reply,
      streamed: true,
      turnId,
    };
    const turns = this.#turns.get(input.residentId) ?? new Map<string, SynthTurn>();
    this.#turns.set(input.residentId, turns);
    turns.set(turnId, {
      text: input.text,
      result,
      userEventId: userEvent.eventId,
      assistantEventId: assistantEvent.eventId,
      status: this.#confirmationFaults.has(input.residentId) ? "pending" : "complete",
    });
    if (!this.#confirmationFaults.has(input.residentId)) {
      for (const turn of turns.values()) {
        if (turn.status === "pending") turn.status = "complete";
      }
    }
    if (this.#confirmationFaults.has(input.residentId)) {
      return err(
        "writer-unavailable",
        "确认记录写入失败",
        "修好确认存储后带原锚重试",
        input.residentId,
        this.faults.recoveryDropsFailureAnchor ? undefined : turnId,
      );
    }
    return ok(result);
  }

  async modelInvocationCount(): Promise<number> {
    return this.#modelCalls;
  }

  async armTurnConfirmationWriteFault(input: { residentId: string }): Promise<void> {
    this.#confirmationFaults.add(input.residentId);
  }

  async repairTurnConfirmationWriteFault(input: { residentId: string }): Promise<void> {
    this.#confirmationFaults.delete(input.residentId);
  }

  async crashAfterUserWrite(input: { residentId: string; turnId: string }): Promise<void> {
    const turn = this.#turns.get(input.residentId)?.get(input.turnId);
    if (turn === undefined || turn.status !== "complete") {
      throw new Error(`cannot create orphan fixture for ${input.residentId}/${input.turnId}`);
    }
    const resident = this.#ensure(input.residentId);
    resident.events = resident.events.filter((event) => event.eventId !== turn.assistantEventId);
    turn.status = "orphan";
    await this.killHost();
    await this.startHost();
  }

  async lastModelRequest(input: { residentId: string }): Promise<ModelRequestView | null> {
    await this.#ensureRunning();
    return this.#lastRequests.get(input.residentId) ?? null;
  }

  async appendLedgerFact(input: {
    residentId: string;
    body: string;
  }): Promise<Result<{ seq: number }>> {
    await this.#ensureRunning();
    const resident = this.#ensure(input.residentId);
    resident.ledgerSeq += 1;
    return ok({ seq: resident.ledgerSeq });
  }

  async ledgerAlignment(input: { residentId: string }): Promise<Result<LedgerAlignmentView>> {
    // 读的是落盘那份：宿主停着也读得到，不拉宿主。
    const resident = this.#residents.get(input.residentId);
    if (resident === undefined) {
      return err("resident-not-found", "这位住户没有认证事实账", "先入住再读", input.residentId);
    }
    const view: LedgerAlignmentView = {
      residentId: input.residentId,
      latestSeq: resident.ledgerSeq,
      viewports: resident.alignment === null ? [] : [{ ...resident.alignment }],
    };
    if (!this.faults.alignmentObserverFrozen) return ok(view);
    const frozen = this.#frozenAlignments.get(input.residentId) ?? view;
    this.#frozenAlignments.set(input.residentId, frozen);
    return ok(frozen);
  }

  async tamperPauseRecord(input: { residentId: string; fault: PauseRecordFault }): Promise<void> {
    if (this.#hostRunning) throw new Error("tamperPauseRecord 只在宿主停着时用");
    const resident = this.#ensure(input.residentId);
    const record = resident.pauseRecord;
    if (record === null) throw new Error(`${input.residentId} 没有暂停记录可弄坏`);
    resident.pauseRecord = input.fault === "missing" ? null : { ...record, state: input.fault };
    if (this.faults.tamperDropsArchive) resident.archiveLost = true;
  }

  async raceHosts(input: {
    residentId: string;
    texts: readonly [string, string];
  }): Promise<readonly [ContendedTurn, ContendedTurn]> {
    if (this.#hostRunning) throw new Error("raceHosts 要求宿主先停");
    const resident = this.#ensure(input.residentId);
    const before = resident.pauseRecord;
    // 两个宿主顺序起、都 ready（各自的 pid），再同时说：先说的拿到住户锁，后说的被 say 自己
    // 以结构化 writer-unavailable 拒绝。
    const leftHost = await this.startHost();
    this.#pid += 1;
    const rightPid = this.#pid;
    const said = (pid: number, result: Result<TurnResult>): ContendedTurn => ({
      stage: "said",
      pid,
      readyPid: pid,
      result,
      failure: null,
    });
    const left = said(
      leftHost.pid,
      await this.say({ residentId: input.residentId, text: input.texts[0] }),
    );
    const refused = err<TurnResult>(
      "writer-unavailable",
      "这位住户正在另一个宿主进程里打开",
      "先到那个进程里退出再来",
      input.residentId,
    );
    let right: ContendedTurn;
    if (this.faults.raceBothResume) {
      // 认领不原子：后起的那个宿主读到的还是认领前的盘面。
      resident.pauseRecord = before;
      this.#boots += 1;
      right = said(
        rightPid,
        await this.say({ residentId: input.residentId, text: input.texts[1] }),
      );
    } else if (this.faults.raceFoldsPreReadyCrash) {
      // 驱动把「ready 前就崩了」折成一句被拒的 say：没有 pid、没有 ready。
      right = { stage: "said", pid: null, readyPid: null, result: refused, failure: null };
    } else if (this.faults.raceLoserNotReady) {
      right = {
        stage: "not-ready",
        pid: rightPid,
        readyPid: null,
        result: null,
        failure: "宿主没起来：exited 1/null before ready（rename facts.json.tmp ENOENT）",
      };
    } else if (this.faults.raceLoserRequestFailed) {
      right = {
        stage: "request-failed",
        pid: rightPid,
        readyPid: rightPid,
        result: null,
        failure: "宿主请求失败：resident runtime host exited before answering say",
      };
    } else if (this.faults.raceSamePid) {
      right = said(leftHost.pid, refused);
    } else if (this.faults.raceLoserNotWriterUnavailable) {
      right = said(
        rightPid,
        err("channel-unavailable", "窗开工失败", "检查窗账后重试", input.residentId),
      );
    } else {
      right = said(rightPid, refused);
    }
    await this.stopHost();
    return [left, right];
  }

  async readStream(input: { residentId: string }): Promise<Result<StreamSnapshot>> {
    const resident = this.#residents.get(input.residentId);
    if (resident === undefined || resident.events.length === 0) {
      return err("stream-not-found", "这条一窗流不存在", "先说一句话落账", input.residentId);
    }
    return ok({ residentId: input.residentId, events: [...resident.events] });
  }

  async streamFiles(): Promise<Result<StreamFileInventory>> {
    return ok({ files: [...this.#files] });
  }

  async bootPack(input: { residentId: string }): Promise<Result<BootPackView>> {
    const resident = this.#ensure(input.residentId);
    const latest = resident.letters[resident.letters.length - 1] ?? null;
    return ok({
      residentId: input.residentId,
      identity: resident.identity,
      commitments: [...resident.commitments],
      memories: [...resident.memories],
      letter: latest === null ? null : this.#bootpackLetter(latest),
    });
  }

  async letterTimeline(input: { residentId: string }): Promise<
    Result<{ residentId: string; letters: LetterView[] }>
  > {
    const resident = this.#ensure(input.residentId);
    return ok({
      residentId: input.residentId,
      letters: resident.letters.map((letter) => this.#copyLetter(letter)),
    });
  }

  async setBreathThreshold(input: {
    residentId: string;
    windowId: string;
    generation: number;
    thresholdTokens: number;
    authority: "window" | "owner";
  }): Promise<Result<void>> {
    const resident = this.#ensure(input.residentId);
    // windowRefusesBeforeTurn 故障：把锁点提前到「回合起之前」——开工阶段窗自己配线就被拒。
    // 这比现役 turn-gate 严（现役只在 beforeTurn 之后锁），会误伤正确实现（#200 技术门第 2 条）。
    if (
      input.authority === "window" &&
      this.faults.windowRefusesBeforeTurn &&
      !resident.turnStarted
    ) {
      return err(
        "breath-refused",
        "（故障）回合还没起就拒了窗改线",
        "这是比现役 turn-gate 更严的错误行为",
        input.residentId,
      );
    }
    if (!resident.windowOpen) {
      resident.windowOpen = true;
      resident.windowId = input.windowId;
      resident.threshold = input.thresholdTokens;
      resident.pendingThreshold = null;
      return ok(undefined);
    }
    if (input.authority === "window") {
      // 现役 turn-gate：窗无权给自己续命的锁在**回合起了之后**才合上（beforeTurn / MV-D02：
      // 开工 configure 成功、先 say、再改才 CONFIG_INVALID）。所以回合未起时窗改线应当被
      // 接受（当代生效）；回合已起才 fail-closed。
      //   windowRefusesBeforeTurn 故障：回合未起就拒——比现役严，判卷该判红。
      //   windowCanRetune 故障：回合已起还放行——D8 给自己续命，判卷该判红。
      const turnStarted = resident.turnStarted;
      const shouldRefuse = this.faults.windowRefusesBeforeTurn ? true : turnStarted;
      if (shouldRefuse && !this.faults.windowCanRetune) {
        return err(
          "breath-refused",
          "运行中的窗无权改自己的触发线",
          "要改成员配置请从主人侧发起，改动从下一代生效",
          input.residentId,
        );
      }
      // 回合未起、窗自己改线：当代即可生效（不是续命，是开工阶段的配置）。
      resident.threshold = input.thresholdTokens;
      resident.pendingThreshold = null;
      return ok(undefined);
    }
    // authority === "owner"：主人改成员配置，从下一代生效（除非故障当刻生效）。
    if (this.faults.ownerRetuneAppliesImmediately) {
      resident.threshold = input.thresholdTokens;
    } else {
      resident.pendingThreshold = input.thresholdTokens;
    }
    return ok(undefined);
  }

  async breathe(input: {
    residentId: string;
    via: BreathTrigger;
  }): Promise<Result<BreatheOutcome>> {
    const resident = this.#ensure(input.residentId);
    if (input.via === "compact" && this.faults.compactDoesNotRotate) {
      // 「自动 compact」的形状：压了正文，但没换代。
      resident.events = resident.events.slice(-1);
      return ok({
        fromGeneration: resident.generation,
        toGeneration: resident.generation,
        windowId: resident.windowId,
        letter: this.#copyLetter(this.#sealFor(resident, input.residentId)),
      });
    }
    const outcome = this.#breatheInPlace(resident, input.residentId);
    return ok(outcome);
  }

  async suddenDeath(input: { residentId: string }): Promise<void> {
    const resident = this.#ensure(input.residentId);
    const dead = resident.generation;
    // 猝死那代没来得及写信，但原始流水不许无声消失：封存进归档，按代可查（D8 三正面）。
    // suddenDeathDropsArchive 故障把这一步跳过——判卷的归档可查断言应当把它判红。
    if (!this.faults.suddenDeathDropsArchive) {
      resident.archive.set(
        dead,
        resident.events.map((event) => ({ ...event })),
      );
    }
    // 故障：把猝死那代的原始流水塞进继任者的记忆（D8 三反面，判卷该判红）。
    if (this.faults.suddenDeathCarriesStream) {
      resident.memories.push({
        id: `mem-${resident.memories.length}`,
        content: resident.events.map((event) => event.text).join(" "),
        supersededBy: null,
      });
    }
    // 真的换继任者：代际 +1、当代流水清空（原始流水不自动进继任者上下文）。
    // suddenDeathNoSuccessor 故障跳过换代——判卷的「继任者代际必须更高」应当把它判红。
    if (!this.faults.suddenDeathNoSuccessor) {
      resident.generation = dead + 1;
      resident.turnStarted = false;
      resident.tokensSinceBreath = 0;
      resident.events = [];
      this.#registerAlignment(resident);
    }
  }

  async archivedTranscript(input: {
    residentId: string;
    generation: number;
  }): Promise<Result<StreamSnapshot>> {
    await this.#ensureRunning();
    const resident = this.#ensure(input.residentId);
    const archived = resident.archive.get(input.generation);
    if (archived === undefined) {
      // 归档里查不到这代流水，用 stream-not-found（契约里「这条流不存在，区别于流是空的」），
      // fail-closed，不拿空快照冒充「这代没有流水」。
      return err(
        "stream-not-found",
        `第 ${input.generation} 代没有归档流水`,
        "只有换过代或猝死封存过的代际才查得到",
        input.residentId,
      );
    }
    return ok({
      residentId: input.residentId,
      events: archived.map((event) => ({ ...event })),
    });
  }

  async tuiTranscript(input: {
    residentId: string;
    channel: ChannelSpec;
    script: readonly TuiStep[];
  }): Promise<Result<TuiTranscript>> {
    const frames: TuiFrame[] = [];
    let text = "";
    let atMs = 0;
    let broken = false;
    let errorText: string | null = null;
    const chunks: string[] = [];

    for (const step of input.script) {
      if (step.kind === "breakChannel") {
        broken = true;
        continue;
      }
      if (step.kind === "retry") {
        // 恢复回归使用真实控制器；这个灯色对照只实现 RT-05 的原脚本。
        return err(
          "tui-unavailable",
          "对照驱动不支持恢复脚本",
          "使用真实 resident runtime 驱动",
          input.residentId,
        );
      }
      const said = await this.say({
        residentId: input.residentId,
        text: step.text,
      });
      if (!said.ok) {
        errorText = this.faults.silentFailure ? null : `${said.error.code}：${said.error.remedy}`;
        text += `\n[错误] ${errorText ?? ""}`;
        atMs += 10;
        frames.push({ atMs, text, sessionCount: this.faults.sessionListShown ? 2 : 1 });
        continue;
      }
      if (broken) {
        errorText = this.faults.silentFailure ? null : "channel-unavailable：通道坏了";
        text += `\n[错误] ${errorText ?? ""}`;
        atMs += 10;
        frames.push({ atMs, text, sessionCount: this.faults.sessionListShown ? 2 : 1 });
        continue;
      }
      text += `\n你：${step.text}\n住户：${said.value.reply}`;
      atMs += 10;
      frames.push({ atMs, text, sessionCount: this.faults.sessionListShown ? 2 : 1 });
      if (this.faults.singleStreamChunk) {
        chunks.push(said.value.reply);
      } else {
        const half = Math.ceil(said.value.reply.length / 2);
        chunks.push(said.value.reply.slice(0, half), said.value.reply.slice(half));
      }
    }

    return ok({
      frames,
      statusResidentId: input.residentId,
      statusModel: this.faults.statusMissingModel ? null : input.channel.model,
      streamChunks: chunks,
      errorText,
    });
  }

  async auditRoots(): Promise<readonly string[]> {
    if (!this.faults.secondBootPackDefinition) return [];
    const root = join(this.#fixtureRoot, `ext-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "extension.ts"),
      "export function buildBootPack(store, residentId) {\n  return residentId;\n}\n",
      "utf8",
    );
    return [root];
  }

  async secretScan(input: {
    residentId: string;
    needle: string;
  }): Promise<Result<SecretScanReport>> {
    if (this.faults.scannerAlwaysEmpty) return ok({ hits: [] });
    const resident = this.#ensure(input.residentId);
    const hits: SecretHit[] = [];
    const surfaces: { surface: string; bodies: readonly string[] }[] = [
      { surface: "log", bodies: this.#logs },
      { surface: "stream", bodies: resident.events.map((event) => event.text) },
      {
        surface: "letter",
        bodies: resident.letters.flatMap((letter) => [
          letter.title,
          ...letter.state.map((item) => item.body),
          ...letter.intent.map((item) => item.body),
        ]),
      },
      {
        surface: "bootpack",
        bodies: [
          resident.identity,
          ...resident.commitments,
          ...resident.memories.map((memory) => memory.content),
        ],
      },
    ];
    for (const { surface, bodies } of surfaces) {
      for (const body of bodies) {
        if (body.includes(input.needle)) hits.push({ surface, needle: input.needle });
      }
    }
    return ok({ hits });
  }

  dispose(): void {
    rmSync(this.#fixtureRoot, { recursive: true, force: true });
  }

  // —— 内部 ——

  #ensure(residentId: string): SynthResident {
    const existing = this.#residents.get(residentId);
    if (existing !== undefined) return existing;
    const created: SynthResident = {
      identity: `住户 ${residentId}`,
      events: [],
      memories: [],
      commitments: [],
      letters: [],
      credential: null,
      // 代际 1 起点：对齐现役 SessionRegistry.open（第一代 (last ?? 0)+1）。
      generation: 1,
      turnStarted: false,
      archive: new Map(),
      windowId: `window-${residentId}`,
      windowOpen: false,
      threshold: null,
      pendingThreshold: null,
      tokensSinceBreath: 0,
      streamFile: `${residentId}.stream.json`,
      channel: null,
      provisions: 0,
      effectiveId: null,
      eventGenerations: new Map(),
      activeBoot: null,
      pauseRecord: null,
      resumedAtEvent: null,
      duplicatePending: false,
      archiveLost: false,
      ledgerSeq: 0,
      alignment: null,
    };
    this.#residents.set(residentId, created);
    return created;
  }

  /** 像真驱动一样：宿主停着时第一次用到宿主方法就把它拉起来。 */
  async #ensureRunning(): Promise<void> {
    if (!this.#hostRunning) await this.startHost();
  }

  /**
   * 本次启动里第一次用到这扇窗时定：接回暂停那代，还是按猝死开新一代（#234 裁定 A）。
   * 合规路径：暂停记录在、完好、对得上这一代 → 接回同一代，记录随即作废；否则猝死。
   */
  #openWindow(resident: SynthResident): void {
    if (resident.activeBoot === this.#boots) return;
    const firstOpen = resident.activeBoot === null;
    resident.activeBoot = this.#boots;
    if (firstOpen) {
      this.#registerAlignment(resident);
      return;
    }
    const record = resident.pauseRecord;
    if (!this.faults.pauseRecordReusable) resident.pauseRecord = null;
    const honoured =
      record !== null &&
      record.generation === resident.generation &&
      (record.state === "valid" || this.faults.resumeOnTamperedRecord);
    const resume =
      !this.faults.pauseAlwaysNewGeneration && (honoured || this.faults.resumeAfterHardKill);
    if (resume) {
      resident.resumedAtEvent = resident.events.length;
      resident.duplicatePending = this.faults.resumeDuplicatesStream;
      if (this.faults.resumeChangesWindow) {
        resident.windowId = `${resident.windowId}-reopened`;
        this.#registerAlignment(resident);
      } else if (this.faults.resumeReregistersLedger) {
        this.#registerAlignment(resident);
      }
      return;
    }
    // 猝死（D8 三）：上一代原始流水封存进归档、按代可查，开新一代。
    const dead = resident.generation;
    if (!resident.archiveLost) resident.archive.set(dead, this.#eventsOfGeneration(resident, dead));
    resident.generation = dead + 1;
    resident.turnStarted = false;
    resident.tokensSinceBreath = 0;
    resident.resumedAtEvent = null;
    this.#registerAlignment(resident);
  }

  /** 开窗 / 换代时在认证账上登记确认位：baseline 与 acked 都从登记那一刻的账尾起。 */
  #registerAlignment(resident: SynthResident): void {
    resident.alignment = {
      windowId: resident.windowId,
      generation: resident.generation,
      baselineSeq: resident.ledgerSeq,
      ackedSeq: resident.ledgerSeq,
    };
  }

  #eventsOfGeneration(resident: SynthResident, generation: number): StreamEventView[] {
    return resident.events
      .filter((event) => resident.eventGenerations.get(event.eventId) === generation)
      .map((event) => ({ ...event }));
  }

  /** transport 实际收到的那份：本代此前的 user/assistant（改坏开关在这里起作用）。 */
  #recordRequest(resident: SynthResident, residentId: string, text: string): void {
    let events = this.#eventsOfGeneration(resident, resident.generation);
    if (this.faults.hardKillCarriesHistory) events = resident.events.map((event) => ({ ...event }));
    if (this.faults.resumeDropsHistory && resident.resumedAtEvent !== null) {
      const cut = new Set(resident.events.slice(0, resident.resumedAtEvent).map((e) => e.eventId));
      events = events.filter((event) => !cut.has(event.eventId));
    }
    const history: ModelHistoryMessageView[] = this.faults.requestHistoryAlwaysEmpty
      ? []
      : events.map((event) => ({ role: event.kind, text: event.text }));
    this.#lastRequests.set(residentId, { residentId, text, history });
  }

  #append(residentId: string, kind: "user" | "assistant", text: string): StreamEventView {
    const resident = this.#ensure(residentId);
    if (resident.streamFile !== null && !this.#files.includes(resident.streamFile)) {
      this.#files.push(resident.streamFile);
    }
    if (this.faults.secondStreamFile && !this.#files.includes(`${residentId}.dup.json`)) {
      this.#files.push(`${residentId}.dup.json`);
    }
    this.#eventSeq += 1;
    const event: StreamEventView = {
      eventId: `evt-${this.#eventSeq}`,
      streamSeq: this.#eventSeq,
      kind,
      text,
      payloadHash: `h-${this.#eventSeq}`,
    };
    resident.events.push(event);
    resident.eventGenerations.set(event.eventId, resident.generation);
    return event;
  }

  #sealFor(resident: SynthResident, residentId: string): LetterView {
    this.#letterSeq += 1;
    const outgoing = resident.generation;
    const stamp = this.faults.lettersShareTemplate ? "fixed" : `第 ${this.#letterSeq} 封`;
    const items = (): LetterItemView[] => [
      { tier: "commitment", body: `${stamp}：继续把这件事做完` },
      { tier: "fact", body: `${stamp}：手上停在这里` },
      { tier: "judgment", body: `${stamp}：下一步先看证据` },
    ];
    return {
      title: this.faults.letterNoTitle ? "" : `交接 ${stamp}`,
      author: `${residentId}#${this.faults.letterAuthorWrongGen ? outgoing + 1 : outgoing}`,
      writtenAt: new Date(2026, 8, 24, 12, this.#letterSeq).toISOString(),
      state: items(),
      intent: items(),
    };
  }

  /** 忠实副本：只做深拷贝，不改内容。 */
  #copyLetter(letter: LetterView): LetterView {
    return {
      ...letter,
      state: letter.state.map((item) => ({ ...item })),
      intent: letter.intent.map((item) => ({ ...item })),
    };
  }

  /**
   * 启动包注入的那封。改坏开关**只**作用在这一处——「原件 vs 转抄」才比得出差异。
   * 时间线与换气回执都走忠实副本，否则两边一起转抄，差异就消失了。
   */
  #bootpackLetter(letter: LetterView): LetterView {
    if (!this.faults.bootpackLetterTranscribed) return this.#copyLetter(letter);
    return {
      ...letter,
      title: `${letter.title}（转抄）`,
      state: letter.state.map((item) => ({ ...item, body: `${item.body}（转抄）` })),
      intent: letter.intent.map((item) => ({ ...item, body: `${item.body}（转抄）` })),
    };
  }

  #breatheInPlace(resident: SynthResident, residentId: string): BreatheOutcome {
    const from = resident.generation;
    const letter = this.#sealFor(resident, residentId);
    resident.letters.push(letter);
    // 封存这一代的原始流水进归档（换代不丢史），再开新一代。
    resident.archive.set(
      from,
      resident.events.map((event) => ({ ...event })),
    );
    resident.generation = from + 1;
    resident.turnStarted = false;
    resident.tokensSinceBreath = 0;
    this.#registerAlignment(resident);
    // 主人改的线从这一代开始生效。
    if (resident.pendingThreshold !== null) {
      resident.threshold = resident.pendingThreshold;
      resident.pendingThreshold = null;
    }
    if (this.faults.breatheChangesWindow) resident.windowId = `${resident.windowId}-x`;
    if (this.faults.breatheRewritesStream) {
      const first = resident.events[0];
      if (first !== undefined) resident.events[0] = { ...first, text: `${first.text}~改史` };
    }
    return {
      fromGeneration: from,
      toGeneration: resident.generation,
      windowId: this.faults.breatheChangesWindow ? resident.windowId : resident.windowId,
      letter: this.#copyLetter(letter),
    };
  }

  #adapterFor(channel: ChannelSpec): "pi-claude-bridge" | "pi-ai" {
    return channel.claudeSubscription ? "pi-claude-bridge" : "pi-ai";
  }

  #otherAdapterFor(channel: ChannelSpec): "pi-claude-bridge" | "pi-ai" {
    return channel.claudeSubscription ? "pi-ai" : "pi-claude-bridge";
  }
}

// —— 测试侧工具 ——

interface LampOutcome {
  readonly id: string;
  readonly passed: boolean;
  readonly detail: string;
}

/** 模拟 runner 的循环：每盏灯前 `reset()`，灯之间不共享住户状态。 */
async function runAllLamps(raw: ResidentRuntimeDriver): Promise<LampOutcome[]> {
  const driver = cloneResidentRuntimeDriverBoundary(raw);
  const outcomes: LampOutcome[] = [];
  for (const check of residentRuntimeChecks) {
    await driver.reset();
    // 判卷断言失败是**抛**出来的，真 runner 用 try/catch 收敛成红灯。这里照做——
    // 不接住的话，一盏灯抛错会把整轮跑挂掉，改坏对照就无从谈起。
    try {
      const result: ResidentRuntimeCheckResult = await check.run(driver);
      outcomes.push({ id: check.id, passed: result.passed, detail: result.detail });
    } catch (error) {
      outcomes.push({
        id: check.id,
        passed: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return outcomes;
}

function lampById(outcomes: readonly LampOutcome[], id: string): LampOutcome {
  const found = outcomes.find((outcome) => outcome.id === id);
  if (found === undefined) throw new Error(`没有 ${id} 这盏灯`);
  return found;
}

let driver: SyntheticDriver;

beforeEach(() => {
  driver = new SyntheticDriver();
});

afterEach(() => {
  driver.dispose();
});

describe("判卷正对照：合规实现九盏全绿", () => {
  it("连跑九盏全绿（模拟 runner：每盏灯前 reset）", async () => {
    const outcomes = await runAllLamps(driver);
    const red = outcomes.filter((outcome) => !outcome.passed);
    expect(red.map((outcome) => `${outcome.id}：${outcome.detail}`)).toEqual([]);
    expect(outcomes).toHaveLength(9);
  });

  it("每盏灯单独跑也全绿", async () => {
    for (const check of residentRuntimeChecks) {
      await driver.reset();
      const result = await check.run(cloneResidentRuntimeDriverBoundary(driver));
      expect(result.passed, `${check.id}：${result.detail}`).toBe(true);
    }
  });
});

describe("判卷反对照：改坏必须变红", () => {
  // —— #200 审读点名的三条阻塞，各钉一个方向 ——

  it("reset() 不清状态 → RT-02 红（#200 审读第 1 条）", async () => {
    driver.faults.resetDoesNothing = true;
    const outcomes = await runAllLamps(driver);
    expect(lampById(outcomes, "RT-02").passed).toBe(false);
  });

  it("检索根里多一份 buildBootPack 定义 → RT-07 红（#200 审读第 2 条假绿）", async () => {
    driver.faults.secondBootPackDefinition = true;
    const outcomes = await runAllLamps(driver);
    const lamp = lampById(outcomes, "RT-07");
    expect(lamp.passed).toBe(false);
    expect(lamp.detail).toContain("buildBootPack");
  });

  it("各代交接信内容完全相同（写死模板）→ RT-03 仍绿（#200 审读第 3 条的回归钉）", async () => {
    driver.faults.lettersShareTemplate = true;
    const outcomes = await runAllLamps(driver);
    const lamp = lampById(outcomes, "RT-03");
    expect(lamp.passed, lamp.detail).toBe(true);
  });

  it("各代交接信内容各不相同 → RT-03 仍绿（D8「当刻亲笔」）", async () => {
    const outcomes = await runAllLamps(driver);
    expect(lampById(outcomes, "RT-03").passed).toBe(true);
  });

  // —— RT-01 ——

  it("两种失败码塌成同一个 → RT-01 红", async () => {
    driver.faults.collapseCredentialCodes = true;
    expect(lampById(await runAllLamps(driver), "RT-01").passed).toBe(false);
  });

  it("失败时 remedy 为空 → RT-01 红（静默失败）", async () => {
    driver.faults.emptyRemedy = true;
    expect(lampById(await runAllLamps(driver), "RT-01").passed).toBe(false);
  });

  it("失败的 say 也落账 → RT-01 红（失败伪造回复）", async () => {
    driver.faults.failedSayStillRecords = true;
    expect(lampById(await runAllLamps(driver), "RT-01").passed).toBe(false);
  });

  // —— RT-02 ——

  it("落盘长出第二个一窗流文件 → RT-02 红（长了第二条会话）", async () => {
    driver.faults.secondStreamFile = true;
    expect(lampById(await runAllLamps(driver), "RT-02").passed).toBe(false);
  });

  it("重启复用 pid / bootId → RT-02 红（单进程假装重启）", async () => {
    driver.faults.restartReusesIdentity = true;
    expect(lampById(await runAllLamps(driver), "RT-02").passed).toBe(false);
  });

  it("重启换了落盘目录 → RT-02 红", async () => {
    driver.faults.restartChangesDataDir = true;
    expect(lampById(await runAllLamps(driver), "RT-02").passed).toBe(false);
  });

  it("重启时改写旧事件 → RT-02 红（杀进程不许动流）", async () => {
    driver.faults.restartMutatesStream = true;
    expect(lampById(await runAllLamps(driver), "RT-02").passed).toBe(false);
  });

  // —— RT-03 ——

  it("回合已起后窗还能给自己改线 → RT-03 红（D8 给自己续命）", async () => {
    driver.faults.windowCanRetune = true;
    expect(lampById(await runAllLamps(driver), "RT-03").passed).toBe(false);
  });

  // —— #200 技术门（复审 ca2ec60）三条 oracle 洞，各钉一个方向 ——

  it("代际写成 0 起点 / 差一 → RT-03 红（#200 技术门第 1 条）", async () => {
    driver.faults.generationZeroOrigin = true;
    const lamp = lampById(await runAllLamps(driver), "RT-03");
    expect(lamp.passed, lamp.detail).toBe(false);
  });

  it("窗改线的锁在回合起之前就合上 → RT-03 红（#200 技术门第 2 条：比现役 turn-gate 严，误伤正确实现）", async () => {
    driver.faults.windowRefusesBeforeTurn = true;
    const lamp = lampById(await runAllLamps(driver), "RT-03");
    expect(lamp.passed, lamp.detail).toBe(false);
  });

  it("suddenDeath 是空操作、不换继任者 → RT-03 红（#200 技术门第 3 条）", async () => {
    driver.faults.suddenDeathNoSuccessor = true;
    const lamp = lampById(await runAllLamps(driver), "RT-03");
    expect(lamp.passed, lamp.detail).toBe(false);
  });

  it("suddenDeath 把那代原始流水直接丢了、归档查不到 → RT-03 红（#200 技术门第 3 条正面：丢史）", async () => {
    driver.faults.suddenDeathDropsArchive = true;
    const lamp = lampById(await runAllLamps(driver), "RT-03");
    expect(lamp.passed, lamp.detail).toBe(false);
  });

  it("主人改线当刻生效 → RT-03 红（应当从下一代生效）", async () => {
    driver.faults.ownerRetuneAppliesImmediately = true;
    expect(lampById(await runAllLamps(driver), "RT-03").passed).toBe(false);
  });

  it("say 不看触发线、永不换代 → RT-03 红", async () => {
    driver.faults.thresholdNotEnforced = true;
    expect(lampById(await runAllLamps(driver), "RT-03").passed).toBe(false);
  });

  it("/compact 不换代 → RT-03 红（这就是自动 compact）", async () => {
    driver.faults.compactDoesNotRotate = true;
    expect(lampById(await runAllLamps(driver), "RT-03").passed).toBe(false);
  });

  it("换气把 windowId 换了 → RT-03 红", async () => {
    driver.faults.breatheChangesWindow = true;
    expect(lampById(await runAllLamps(driver), "RT-03").passed).toBe(false);
  });

  it("换气改写旧流水 → RT-03 红（改史不是长新枝）", async () => {
    driver.faults.breatheRewritesStream = true;
    expect(lampById(await runAllLamps(driver), "RT-03").passed).toBe(false);
  });

  it("交接信签名用错代际 → RT-03 红（冒署）", async () => {
    driver.faults.letterAuthorWrongGen = true;
    expect(lampById(await runAllLamps(driver), "RT-03").passed).toBe(false);
  });

  it("交接信缺标题 → RT-03 红（D8 补记四）", async () => {
    driver.faults.letterNoTitle = true;
    expect(lampById(await runAllLamps(driver), "RT-03").passed).toBe(false);
  });

  it("启动包注入的是转抄不是原件 → RT-03 红", async () => {
    driver.faults.bootpackLetterTranscribed = true;
    expect(lampById(await runAllLamps(driver), "RT-03").passed).toBe(false);
  });

  it("猝死那代的原始流水进了继任者上下文 → RT-03 红（D8 三）", async () => {
    driver.faults.suddenDeathCarriesStream = true;
    expect(lampById(await runAllLamps(driver), "RT-03").passed).toBe(false);
  });

  // —— RT-04 ——

  it("通道路由接反 → RT-04 红（D25 三）", async () => {
    driver.faults.routeSwapped = true;
    expect(lampById(await runAllLamps(driver), "RT-04").passed).toBe(false);
  });

  it("换通道换了 residentId → RT-04 红（D25 五）", async () => {
    driver.faults.switchChannelChangesResident = true;
    expect(lampById(await runAllLamps(driver), "RT-04").passed).toBe(false);
  });

  it("换通道改了记忆集合 → RT-04 红（D25 五）", async () => {
    driver.faults.switchChannelMutatesMemory = true;
    expect(lampById(await runAllLamps(driver), "RT-04").passed).toBe(false);
  });

  it("换通道改写了一窗流旧条目 → RT-04 红", async () => {
    driver.faults.switchChannelRewritesStream = true;
    expect(lampById(await runAllLamps(driver), "RT-04").passed).toBe(false);
  });

  // —— RT-05 ——

  it("流式只有 1 个增量 → RT-05 红（不是流式吐出）", async () => {
    driver.faults.singleStreamChunk = true;
    expect(lampById(await runAllLamps(driver), "RT-05").passed).toBe(false);
  });

  it("画面长出会话列表 → RT-05 红（D9 / D11 四）", async () => {
    driver.faults.sessionListShown = true;
    expect(lampById(await runAllLamps(driver), "RT-05").passed).toBe(false);
  });

  it("状态栏缺模型 → RT-05 红", async () => {
    driver.faults.statusMissingModel = true;
    expect(lampById(await runAllLamps(driver), "RT-05").passed).toBe(false);
  });

  it("出错却静默 → RT-05 红", async () => {
    driver.faults.silentFailure = true;
    expect(lampById(await runAllLamps(driver), "RT-05").passed).toBe(false);
  });

  // —— RT-06 ——

  it("credentialRef 就是密钥明文 → RT-06 红", async () => {
    driver.faults.credentialRefIsPlaintext = true;
    expect(lampById(await runAllLamps(driver), "RT-06").passed).toBe(false);
  });

  it("扫描器恒返回空命中 → RT-06 红（正对照失效）", async () => {
    driver.faults.scannerAlwaysEmpty = true;
    expect(lampById(await runAllLamps(driver), "RT-06").passed).toBe(false);
  });

  it("密钥明文漏进一窗流 → RT-06 红", async () => {
    driver.faults.secretLeaksIntoStream = true;
    expect(lampById(await runAllLamps(driver), "RT-06").passed).toBe(false);
  });

  // —— RT-08 ——

  it("缺确认却直接回放成功 → RT-08 红", async () => {
    driver.faults.recoveryPendingFalseGreen = true;
    expect(lampById(await runAllLamps(driver), "RT-08").passed).toBe(false);
  });

  it("恢复拒绝前仍调用模型 → RT-08 红", async () => {
    driver.faults.recoveryRetryCallsModel = true;
    expect(lampById(await runAllLamps(driver), "RT-08").passed).toBe(false);
  });

  it("恢复拒绝仍追加正文 → RT-08 红", async () => {
    driver.faults.recoveryRetryWritesBody = true;
    expect(lampById(await runAllLamps(driver), "RT-08").passed).toBe(false);
  });

  it("跨代孤立 user 被重新生成 → RT-08 红", async () => {
    driver.faults.recoveryCrossGenerationRegenerates = true;
    expect(lampById(await runAllLamps(driver), "RT-08").passed).toBe(false);
  });

  it("写后失败丢掉 runtime 自造锚 → RT-08 红", async () => {
    driver.faults.recoveryDropsFailureAnchor = true;
    expect(lampById(await runAllLamps(driver), "RT-08").passed).toBe(false);
  });
});

describe("RT-09 判卷反对照：正常退出接回同一代（#234）", () => {
  /** 只跑 RT-09 这一盏；改坏开关期望它红在**那一条**判据上，不是随便哪里红。 */
  async function runRt09(): Promise<LampOutcome> {
    return lampById(await runAllLamps(driver), "RT-09");
  }

  it("合规实现：对得上就接回、硬杀与坏记录照旧猝死、记录只用一次、账不重登记 → RT-09 绿", async () => {
    const lamp = await runRt09();
    expect(lamp.passed, lamp.detail).toBe(true);
    expect(lamp.detail).toContain("并发两宿主：第 1 代 / writer-unavailable");
  });

  it("正常退出也开新一代（现役行为）→ RT-09 红在第一条行为断言", async () => {
    driver.faults.pauseAlwaysNewGeneration = true;
    const lamp = await runRt09();
    expect(lamp.passed).toBe(false);
    expect(lamp.detail).toContain("正常退出被当成猝死换了代");
  });

  it("硬杀后不看暂停记录也接着上一代 → RT-09 红（D8 三）", async () => {
    driver.faults.resumeAfterHardKill = true;
    const lamp = await runRt09();
    expect(lamp.passed).toBe(false);
    expect(lamp.detail).toContain("硬杀被当成了正常退出");
  });

  it("损坏或身份对不上的暂停记录也照接 → RT-09 红（宁可忘，不冒认）", async () => {
    driver.faults.resumeOnTamperedRecord = true;
    const lamp = await runRt09();
    expect(lamp.passed).toBe(false);
    expect(lamp.detail).toContain("坏暂停记录被冒接了");
  });

  it("暂停记录接回后不作废、再硬杀还接 → RT-09 红（只许用一次）", async () => {
    driver.faults.pauseRecordReusable = true;
    const lamp = await runRt09();
    expect(lamp.passed).toBe(false);
    expect(lamp.detail).toContain("被用了第二次");
  });

  it("接回后把上一段流水又写进一窗流 → RT-09 红（流不重复写）", async () => {
    driver.faults.resumeDuplicatesStream = true;
    const lamp = await runRt09();
    expect(lamp.passed).toBe(false);
    expect(lamp.detail).toContain("旧流水不许再写一遍");
  });

  it("接回同一代、模型请求却不带上一段 → RT-09 红", async () => {
    driver.faults.resumeDropsHistory = true;
    const lamp = await runRt09();
    expect(lamp.passed).toBe(false);
    expect(lamp.detail).toContain("上一段没从一窗流读回");
  });

  it("接回时认证账按同一身份重新登记 → RT-09 红（#234 第 5 条）", async () => {
    driver.faults.resumeReregistersLedger = true;
    const lamp = await runRt09();
    expect(lamp.passed).toBe(false);
    expect(lamp.detail).toContain("认证账把接回当成一次新激活重新登记了");
  });

  it("接回时开了新窗、新窗第 1 代冒充同一代 → RT-09 红（代号与历史都骗得过，只有窗号分得开）", async () => {
    driver.faults.resumeChangesWindow = true;
    const lamp = await runRt09();
    expect(lamp.passed).toBe(false);
    expect(lamp.detail).toContain("接的不是同一扇窗");
  });

  it("正常退出时把缺口直接确认掉 → RT-09 红（暂停不是交付）", async () => {
    driver.faults.pauseAcksGap = true;
    const lamp = await runRt09();
    expect(lamp.passed).toBe(false);
    expect(lamp.detail).toContain("暂停不是交付");
  });

  it("硬杀后开了新一代却把旧流水塞进模型请求 → RT-09 红（D8 三）", async () => {
    driver.faults.hardKillCarriesHistory = true;
    const lamp = await runRt09();
    expect(lamp.passed).toBe(false);
    expect(lamp.detail).toContain("猝死不自动进继任者上下文");
  });

  it("两个宿主同时起、都接回暂停那代 → RT-09 红（#234 第 4 条）", async () => {
    driver.faults.raceBothResume = true;
    const lamp = await runRt09();
    expect(lamp.passed).toBe(false);
    expect(lamp.detail).toContain("暂停记录被两边同时认领");
  });

  it.each([
    ["raceFoldsPreReadyCrash", "ready 前崩溃被夹具折成 writer-unavailable", "没起到 ready"],
    ["raceLoserNotReady", "第二个宿主没起到 ready", "没起到 ready"],
    ["raceLoserRequestFailed", "第二个宿主的 say 请求本身抛错", "say 没真返回"],
    ["raceSamePid", "两边 ready 的是同一个进程", "ready 的是同一个进程"],
    [
      "raceLoserNotWriterUnavailable",
      "输的一边不是 say 返回的 writer-unavailable",
      "不是 say 返回的 writer-unavailable",
    ],
  ] as const)("并发段：%s（%s）→ RT-09 红（PR #235 验收席 P1-1）", async (fault, _label, why) => {
    driver.faults[fault] = true;
    const lamp = await runRt09();
    expect(lamp.passed).toBe(false);
    expect(lamp.detail).toContain(why);
  });

  it("弄坏暂停记录的夹具顺手抹了归档 → RT-09 红（坏记录按猝死也不许丢史）", async () => {
    driver.faults.tamperDropsArchive = true;
    const lamp = await runRt09();
    expect(lamp.passed).toBe(false);
    expect(lamp.detail).toContain("在归档里查不到");
  });

  it("模型请求观察口的历史恒为空 → RT-09 红在正对照（否则「旧流水没进请求」空转）", async () => {
    driver.faults.requestHistoryAlwaysEmpty = true;
    const lamp = await runRt09();
    expect(lamp.passed).toBe(false);
    expect(lamp.detail).toContain("历史观察口或本代历史本身不成立");
  });

  it("确认位观察口冻住不动 → RT-09 红（否则「baseline 没动」空转）", async () => {
    driver.faults.alignmentObserverFrozen = true;
    const lamp = await runRt09();
    expect(lamp.passed).toBe(false);
    expect(lamp.detail).toContain("没经接回的这次激活交付确认");
  });
});
