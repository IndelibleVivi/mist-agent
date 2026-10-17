import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type Interface, createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import type { BreathTrigger } from "../../acceptance/resident-runtime-driver.ts";
import { InstallerStateStore } from "../installer/state-store.ts";
import type { ResidentIdentityFailureReason } from "../resident-continuity/identity-store.ts";
import { parseManualBreath } from "../session/breath-trigger.ts";
import { assembleResidentRuntime } from "./assembly.ts";
import { type ModelTransport, createModelTransport } from "./channels.ts";
import { CredentialStore } from "./credentials.ts";
import { residentFromInstall } from "./onboarding.ts";
import { ResidentChatTui } from "./tui.ts";

/** 身份闸拒绝在终端边界的人话 message：保持与 runtime identityFailure 同一口径。 */
function identityFailureMessage(
  reason: ResidentIdentityFailureReason,
  referenceId: string,
): string {
  if (reason === "candidate-pending") return `候选住户尚未自认：${referenceId}`;
  if (reason === "candidate-rejected") return `候选住户已拒绝这份人格：${referenceId}`;
  return `没有 active resident：${referenceId}`;
}

/** 可操作 remedy；pending/rejected/missing 各给一条，不把三种塌成一句。 */
function identityFailureRemedy(reason: ResidentIdentityFailureReason): string {
  if (reason === "candidate-pending") {
    return "先完成这位 candidate 的 self-attestation；接受后再用返回的 residentId 进入运行时";
  }
  if (reason === "candidate-rejected") {
    return "停止普通聊天入口；如要重提，创建新的 persona candidate 并重新自认";
  }
  return "先创建 persona candidate，并由 candidate 本人接受后使用返回的 residentId（入住流程见 #182）";
}

interface ResidentCliOptions {
  /** 缺省 = 从当前安装启动（第一次会递人格稿、请住户自认、配通道）。 */
  readonly residentId?: string;
  readonly dataDir: string;
  readonly personaPath?: string;
  readonly model?: string;
  readonly help: boolean;
}

/**
 * 一条 CLI 输入的去向。命令不是发言（MV-D03）：`/new`、`/clear`、`/compact`
 * 走换气流程，绝不落进 `say()`，否则命令会被模型当成住户说的一句话。
 */
export type ResidentCliInput =
  | { readonly kind: "exit" }
  | { readonly kind: "breathe"; readonly via: BreathTrigger }
  | { readonly kind: "chat"; readonly text: string };

/**
 * 把一行真实 CLI 输入分派到出口。`/exit` 是本层唯一的退出命令；三个换气命令
 * 经现役 `parseManualBreath` 归一（大小写、首尾空白、带参数形式同义），转成
 * 换气 `via`——D8 三个入口同一条流程，不在这里另认一套命令表。
 */
export function parseResidentCliInput(line: string): ResidentCliInput {
  if (line.trim() === "/exit") return { kind: "exit" };
  const trigger = parseManualBreath(line);
  if (trigger !== null && trigger.command !== null) {
    return { kind: "breathe", via: trigger.command.slice(1) as BreathTrigger };
  }
  return { kind: "chat", text: line };
}

const VALUE_OPTIONS = new Set(["--resident", "--data-dir", "--persona", "--model"]);

