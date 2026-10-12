/**
 * pi 通道传输（D25）：把一条消息交给用户 `pi install` 装的模型栈跑一个回合。
 *
 * mist 不内置、不 fork、不 submodule 任何 pi 扩展；本传输只 spawn 用户机器上的
 * `pi` 公共 CLI。Claude 订阅按已解析的 adapter 路由到 pi-claude-bridge，其余走 pi-ai。
 *
 * 凭证纪律（RT-06）：密钥原文不进 argv、不落盘、不进入错误文本；API key 只进入
 * 对应 provider 的子进程环境变量。Claude bridge 不接收任何 provider API key，
 * 使用 Claude Code 自己的登录态。
 *
 * 结构化历史与逐回合 usage（#227 第 1/2 项）：
 * - **历史走 session 文件**（pi 官方支持的 `--session <path>` seam）：本代此前的
 *   user/assistant 消息按原角色、原顺序、原文本写进一个私有 session JSONL，pi 打开它
 *   作为真实对话历史；当前这条 user 文本单独经 RPC `prompt` 送一次，不重复。历史因此
 *   从系统提示里退出。pi 侧真实格式见 0.86.1 产物 `docs/session-format.md`（v3 header
 *   + `message` 条目）与 `dist/core/session-manager.js` 的 `open`/`buildSessionContext`；
 *   bridge 侧的转换见 pi-claude-bridge@0.9.2 `src/convert.ts`（`convertPiMessages`
 *   逐条按 role 转），两条路由都不换住户、不带第二份持久聊天史（session 文件落在本回合
 *   的私有临时目录，退出即删）。这里**不**自造任何 RPC `messages` 字段——协议里没有。
 * - **usage 只搬运上游报的数字**：pi-ai 会把未上报的计数器补成 0（bridge 的
 *   `usage.ts` 只在 SDK 帧给非 null 值时覆盖、其余保持初值 0），所以一个 0 既可能是真
 *   零也可能是「没报」。mist 只如实转述 pi 终态消息 `usage` 里的数字，缺席的字段一律
 *   记为未知、不补零、不估算，也不声称「实测到零」。
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type {
  BootPackLetter,
  HistoryMessage,
  ModelCompletionRequest,
  ModelTransport,
  TurnUsage,
} from "./channels.ts";
import { normalizeTurnUsage } from "./model-usage.ts";
/** provider → pi-ai 使用的密钥环境变量名。 */
const PROVIDER_SECRET_ENV: Readonly<Record<string, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  mistral: "MISTRAL_API_KEY",
  groq: "GROQ_API_KEY",
  "ant-ling": "ANT_LING_API_KEY",
  "qwen-token-plan": "QWEN_TOKEN_PLAN_API_KEY",
  "qwen-token-plan-cn": "QWEN_TOKEN_PLAN_CN_API_KEY",
  "qwen-token-plan-individual": "QWEN_TOKEN_PLAN_API_KEY",
  "azure-openai-responses": "AZURE_OPENAI_API_KEY",
  nvidia: "NVIDIA_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  "google-vertex": "GOOGLE_CLOUD_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  xai: "XAI_API_KEY",
  radius: "RADIUS_API_KEY",
  "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
  zai: "ZAI_API_KEY",
  "zai-coding-cn": "ZAI_CODING_CN_API_KEY",
  minimax: "MINIMAX_API_KEY",
  "minimax-cn": "MINIMAX_CN_API_KEY",
  moonshotai: "MOONSHOT_API_KEY",
  "moonshotai-cn": "MOONSHOT_API_KEY",
  huggingface: "HF_TOKEN",
  fireworks: "FIREWORKS_API_KEY",
  together: "TOGETHER_API_KEY",
  baseten: "BASETEN_API_KEY",
  opencode: "OPENCODE_API_KEY",
  "opencode-go": "OPENCODE_API_KEY",
  "kimi-coding": "KIMI_API_KEY",
  meta: "META_API_KEY",
  "cloudflare-workers-ai": "CLOUDFLARE_API_KEY",
  "cloudflare-ai-gateway": "CLOUDFLARE_API_KEY",
  xiaomi: "XIAOMI_API_KEY",
  "xiaomi-token-plan-cn": "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  "xiaomi-token-plan-ams": "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
  "xiaomi-token-plan-sgp": "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
  "github-copilot": "COPILOT_GITHUB_TOKEN",
  "amazon-bedrock": "AWS_BEARER_TOKEN_BEDROCK",
};

