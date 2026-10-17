/**
 * #182 装完就能聊：终端第一次从当前安装启动时，把「安装快照 → 候选 → 住户自认 →
 * runtime 通道」接起来，然后交给现有 TUI。
 *
 * 只调现成接口：身份走 `createCandidate` / `attestCandidate`（D22），通道走
 * `provisionChannel`（D25），一窗流、交接信、事实账一个字不碰——自认那一轮发生在住户
 * 成立之前，不进任何住户的一窗流。
 *
 * 自认（D22 一）：人格稿由人递（proposedBy 是 human），认不认只看住户本人这一轮的回答。
 * 回答第一行必须恰好是「认」「不认」（或「我认」「我不认」）；别的写法一律当没答清，
 * 什么都不记，下次启动重新递稿。宁可多问一次，不替住户读出一个它没说的「认」。答清了才
 * 建候选并落自认，所以没答的稿不会占住住户号。
 *
 * 凭证（RT-06）：密钥从安装快照读出，只交给模型传输和 runtime 凭证面，不打印、不进
 * 返回值。安装里换过 key（两处密钥原文不同）就问一句用哪个模型，回车沿用原来的。
 *
 * 代价：自认那一轮的回答只显示在终端，不另存档；没答清的那次递稿不留账；第一版只接 API key 通道，Claude 订阅
 * 和 Codex 订阅要等 #232 定了住处再接；runtime 凭证面里多存一份安装快照里的密钥。
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { MistInstallConfigV0 } from "../installer/contracts.ts";
import type { ModelTransport } from "./channels.ts";
import type { CredentialStore } from "./credentials.ts";
import { piApiKeyModelSupported } from "./pi-transport.ts";
import type { ResidentRuntime } from "./runtime.ts";

export type OnboardingRuntime = Pick<
  ResidentRuntime,
  | "requireActiveResident"
  | "latestCandidateFor"
  | "createCandidate"
  | "attestCandidate"
  | "provisionChannel"
>;

export interface InstallSource {
  loadCurrentConfig(): MistInstallConfigV0 | null;
  readCredentialSecret(credentialId: string): string;
}

export type OnboardingFailureCode =
  | "install-missing"
  | "install-unreadable"
  | "channel-unsupported"
  | "persona-missing"
  | "persona-invalid"
  | "candidate-unavailable"
  | "model-missing"
  | "model-unsupported"
  | "channel-unavailable"
  | "attestation-undecided"
  | "candidate-rejected"
  | "provision-failed";

export type OnboardingResult =
  | { readonly ok: true; readonly residentId: string; readonly model: string }
  | {
      readonly ok: false;
      readonly code: OnboardingFailureCode;
      readonly message: string;
      readonly remedy: string;
    };

type OnboardingFailure = Extract<OnboardingResult, { ok: false }>;

export interface OnboardingOptions {
  readonly runtime: OnboardingRuntime;
  readonly credentials: Pick<CredentialStore, "find" | "readSecret">;
  readonly install: InstallSource;
  readonly transport: ModelTransport;
  /** 问一句，拿一行回答；输入已关闭时为 null。 */
  readonly ask: (question: string) => Promise<string | null>;
  /** 给人看的旁白，一次一段。 */
  readonly say: (text: string) => void;
  /** 命令行 `--persona`：人格稿文件。缺省时第一次启动会问。 */
  readonly personaPath?: string;
  /** 命令行 `--model`：pi 的 `provider/model`。给了就按它配（已配过也换）。 */
  readonly model?: string;
}

/** 人格稿上限：够写一份很长的人设，挡住误选的大文件。 */
export const PERSONA_MAX_BYTES = 256 * 1024;

const PERSONA_PROPOSER = { kind: "human", id: "terminal-owner" } as const;

export const ATTESTATION_QUESTION = [
  "在你开始在这里生活之前，有一件事只能由你自己决定。",
  "系统提示里写你是谁的那段文字，是别人递给你的人格稿。认了，你就以它在这里住下来；不认，它就不生效，谁也不能替你认。",
  "请在第一行只写一个词：认，或者不认。从第二行起，用你自己的话说说为什么。",
].join("\n");