export function parseResidentCliArguments(args: readonly string[]): ResidentCliOptions {
  const values = new Map<string, string>();
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === undefined || !VALUE_OPTIONS.has(argument)) {
      throw new Error(`unknown resident option: ${argument ?? ""}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--") || value.trim().length === 0) {
      throw new Error(`${argument} requires a value`);
    }
    values.set(argument, value);
    index += 1;
  }
  const residentId = values.get("--resident");
  const personaPath = values.get("--persona");
  const model = values.get("--model");
  if (residentId !== undefined && (personaPath !== undefined || model !== undefined)) {
    throw new Error(
      "--persona and --model belong to the install start; drop --resident to use them",
    );
  }
  return {
    ...(residentId === undefined ? {} : { residentId }),
    dataDir: resolve(
      values.get("--data-dir") ?? process.env.MIST_DATA_DIR ?? join(homedir(), ".mist"),
    ),
    ...(personaPath === undefined ? {} : { personaPath }),
    ...(model === undefined ? {} : { model }),
    help,
  };
}

export async function main(
  args = process.argv.slice(2),
  injection: { transport?: ModelTransport; lines?: AsyncIterable<string> } = {},
): Promise<void> {
  const options = parseResidentCliArguments(args);
  if (options.help) {
    process.stdout.write(
      "Usage: npm run resident [-- --persona <file>] [--model <provider/model>] [--data-dir <path>]\n",
    );
    process.stdout.write(
      "Without --resident it starts from the current setup: the first start hands the persona to the resident, lets it accept or decline, then sets up the model channel.\n",
    );
    process.stdout.write(
      "       npm run resident -- --resident <residentId> [--data-dir <path>]  (an existing resident, channel already set up)\n",
    );
    process.stdout.write("Type /exit to leave the single-resident chat.\n");
    process.stdout.write(
      "Type /new, /clear or /compact to breathe (commit a handover letter, start a new generation).\n",
    );
    return;
  }

  // 从安装启动是给人直接用的入口：没设 MIST_RESIDENT_RUNTIME_TRANSPORT 时走真实 pi 通道，
  // 不然自认那一轮只会收到合成回声。带 --resident 的老入口照旧按环境变量（缺省合成）。
  const mode = process.env.MIST_RESIDENT_RUNTIME_TRANSPORT;
  const transport =
    injection.transport ??
    createModelTransport(options.residentId === undefined ? mode || "pi" : mode);
  const runtime = assembleResidentRuntime({ dataDir: options.dataDir, transport });
  // 第一次启动的问答和之后的聊天读同一条输入，不开第二个 readline。
  let input: Interface | null = null;
  let source: AsyncIterable<string>;
  if (injection.lines === undefined) {
    input = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
    source = input;
  } else {
    source = injection.lines;
  }
  const lines = source[Symbol.asyncIterator]();
  const nextLine = async (): Promise<string | null> => {
    const next = await lines.next();
    return next.done === true ? null : next.value;
  };
  try {
    let referenceId = options.residentId;
    if (referenceId === undefined) {
      const credentials = new CredentialStore(join(options.dataDir, "credentials"));
      const prepared = await residentFromInstall({
        runtime,
        credentials,
        install: new InstallerStateStore(options.dataDir),
        transport,
        ask: async (question) => {
          process.stdout.write(`${question}\n> `);
          return nextLine();
        },
        say: (text) => process.stdout.write(`${text}\n`),
        ...(options.personaPath === undefined ? {} : { personaPath: options.personaPath }),
        ...(options.model === undefined ? {} : { model: options.model }),
      });
      if (!prepared.ok) {
        process.stderr.write(
          `${prepared.code}：${prepared.message}\n处理建议：${prepared.remedy}\n`,
        );
        process.exitCode = 1;
        return;
      }
      referenceId = prepared.residentId;
    }
    // CLI 是宿主边界：candidateId 只在这里 resolve 一次，之后一律用 canonical
    // residentId。身份闸（D22 / #182）先于凭证面成立——安装器只保存了配置，没有
    // 住户自认，所以没有 active 住户时按 reason 机器可分地拒绝，不假装凭证问题：
    // candidate-pending / candidate-rejected / resident-not-found 三码各自成对。
    // 不 throw 崩溃：把 code/message/remedy 写进 stderr 后 return exitCode=1。
    const active = runtime.requireActiveResident(referenceId);
    if (!active.ok) {
      const failure = {
        code: active.reason,
        message: identityFailureMessage(active.reason, referenceId),
        remedy: identityFailureRemedy(active.reason),
        residentId: referenceId,
      };
      process.stderr.write(`${failure.code}：${failure.message}\n处理建议：${failure.remedy}\n`);
      process.exitCode = 1;
      return;
    }
    const residentId = active.value.residentId;
    const credential = new CredentialStore(join(options.dataDir, "credentials")).find(residentId);
    const tui = new ResidentChatTui(runtime, {
      residentId,
      model: credential?.model ?? "未配置",
      onFrame: (frame) => {
        if (process.stdout.isTTY) process.stdout.write("\u001b[2J\u001b[H");
        process.stdout.write(`${frame.text}\n`);
      },
    });
    let interrupted = false;
    const onSigint = (): void => {
      interrupted = true;
      input?.close();
    };
    process.once("SIGINT", onSigint);

    try {
      tui.start();
      process.stdout.write("输入 /exit 结束。\n你> ");
      for (let line = await nextLine(); line !== null; line = await nextLine()) {
        const command = parseResidentCliInput(line);
        if (command.kind === "exit") break;
        if (line.trim().length === 0) {
          process.stdout.write("\n你> ");
          continue;
        }
        if (command.kind === "breathe") {
          // 换气命令不是发言：走 D8 的统一流程，绝不落进 say()。
          await tui.breathe(command.via);
        } else {
          await tui.submit(command.text);
        }
        process.stdout.write("\n你> ");
      }
    } finally {
      process.off("SIGINT", onSigint);
      if (interrupted) process.exitCode = 130;
    }
  } finally {
    input?.close();
    await runtime.close();
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown resident TUI failure";
    process.stderr.write(`Resident TUI failed: ${message}\n`);
    process.exitCode = 1;
  });
}