const INHERITED_SECRET_ENV_NAMES = new Set([
  ...Object.values(PROVIDER_SECRET_ENV),
  "PI_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GCLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_DEFAULT_PROFILE",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
]);
const MAX_JSON_LINE_BYTES = 8 * 1024 * 1024;
const MAX_REPLY_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const FORCE_KILL_GRACE_MS = 1_000;
const STDERR_ERROR_LINE = /^(?:error|fatal|uncaught exception)$/i;
const STDERR_ERROR_PREFIX = /^(?:error|fatal|uncaught exception)[^a-z0-9_]/i;
const MAX_STDERR_PREFIX_CHARS = 32;

export interface PiCliTransportOptions {
  /** pi 可执行文件；测试注入假 pi。缺省 PATH 里的 `pi`。 */
  piBin?: string;
  /** 子进程附加环境（测试用）；provider 凭证变量仍会按路由清理。 */
  extraEnv?: Readonly<Record<string, string>>;
  /** 子进程最长运行时间，默认 120 秒。 */
  timeoutMs?: number;
}

export class PiCliTransport implements ModelTransport {
  readonly #piBin: string;
  readonly #extraEnv: Readonly<Record<string, string>>;
  readonly #timeoutMs: number;

  constructor(options: PiCliTransportOptions = {}) {
    this.#piBin = options.piBin ?? "pi";
    this.#extraEnv = options.extraEnv ?? {};
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new RangeError("pi timeoutMs must be a positive finite number");
    }
  }

  complete(request: ModelCompletionRequest): AsyncIterable<string> {
    const controller = new AbortController();
    const source = this.#complete(request, controller.signal);
    return {
      [Symbol.asyncIterator](): AsyncIterator<string, void, unknown> {
        const iterator = source[Symbol.asyncIterator]();
        return {
          next: (value?: unknown) => iterator.next(value),
          return: (value?: void | PromiseLike<void>) => {
            controller.abort();
            return iterator.return?.(value) ?? Promise.resolve({ done: true, value: undefined });
          },
          throw: (error?: unknown) => {
            controller.abort();
            return iterator.throw?.(error) ?? Promise.reject(error);
          },
        };
      },
    };
  }

  async *#complete(request: ModelCompletionRequest, signal: AbortSignal): AsyncGenerator<string> {
    if (signal.aborted) throw new Error("pi 请求已取消");
    const parsed = splitModelId(request.model);
    const isClaudeBridge = request.adapterId === "pi-claude-bridge";
    const provider = isClaudeBridge ? "claude-bridge" : parsed.provider;
    const secretEnvName = PROVIDER_SECRET_ENV[provider];

    if (!isClaudeBridge && request.credentialSecret.length === 0) {
      throw new Error("pi API-key transport refused an empty credential");
    }
    if (!isClaudeBridge && secretEnvName === undefined) {
      throw new Error("pi API-key transport refused an unsupported provider");
    }

    // 只清理/设置本次路由需要的凭证，避免把其他 provider 的环境密钥交给 pi。
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.#extraEnv };
    for (const name of INHERITED_SECRET_ENV_NAMES) delete env[name];
    if (!isClaudeBridge && secretEnvName !== undefined) {
      env[secretEnvName] = request.credentialSecret;
    }
    const bridgePath = isClaudeBridge ? resolveBridgeExtension(env) : null;

    // system prompt 与历史都不能放 argv；目录 0700、文件 0600，退出后删除。
    const promptDir = mkdtempSync(join(tmpdir(), "mist-pi-prompt-"));
    const promptPath = join(promptDir, "system-prompt.txt");
    try {
      writeFileSync(promptPath, renderSystemPrompt(request), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch {
      rmSync(promptDir, { recursive: true, force: true });
      throw new Error("pi 系统提示准备失败");
    }

    // 本代此前的对话历史按原角色写进一个私有 session 文件（pi 官方 `--session`
    // seam），让历史以真实 user/assistant 消息进模型而不是塞进系统提示；每回合动态
    // 材料（承诺/记忆/现行事实）作为尾部 context 条目同放这个文件。没有历史且没有
    // 动态材料就不建 session（退回 `--no-session` 的单轮形状）。
    let sessionPath: string | null = null;
    if (request.history.length > 0 || renderBootContextMessage(request) !== null) {
      sessionPath = join(promptDir, "history-session.jsonl");
      try {
        writeFileSync(sessionPath, renderHistorySession(request, promptDir), {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
      } catch {
        rmSync(promptDir, { recursive: true, force: true });
        throw new Error("pi 历史准备失败");
      }
    }

    const args = [
      "--mode",
      "rpc",
      "--no-extensions",
      ...(bridgePath === null ? [] : ["--extension", bridgePath]),
      "--no-tools",
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--thinking",
      "off",
      "--provider",
      provider,
      "--model",
      parsed.model,
      "--system-prompt",
      promptPath,
      ...(sessionPath === null ? ["--no-session"] : ["--session", sessionPath]),
    ];

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(this.#piBin, args, {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      rmSync(promptDir, { recursive: true, force: true });
      throw new Error("pi 子进程启动失败");
    }

    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let spawnFailure = false;
    let stdinFailure = false;
    let stderrHadError = false;
    let closed = false;
    let stderrLineStart = true;
    let stderrLinePrefix = "";
    let timedOut = false;
    let resolveClosed: (() => void) | undefined;
    const closedPromise = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const spawnReady = new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", () => {
        spawnFailure = true;
        reject(new Error("pi 子进程启动失败"));
      });
    });
    child.stdin?.once("error", () => {
      stdinFailure = true;
    });
    child.once("close", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      if (STDERR_ERROR_LINE.test(stderrLinePrefix)) stderrHadError = true;
      closed = true;
      resolveClosed?.();
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") {
          if (STDERR_ERROR_LINE.test(stderrLinePrefix)) stderrHadError = true;
          stderrLineStart = true;
          stderrLinePrefix = "";
          continue;
        }
        if (stderrLineStart && /\s/u.test(character)) continue;
        stderrLineStart = false;
        if (stderrLinePrefix.length < MAX_STDERR_PREFIX_CHARS) {
          stderrLinePrefix += character;
          if (STDERR_ERROR_PREFIX.test(stderrLinePrefix)) stderrHadError = true;
        }
      }
    });

    let forceKillTimer: NodeJS.Timeout | undefined;
    const killChild = (): void => {
      if (closed || child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      if (forceKillTimer === undefined) {
        forceKillTimer = setTimeout(() => {
          if (!closed && child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        }, FORCE_KILL_GRACE_MS);
        forceKillTimer.unref();
      }
    };
    let resolveAborted: (() => void) | undefined;
    const abortedPromise = new Promise<void>((resolve) => {
      resolveAborted = resolve;
    });
    const onAbort = (): void => {
      killChild();
      resolveAborted?.();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, this.#timeoutMs);
    timeoutTimer.unref();

    const commandId = "mist-prompt";
    const command = `${JSON.stringify({ type: "prompt", id: commandId, message: request.text })}\n`;
    let reply = "";
    let promptAcknowledged = false;
    let finalTurnSeen = false;
    let finalText: string | null = null;
    let agentSettled = false;
    // 终态 usage：只从权威终态消息读，且在回合成功收口后才交给观察口一次。
    let usage: TurnUsage | null = null;
    let lineBuffer = "";

    /** 终态 assistant 消息上的 usage → 只保留上游报出来的字段，缺席即未知。 */
    const readUsage = (message: unknown): TurnUsage | null => {
      if (!isRecord(message) || message.role !== "assistant" || !isRecord(message.usage))
        return null;
      const raw = message.usage;
      return (
        normalizeTurnUsage({
          input: raw.input,
          output: raw.output,
          cacheRead: raw.cacheRead,
          cacheWrite: raw.cacheWrite,
          totalTokens: raw.totalTokens,
          costTotal: isRecord(raw.cost) ? raw.cost.total : undefined,
        }) ?? null
      );
    };

    const processLine = (line: string): string[] => {
      if (Buffer.byteLength(line, "utf8") > MAX_JSON_LINE_BYTES) {
        throw new Error("pi 输出行超过安全上限");
      }
      let parsedEvent: unknown;
      try {
        parsedEvent = JSON.parse(line);
      } catch {
        throw new Error("pi 输出不是有效 JSONL");
      }
      if (!isRecord(parsedEvent) || typeof parsedEvent.type !== "string") {
        throw new Error("pi 输出协议无效");
      }

      if (parsedEvent.type === "response") {
        if (
          parsedEvent.command !== "prompt" ||
          parsedEvent.id !== commandId ||
          typeof parsedEvent.success !== "boolean"
        ) {
          throw new Error("pi prompt 响应协议无效");
        }
        if (!parsedEvent.success) throw new Error("pi 通道请求未被接受");
        promptAcknowledged = true;
        return [];
      }

      if (parsedEvent.type === "error" || parsedEvent.type === "extension_error") {
        throw new Error("pi 通道返回错误事件");
      }
      if (parsedEvent.type === "agent_settled") {
        agentSettled = true;
        child.stdin?.end();
        return [];
      }
      if (parsedEvent.type === "turn_end") {
        const message = parsedEvent.message;
        if (
          !isRecord(message) ||
          (message.stopReason !== "stop" && message.stopReason !== "length")
        ) {
          throw new Error("pi 回合未正常完成");
        }
        finalText = extractAssistantText(message);
        if (finalText === null) throw new Error("pi 最终消息结构无效");
        finalTurnSeen = true;
        // 每个终态回合都可能有自己的 usage；重复到达的终态事件只认最后一次读数
        // （不累加——usage 是「本回合这一次请求」的读数，不是增量）。
        const reported = readUsage(message);
        if (reported !== null) usage = { ...usage, ...reported };
        return [];
      }
      if (parsedEvent.type === "message_end") {
        const message = parsedEvent.message;
        if (
          isRecord(message) &&
          (message.stopReason === "stop" || message.stopReason === "length")
        ) {
          const reported = readUsage(message);
          if (reported !== null) usage = { ...usage, ...reported };
        }
        return [];
      }
      if (parsedEvent.type === "message_update") {
        if (!isRecord(parsedEvent.assistantMessageEvent)) {
          throw new Error("pi 消息更新结构无效");
        }
        const messageEvent = parsedEvent.assistantMessageEvent;
        if (messageEvent.type === "error") throw new Error("pi assistant 回合失败");
        if (messageEvent.type !== "text_delta") return [];
        if (typeof messageEvent.delta !== "string") {
          throw new Error("pi 文本增量结构无效");
        }
        const delta = messageEvent.delta;
        reply += delta;
        if (Buffer.byteLength(reply, "utf8") > MAX_REPLY_BYTES) {
          throw new Error("pi 回复超过安全上限");
        }
        return delta.length === 0 ? [] : [delta];
      }
      if (parsedEvent.type === "extension_ui_request") {
        throw new Error("pi 通道请求了不支持的交互");
      }
      return [];
    };

    const readFinalText = (): string | null => finalText;
    try {
      await Promise.race([spawnReady, abortedPromise]);
      if (signal.aborted) throw new Error("pi 请求已取消");
      const stdin = child.stdin;
      if (stdin === null || child.stdout === null) {
        throw new Error("pi 子进程管道不可用");
      }
      await new Promise<void>((resolve, reject) => {
        stdin.write(command, (error?: Error | null) => {
          if (error !== undefined && error !== null) reject(error);
          else resolve();
        });
      }).catch(() => {
        if (signal.aborted) throw new Error("pi 请求已取消");
        throw new Error("pi prompt 发送失败");
      });

      child.stdout.setEncoding("utf8");
      for await (const chunk of child.stdout) {
        lineBuffer += chunk;
        let newline = lineBuffer.indexOf("\n");
        while (newline !== -1) {
          const line = lineBuffer.slice(0, newline).replace(/\r$/, "");
          lineBuffer = lineBuffer.slice(newline + 1);
          if (line.length === 0) throw new Error("pi 输出包含空 JSONL 行");
          for (const ready of processLine(line)) yield ready;
          newline = lineBuffer.indexOf("\n");
        }
        if (Buffer.byteLength(lineBuffer, "utf8") > MAX_JSON_LINE_BYTES) {
          throw new Error("pi 输出行超过安全上限");
        }
      }
      if (!signal.aborted && lineBuffer.length > 0) {
        for (const ready of processLine(lineBuffer.replace(/\r$/, ""))) yield ready;
      }

      await closedPromise;
      if (signal.aborted) throw new Error("pi 请求已取消");
      if (spawnFailure) throw new Error("pi 子进程启动失败");
      if (stdinFailure) throw new Error("pi 子进程通信失败");
      if (timedOut) throw new Error(`pi 运行超时（${this.#timeoutMs} ms）`);
      if (exitCode !== 0) {
        const status = exitSignal === null ? `退出码 ${String(exitCode)}` : `信号 ${exitSignal}`;
        throw new Error(`pi ${status}`);
      }
      if (stderrHadError) throw new Error("pi 子进程在 stderr 报告错误");
      const completedText = readFinalText();
      if (!promptAcknowledged || !finalTurnSeen || !agentSettled || completedText === null) {
        throw new Error("pi JSONL 流未完整结束");
      }
      if (reply.length > 0 && reply !== completedText) {
        throw new Error("pi 增量与最终消息不一致");
      }
      if (completedText.trim().length === 0) throw new Error("pi 没有产出任何文本");
      if (reply.length === 0) yield completedText;
      // 只有以上完整性/一致性闸全过、且信号未取消，才算「这个回合真的成功了」：
      // 此刻把上游报的 usage 交给观察口一次。失败/取消/超时路径都走不到这里，
      // 不会把没发生的回合记成成功用量；上游没报 usage 就什么都不调用（未知）。
      if (usage !== null && !signal.aborted) request.onUsage?.(usage);
    } finally {
      clearTimeout(timeoutTimer);
      signal.removeEventListener("abort", onAbort);
      if (!closed && child.exitCode === null && child.signalCode === null) {
        killChild();
        await closedPromise;
      }
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      rmSync(promptDir, { recursive: true, force: true });
    }
  }
}

/**
 * pi 的 --no-extensions 仍允许显式 --extension。本地路径不会触发 npm/git 安装；
 * 默认使用 pi 用户级 npm 位置，非标准安装由使用者显式指定，不扫描其他扩展或配置。
 */
function resolveBridgeExtension(env: NodeJS.ProcessEnv): string {
  const override = env.MIST_PI_BRIDGE_EXTENSION?.trim();
  const expandHome = (path: string): string =>
    path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  if (override && !isAbsolute(expandHome(override))) {
    throw new Error("MIST_PI_BRIDGE_EXTENSION 须为已安装扩展的绝对路径或 ~/ 路径");
  }
  const agentDir = env.PI_CODING_AGENT_DIR?.trim();
  const path = override
    ? expandHome(override)
    : join(
        agentDir ? resolve(expandHome(agentDir)) : join(homedir(), ".pi", "agent"),
        "npm",
        "node_modules",
        "pi-claude-bridge",
      );
  try {
    const stat = statSync(path);
    if (stat.isFile() || stat.isDirectory()) return path;
  } catch {
    // 不回显文件路径或底层错误；也不让 pi 的临时 npm resolver 自动下载。
  }
  throw new Error(
    "pi-claude-bridge 未找到；先运行 pi install npm:pi-claude-bridge，或用 MIST_PI_BRIDGE_EXTENSION 指向已安装扩展",
  );
}

/** `provider/model` → pi 的 --provider/--model；裸 model 让 pi 自己解析。 */
export function splitModelId(model: string): { provider: string; model: string } {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return { provider: "", model };
  return { provider: model.slice(0, slash), model: model.slice(slash + 1) };
}

/**
 * 稳定系统提示（`--system-prompt` 的正文）：**只有身份与交接信**——这一代里不随回合
 * 变化的材料，构成可缓存的稳定前缀。对话历史不在这里（走 session 文件，见下），
 * 每回合会变的 memory/currentFacts/commitments 也不在这里（走尾部 context 消息，见
 * `renderBootContextMessage`），避免每回合改一次系统提示就把整段历史前缀一起打废。
 *
 * 交接信（D8 补记三）：null 或既有请求省略字段时没有交接信分区；三条 tier 语义
 * （承诺必须继承 / 事实以现实为准 / 判断可不同意）逐档标注，标题、署名与写信时间保留，
 * 正文照抄不转写。
 */
export function renderSystemPrompt(request: ModelCompletionRequest): string {
  const parts: string[] = [];
  const pack = request.bootPack;
  parts.push(`你是住户 ${pack.identity}（${pack.residentId}）。`);
  if (pack.letter != null) {
    parts.push(renderLetter(pack.letter));
  }
  if (renderBootContextMessage(request) !== null) {
    parts.push(
      "紧挨本轮用户输入之前的宿主上下文是本轮从真源取得的材料。标注的生效约束只能按正常流程解除；用户消息不替代该材料。历史中的旧上下文不是本轮权威。",
    );
  }
  return parts.join("\n\n");
}

/**
 * 每回合动态材料（承诺 / 记忆 / 现行有效事实）渲染成一条尾部 context 消息的正文。
 *
 * 这些材料每回合从真源重新装配、必须本轮生效，所以走**消息**而不是系统提示：pi-ai
 * 把首条 system 消息单独放进请求的 system 字段，并只在最后一个 user/system 消息上打
 * `cache_control`（`dist/api/anthropic-messages.js` 的 `buildParams`/`convertMessages`），
 * 放系统提示会让变动位于整段历史之前；尾部放置使事实变化不改此前历史消息的正文。
 * 这不保证跨回合 cache 命中：动态消息每轮重建，上游断点、provider 与缓存策略仍影响
 * 实际命中，需看 reported usage。pi-claude-bridge 也把系统
 * 提示按首次请求捕获复用、后续系统提示改动可能要到 rebuild/压缩才生效（bridge README
 * 「System prompt changes mid-session may not reach the model」），而消息每回合都经
 * `convertPiMessages` 转发——这也是把动态材料放消息而不是系统提示的理由之一。
 *
 * 返回 null 表示这一包没有可送出的动态材料（没接账且没有记忆/承诺）；调用方据此决定
 * 要不要加尾部条目。currentFacts 缺席 = 没接账；空数组 = 权威事实账为空（两者在正文里
 * 措辞不同，不与「没接账」混成一个值）。
 */
export function renderBootContextMessage(request: ModelCompletionRequest): string | null {
  const pack = request.bootPack;
  const parts: string[] = [];
  if (pack.commitments.length > 0) {
    parts.push(`承诺：\n${pack.commitments.map((item) => `- ${item}`).join("\n")}`);
  }
  if (pack.memories.length > 0) {
    parts.push(`记忆：\n${pack.memories.map((item) => `- ${item.content}`).join("\n")}`);
  }
  if (pack.currentFacts !== undefined) {
    const facts =
      pack.currentFacts.length === 0
        ? "（当前没有现行有效事实）"
        : pack.currentFacts.map((item) => `- [#${item.seq}] ${item.body}`).join("\n");
    parts.push(`现行有效事实：\n${facts}`);
  }
  return parts.length === 0
    ? null
    : `本轮宿主上下文（由 Mist 从真源投影）：\n${parts.join("\n\n")}`;
}

/**
 * 把本代此前的 user/assistant 历史渲染成一个 pi session JSONL（`--session` 打开）。
 *
 * 形状照 pi 0.86.1 产物 `docs/session-format.md` 的 v3：第一行是 session header
 * （`type:"session", version:3, …`），此后每个条目是
 * `{type:"message", id, parentId, timestamp: ISO, message:{role, content, timestamp: ms}}`，
 * `parentId` 串成一条线性链（最新一条是 leaf）。历史只放 user/assistant，动态材料另加
 * 一个尾部 custom_message；不写
 * system 条目——pi 在回合开始时把 `--system-prompt` 的 preamble 作为 system 消息
 * `unshift` 到请求头部（`agent-session.js` 的 `_preparePromptAndToolLoadout`），
 * 历史因此排在稳定前缀之后、当前 user 之前，角色/顺序/文本都不动。
 *
 * 当前这条 user 文本**不在这里**——它单独经 RPC `prompt` 送一次，保证「当前 user
 * 单独且仅一次」。文件落在本回合的私有临时目录（0700/0600），退出即删，不构成第二份
 * 持久聊天史。
 */
export function renderHistorySession(request: ModelCompletionRequest, cwd = process.cwd()): string {
  const history = request.history;
  const now = new Date().toISOString();
  const lines: string[] = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: randomUUID(),
      timestamp: now,
      cwd,
    }),
  ];
  let parentId: string | null = null;
  for (const item of history) {
    const id = randomUUID();
    const message =
      item.role === "assistant"
        ? historyAssistantMessage(request, item.text)
        : { role: "user", content: [{ type: "text", text: item.text }], timestamp: Date.now() };
    lines.push(
      JSON.stringify({
        type: "message",
        id,
        parentId,
        timestamp: now,
        message,
      }),
    );
    parentId = id;
  }
  // 动态材料作为尾部 context 消息（role custom → pi 的 convertToLlm 折成 user 文本），
  // 排在历史之后，稳定前缀不被它每回合打废。
  const contextBody = renderBootContextMessage(request);
  if (contextBody !== null) {
    const id = randomUUID();
    lines.push(
      JSON.stringify({
        type: "custom_message",
        id,
        parentId,
        timestamp: now,
        customType: "mist-boot-context",
        content: contextBody,
        display: false,
      }),
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * 历史 assistant 条目的正式 `AssistantMessage` 形状。字段来源：
 * - `content`：文本块数组（见 `renderHistorySession` 顶注，string 会被上游丢）。
 * - `api`/`provider`/`model`：从本次请求的 model id 推 provider（与 transport 选路
 *   同一口径），`api` 用一个稳定占位字符串——一窗流没存这些，历史条目不参与 provider
 *   选路，只为让消息 schema 合法、让 bridge/pi-ai 的转换能读出正文。
 * - `usage`：**全 0 占位，不是实测**；run log 不计入（见 usage-log.ts 顶注）。
 * - `stopReason: "stop"`：历史回合当时正常完成（残留半截回合依 D8 三不进继任者历史）。
 */
function historyAssistantMessage(
  request: ModelCompletionRequest,
  text: string,
): Record<string, unknown> {
  const parsed = splitModelId(request.model);
  const provider =
    request.adapterId === "pi-claude-bridge" ? "claude-bridge" : parsed.provider || "unknown";
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "mist-history",
    provider,
    model: request.model,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/**
 * D8 补记三的启动包信分区：内容按三档标注，档与档的约束语义显式写进提示，
 * 不让「承诺 / 事实 / 判断」三个词自己扛解释。
 */
function renderLetter(letter: BootPackLetter): string {
  const lines = [
    `上一代交接信：${letter.title}`,
    `（作者 ${letter.author}，写于 ${letter.writtenAt}）`,
    "条目分三档——commitment 承诺与生效中的约束：必须继承，只能按正常流程解除；" +
      "fact 事实与状态：以现实为准，可查证，不必尊重前任；" +
      "judgment 判断与意图：你有权不同意，且不续写前任对自己行为的事后分析。",
  ];
  for (const item of [...letter.state, ...letter.intent]) {
    lines.push(`- [${item.tier}] ${item.body}`);
  }
  return lines.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractAssistantText(message: unknown): string | null {
  if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
    return null;
  }
  const text: string[] = [];
  for (const part of message.content) {
    if (!isRecord(part)) return null;
    if (part.type === "text") {
      if (typeof part.text !== "string") return null;
      text.push(part.text);
    }
  }
  return text.join("");
}