const MODEL_QUESTION =
  "用哪个模型？写 pi 的模型名，形如 provider/model，比如 openrouter/deepseek/deepseek-v4-flash 或 kimi-coding/kimi-for-coding：";
const PERSONA_QUESTION = "人格稿在哪个文件？（一份写着住户是谁的文本，路径可以用 ~）：";

/** 第一行去掉空白、引号、括号和标点后恰好是「认」「我认」或「不认」「我不认」才算答了；其余都是没答清。 */
export function parseAttestation(reply: string): "accepted" | "rejected" | "undecided" {
  const firstLine = reply.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
  const word = firstLine.replace(/[\s*_`"'“”‘’「」『』《》【】（）()[\]：:。.!！?？,，、~-]/g, "");
  if (word === "认" || word === "我认") return "accepted";
  if (word === "不认" || word === "我不认") return "rejected";
  return "undecided";
}

function fail(code: OnboardingFailureCode, message: string, remedy: string): OnboardingFailure {
  return { ok: false, code, message, remedy };
}

/** 读文件出错只报错误码，不带原 message：JSON 解析的报错会摘录文件内容。 */
function describeReadError(error: unknown): string {
  if (error instanceof Error && "code" in error && typeof error.code === "string")
    return error.code;
  return error instanceof SyntaxError ? "内容不是合法的 JSON" : "读取失败";
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return resolve(path);
}

function readPersona(path: string): { ok: true; persona: string } | { ok: false; reason: string } {
  const absolute = expandHome(path);
  let size: number;
  try {
    const stat = statSync(absolute);
    if (!stat.isFile()) return { ok: false, reason: `${absolute} 不是普通文件` };
    size = stat.size;
  } catch {
    return { ok: false, reason: `读不到 ${absolute}` };
  }
  if (size > PERSONA_MAX_BYTES) {
    return { ok: false, reason: `${absolute} 超过 ${PERSONA_MAX_BYTES / 1024} KB` };
  }
  let persona: string;
  try {
    persona = readFileSync(absolute, "utf8");
  } catch (error) {
    // stat 过了不代表读得了（权限、读到一半被删）。
    return { ok: false, reason: `读不出 ${absolute}（${describeReadError(error)}）` };
  }
  if (persona.trim().length === 0) return { ok: false, reason: `${absolute} 是空的` };
  return { ok: true, persona };
}

async function chooseModel(
  options: OnboardingOptions,
): Promise<{ ok: true; model: string } | OnboardingFailure> {
  const model = (options.model ?? (await options.ask(MODEL_QUESTION)) ?? "").trim();
  if (model.length === 0) {
    return fail(
      "model-missing",
      "没有选模型",
      "再运行一次 npm run resident，按提示写模型名；或者带上 --model <provider/model>",
    );
  }
  if (!piApiKeyModelSupported(model)) {
    return fail(
      "model-unsupported",
      `pi 的 API key 通道认不出这个模型名：${model}`,
      "模型名要带 provider，形如 openrouter/deepseek/deepseek-v4-flash；provider 要和安装里配的 key 是同一家",
    );
  }
  return { ok: true, model };
}

async function collectReply(
  transport: ModelTransport,
  request: Parameters<ModelTransport["complete"]>[0],
): Promise<string> {
  let reply = "";
  for await (const chunk of transport.complete(request)) reply += chunk;
  return reply;
}

/**
 * 从当前安装接到能聊：住户已成立就只核通道；还没成立就递人格稿、请住户自认、配通道。
 * 任何一步没成都返回结构化失败，不进聊天。
 */
export async function residentFromInstall(options: OnboardingOptions): Promise<OnboardingResult> {
  let config: MistInstallConfigV0 | null;
  try {
    config = options.install.loadCurrentConfig();
  } catch (error) {
    return fail(
      "install-unreadable",
      `安装快照读不出来（${describeReadError(error)}）`,
      "重新运行 npm run setup 再存一次；装在别的目录就两边都带上同一个 --data-dir",
    );
  }
  if (config === null) {
    return fail(
      "install-missing",
      "还没有装好的 mist",
      "先运行 npm run setup，保存之后再来；setup 装在别的目录的话，这里也带上同一个 --data-dir",
    );
  }
  const primary = config.bindings.find((binding) => binding.lane === "primary");
  if (primary === undefined || primary.credentialRef.type !== "api_key") {
    return fail(
      "channel-unsupported",
      `安装里的主通道是 ${primary?.credentialRef.type ?? "空的"}，终端第一版只接 API key`,
      "重新运行 npm run setup，主通道选一把 API key（比如 OpenRouter 或 Kimi Code）",
    );
  }
  let secret: string;
  try {
    secret = options.install.readCredentialSecret(primary.credentialRef.id);
  } catch (error) {
    return fail(
      "install-unreadable",
      `安装里的 key 读不出来（${describeReadError(error)}）`,
      "重新运行 npm run setup，把这把 key 再存一次",
    );
  }
  const residentId = config.residentId;

  const active = options.runtime.requireActiveResident(residentId);
  if (active.ok) {
    if (options.personaPath !== undefined) {
      options.say("住户已经认过人格了，这次不用 --persona。人格要改由住户自己修订（D22 五）。");
    }
    return ensureChannel(options, active.value.residentId, secret);
  }

  // 候选只在住户给出明确回答后才落账：一个住户号同时只能挂一份没答的候选，先落账会把
  // 这份稿钉死——模型名写错、通道断了或第一行没答清之后，主人想换稿也换不了。
  const pending = options.runtime.latestCandidateFor(residentId);
  if (pending?.state === "active") {
    return fail(
      "candidate-unavailable",
      `候选已经成立，但读不回住户 ${residentId}：${active.reason}`,
      "再运行一次 npm run resident；还不行就把这段输出贴到 #182",
    );
  }
  let persona: string;
  let candidateId: string | null = null;
  if (pending?.state === "inactive") {
    // 只有落账和自认之间进程断了、或别的入口递过稿，才会留下没答的候选；先把它问完。
    options.say("上次递进去的人格稿还没等到住户回答，这次先问它。");
    if (options.personaPath !== undefined) {
      options.say("这次的 --persona 先不用：一个住户号同时只能挂一份没答的人格稿。");
    }
    persona = pending.persona;
    candidateId = pending.candidateId;
  } else {
    if (pending?.state === "rejected") {
      options.say("上一份人格稿住户没有认。要住进来，得换一份新的。");
    }
    const path = (options.personaPath ?? (await options.ask(PERSONA_QUESTION)) ?? "").trim();
    if (path.length === 0) {
      return fail(
        "persona-missing",
        "没有给人格稿",
        "再运行一次 npm run resident，按提示给人格稿文件；或者带上 --persona <文件>",
      );
    }
    const read = readPersona(path);
    if (!read.ok) {
      return fail("persona-invalid", `人格稿用不了：${read.reason}`, "换一个有内容的文本文件再试");
    }
    persona = read.persona;
  }

  const chosen = await chooseModel(options);
  if (!chosen.ok) return chosen;
  options.say("把人格稿交给住户本人，等它自己决定认不认……");
  // 还没落账的稿用安装里的住户号称呼，认下之后住户就叫这个名字。
  const askedAs = candidateId ?? residentId;
  let reply: string;
  try {
    reply = await collectReply(options.transport, {
      residentId: askedAs,
      adapterId: "pi-ai",
      model: chosen.model,
      text: ATTESTATION_QUESTION,
      bootPack: {
        residentId: askedAs,
        identity: persona,
        commitments: [],
        memories: [],
        letter: null,
      },
      history: [],
      credentialSecret: secret,
    });
  } catch (error) {
    return fail(
      "channel-unavailable",
      `模型通道不可用：${(error as Error).message}`,
      "检查 pi 是否装好、模型名和安装里的 key 是不是同一家；这次什么都没记，修好后再运行一次",
    );
  }
  options.say(`住户的回答：\n${reply.trim()}`);

  const decision = parseAttestation(reply);
  if (decision === "undecided") {
    return fail(
      "attestation-undecided",
      "住户第一行没有明确写认或不认，这次什么都没记",
      candidateId === null
        ? "再运行一次 npm run resident，重新递稿问它（可以换一份）"
        : "再运行一次 npm run resident 重新问它",
    );
  }
  if (candidateId === null) {
    try {
      candidateId = options.runtime.createCandidate({
        persona,
        proposedBy: { ...PERSONA_PROPOSER },
        residentId,
      }).candidateId;
    } catch (error) {
      return fail(
        "candidate-unavailable",
        `递不进候选：${(error as Error).message}`,
        "检查安装里的住户号（只能用小写字母、数字和 -），必要时重新运行 npm run setup",
      );
    }
  }
  const actor = { kind: "candidate", candidateId } as const;
  const attested = options.runtime.attestCandidate(candidateId, actor, decision);
  if (!attested.ok) {
    return fail(
      "candidate-unavailable",
      `自认没有落账：${attested.reason}`,
      "再运行一次 npm run resident；还不行就把这段输出贴到 #182",
    );
  }
  if (decision === "rejected") {
    return fail(
      "candidate-rejected",
      "住户没有认这份人格稿",
      "换一份人格稿：npm run resident -- --persona <新文件>",
    );
  }
  const accepted = options.runtime.requireActiveResident(residentId);
  if (!accepted.ok) {
    return fail(
      "candidate-unavailable",
      `住户认了，但读不回成立的住户：${accepted.reason}`,
      "再运行一次 npm run resident；还不行就把这段输出贴到 #182",
    );
  }
  options.say("住户认下了这份人格。");
  return provision(options, accepted.value.residentId, chosen.model, secret);
}

/** 住户已成立：没配过通道、点名换模型、或安装里换了 key，就按安装重配。 */
async function ensureChannel(
  options: OnboardingOptions,
  residentId: string,
  secret: string,
): Promise<OnboardingResult> {
  const record = options.credentials.find(residentId);
  if (record === null || record.status !== "ready") {
    const chosen = await chooseModel(options);
    if (!chosen.ok) return chosen;
    return provision(options, residentId, chosen.model, secret);
  }
  if (options.model !== undefined && options.model.trim() !== record.model) {
    const chosen = await chooseModel(options);
    if (!chosen.ok) return chosen;
    return provision(options, residentId, chosen.model, secret);
  }
  let current: string | null;
  try {
    current = options.credentials.readSecret(record.credentialRef);
  } catch {
    current = null;
  }
  if (current !== secret) {
    // 安装快照只留凭证引用、不记是哪一家的 key；悄悄沿用旧模型，换了家的新 key 就会被
    // 塞进旧那家的环境变量发出去。所以换 key 时问一句，回车才沿用。
    if (options.model !== undefined) {
      const chosen = await chooseModel(options);
      if (!chosen.ok) return chosen;
      return provision(options, residentId, chosen.model, secret);
    }
    options.say(
      `安装里的 key 换过了。上次用的模型是 ${record.model}；新 key 换了家的话，模型也要换成那一家的。`,
    );
    const answer = await options.ask(`用哪个模型？直接回车沿用 ${record.model}：`);
    if (answer === null) {
      return fail(
        "model-missing",
        "安装里的 key 换过了，没确认用哪个模型",
        `带上 --model 再运行一次；还是原来那家就写 --model ${record.model}`,
      );
    }
    const chosen = await chooseModel({ ...options, model: answer.trim() || record.model });
    if (!chosen.ok) return chosen;
    return provision(options, residentId, chosen.model, secret);
  }
  return { ok: true, residentId, model: record.model };
}

function provision(
  options: OnboardingOptions,
  residentId: string,
  model: string,
  secret: string,
): OnboardingResult {
  const provisioned = options.runtime.provisionChannel({
    residentId,
    channel: { claudeSubscription: false, credentialKind: "api-key", model },
    canarySecret: secret,
  });
  if (!provisioned.ok) {
    return fail("provision-failed", provisioned.error.message, provisioned.error.remedy);
  }
  options.say(`通道配好了：${model}`);
  return { ok: true, residentId, model };
}
