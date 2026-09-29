import { execFileSync } from "node:child_process";
/**
 * #191/#192 stacked red contract for GC-01..10, GC-12, GC-15 and GC-16.
 *
 *   npm run acceptance:group-chat        # report expected reds if no host adapter
 *   npm run acceptance:group-chat:strict # nonzero unless all real-host checks pass
 *
 * A missing adapter is a known red baseline, never a green or host test result.
 * `kind: "mist-host"` is only a type tag: before any lamp runs, the host's own report is
 * checked against facts the judge reads itself — the pid is a live descendant of this judge
 * process running the same node binary with an entry file from this checkout's src/, and the
 * commit is the checked-out HEAD. After stopHost() the process must be gone and readbacks must
 * reject. These checks stop lazy stand-ins; a judge-written durable challenge also proves that
 * readbacks come from the host's own ledger. A host that fails these checks gets every lamp red and a nonzero exit in
 * both modes: it is a broken adapter, not the missing-driver baseline.
 * STUBBED follows the repo's acceptance convention: declared methods turn a lamp yellow.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { RoomEventStore } from "../src/group-chat/room-event-store.ts";
import { groupChatChecks, runGroupChatCheck } from "./group-chat-checks.ts";
import {
  type GroupChatCheckId,
  type GroupChatHostDriver,
  type GroupChatHostRun,
  cloneGroupChatDriverBoundary,
  groupChatSyntheticFixture,
} from "./group-chat-driver.ts";

const DRIVER_SPECIFIER = "../src/group-chat-acceptance-driver.ts";
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_ROOT = join(REPO_ROOT, "src");
const strict = process.argv.includes("--strict");

export interface GroupChatRunResult {
  readonly id: GroupChatCheckId;
  readonly title: string;
  readonly passed: boolean;
  readonly stubbed: boolean;
  readonly detail: string;
}

interface JudgeDurabilityResult {
  readonly passed: boolean;
  readonly detail: string;
}

interface HostChecksResult {
  readonly lamps: GroupChatRunResult[];
  readonly judgeDurability: JudgeDurabilityResult;
}

export function scoreGroupChatResults(results: readonly GroupChatRunResult[]): {
  readonly trueGreen: number;
  readonly stubGreen: number;
  readonly strictPass: boolean;
} {
  const trueGreen = results.filter((result) => result.passed && !result.stubbed).length;
  const stubGreen = results.filter((result) => result.passed && result.stubbed).length;
  return { trueGreen, stubGreen, strictPass: trueGreen === results.length };
}

export function missingDriverResults(): GroupChatRunResult[] {
  return groupChatChecks.map(({ id, title }) => ({
    id,
    title,
    passed: false,
    stubbed: false,
    detail: "real-host driver missing (expected stacked red; no host behavior exercised)",
  }));
}

/** The adapter's host failed the judge's own process/source checks, before or after the lamps. */
export class HostProvenanceError extends Error {
  override readonly name = "HostProvenanceError";
}

/**
 * A host that fails provenance leaves no lamp judged: readbacks cannot be attributed to it.
 * All seven report red with the reason; this is a broken adapter, not the missing-driver
 * baseline, so the runner exits nonzero in report mode too.
 */
export function provenanceFailedResults(reason: string): GroupChatRunResult[] {
  return groupChatChecks.map(({ id, title }) => ({
    id,
    title,
    passed: false,
    stubbed: false,
    detail: `${reason} (no lamp judged: readbacks are not attributable to the reported host)`,
  }));
}

/** What the judge reads about a process itself: Linux /proc, other POSIX systems `ps`. */
export interface HostProcessInfo {
  /** Present and not a zombie. */
  readonly alive: boolean;
  /** Parent chain as far as the judge could read it, nearest first. */
  readonly ancestors: readonly number[];
  /** Resolved path of the running binary, or null if unreadable. */
  readonly executable: string | null;
  /** argv including argv[0], or null if unreadable. */
  readonly args: readonly string[] | null;
  /**
   * True when only a space-joined command line was readable (`ps`), so `args` are its words
   * and an argument that contains spaces arrives split across several of them.
   */
  readonly argvSplitOnSpaces?: boolean;
}

/**
 * Arguments after argv[0] that may name the host entry file. From a space-joined command line
 * every run of consecutive words is a candidate, so an entry path containing spaces still
 * matches; isRepoEntryFile() then accepts only an existing non-test file under src/.
 */
function entryArgCandidates(info: HostProcessInfo): string[] {
  const args = info.args?.slice(1) ?? [];
  if (info.argvSplitOnSpaces !== true) return [...args];
  const spans: string[] = [];
  for (let start = 0; start < args.length; start++)
    for (let end = start + 1; end <= args.length; end++)
      spans.push(args.slice(start, end).join(" "));
  return spans;
}

export interface HostProvenanceFacts {
  readonly headCommit: string;
  readonly judgePid: number;
  /** Resolved path of the node binary running this judge. */
  readonly judgeExecutable: string;
  readonly repoRoot: string;
  readonly readProcess: (pid: number) => HostProcessInfo | null;
}

/**
 * Checks the host's self-reported run against facts the judge reads itself. Returns the reason
 * it is not acceptable as real-host evidence, or null. A synthetic fixture (made-up pid,
 * placeholder commit) fails here even if it calls itself "mist-host", and so does a borrowed
 * live pid: the judge's own, pid 1, a stray sleep, or an idle node child with no entry file.
 */
export function hostProvenanceProblem(
  run: GroupChatHostRun,
  facts: HostProvenanceFacts,
): string | null {
  if (!Number.isSafeInteger(run.pid) || run.pid <= 0)
    return "host did not report a valid process id";
  const info = facts.readProcess(run.pid);
  if (info === null || !info.alive) return `host process ${run.pid} is not running`;
  if (run.pid === facts.judgePid || !info.ancestors.includes(facts.judgePid))
    return `host process ${run.pid} was not started by this judge run (not a descendant of pid ${facts.judgePid})`;
  if (info.executable !== facts.judgeExecutable)
    return `host process ${run.pid} runs ${info.executable ?? "an unreadable binary"}, not this judge's node ${facts.judgeExecutable}`;
  if (!entryArgCandidates(info).some((arg) => isRepoEntryFile(arg, facts.repoRoot)))
    return `host process ${run.pid} command line names no entry file under src/ in this checkout`;
  const commit = run.commit.trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/u.test(commit)) return `host source "${run.commit}" is not a commit id`;
  if (!facts.headCommit.trim().toLowerCase().startsWith(commit))
    return `host source ${run.commit} is not the checked-out HEAD ${facts.headCommit.trim()}`;
  return null;
}

/**
 * A restart must produce a genuinely new process of the same source: new pid, previous pid
 * gone, and the fresh run passes the same provenance check at the same commit.
 */
export function restartedHostProvenanceProblem(
  previous: GroupChatHostRun,
  current: GroupChatHostRun,
  facts: HostProvenanceFacts,
): string | null {
  if (current.pid === previous.pid) return "host restart reused the previous process id";
  if (facts.readProcess(previous.pid)?.alive === true)
    return `previous host process ${previous.pid} is still alive after restart`;
  const currentProblem = hostProvenanceProblem(current, facts);
  if (currentProblem !== null) return currentProblem;
  if (current.commit.trim().toLowerCase() !== previous.commit.trim().toLowerCase())
    return "host restart changed the source commit";
  return null;
}

/**
 * After stopHost() resolves, the host process must be gone and readbacks must fail: an adapter
 * that still answers is serving its own copy, not the host process it reported.
 */
export async function hostStopProblem(
  driver: Pick<GroupChatHostDriver, "readRoomEvents">,
  pid: number,
  readProcess: (pid: number) => HostProcessInfo | null,
): Promise<string | null> {
  if (readProcess(pid)?.alive === true)
    return `host process ${pid} is still running after stopHost()`;
  try {
    await driver.readRoomEvents();
  } catch {
    return null;
  }
  return "readRoomEvents() still answered after stopHost(), so readbacks do not come from the host process";
}

/**
 * Prove the adapter reads the host's durable ledger, not a judge/adapter memory copy: stop the
 * real child, append directly through the judge's independent store handle, restart the host,
 * then ask the adapter to read the judge-only event back.
 */
export async function judgeDirectWriteReadback(
  driver: GroupChatHostDriver,
  stoppedHost: GroupChatHostRun,
  facts: HostProvenanceFacts,
): Promise<JudgeDurabilityResult> {
  const dataRoot = stoppedHost.dataRoot;
  if (dataRoot === undefined)
    return { passed: false, detail: "adapter did not expose its acceptance dataRoot" };

  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(dataRoot);
    if (
      dirname(canonicalRoot) !== realpathSync(tmpdir()) ||
      !basename(canonicalRoot).startsWith("mist-group-chat-")
    ) {
      return {
        passed: false,
        detail: "refused judge write: dataRoot is not this adapter's isolated temporary ledger",
      };
    }
  } catch (error) {
    return {
      passed: false,
      detail: `cannot resolve adapter dataRoot: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const probeId = randomUUID();
  const roomId = groupChatSyntheticFixture.roomId;
  const body = `judge-direct-write-${probeId}`;
  let restarted: GroupChatHostRun | null = null;
  let detail = "judge direct-write challenge did not complete";
  let passed = false;
  try {
    const judgeStore = new RoomEventStore(canonicalRoot);
    let eventId: string;
    try {
      eventId = judgeStore.append({
        operationId: `judge-direct-${probeId}`,
        roomId,
        principalId: groupChatSyntheticFixture.residentIds.a,
        authorId: groupChatSyntheticFixture.residentIds.a,
        body,
        visibility: "public",
        requestSemantics: JSON.stringify({ probeId, roomId, body }),
      }).event.id;
    } finally {
      judgeStore.close();
    }

    restarted = await driver.startHost();
    const restartProblem =
      restarted.pid === stoppedHost.pid
        ? "restarted host reused the stopped process id"
        : (hostProvenanceProblem(restarted, facts) ??
          (restarted.commit.trim().toLowerCase() === stoppedHost.commit.trim().toLowerCase()
            ? null
            : "restarted host changed the source commit"));
    if (restartProblem !== null) {
      detail = `judge direct write was recorded, but restart provenance failed: ${restartProblem}`;
    } else if (restarted.dataRoot !== canonicalRoot) {
      detail = "restarted host did not reopen the same durable dataRoot";
    } else {
      const events = await driver.readRoomEvents(roomId);
      const recovered = events.find((event) => event.id === eventId);
      passed =
        recovered?.body === body &&
        recovered.authorId === groupChatSyntheticFixture.residentIds.a &&
        recovered.roomId === roomId;
      detail = passed
        ? `judge-only event ${eventId} survived host restart and adapter readback`
        : "adapter readback missed or altered the judge-only event after host restart";
    }
  } catch (error) {
    detail = `judge direct-write challenge failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    try {
      await driver.stopHost();
    } catch (error) {
      passed = false;
      detail = `${detail}; restart stop failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  if (restarted !== null) {
    const stopProblem = await hostStopProblem(driver, restarted.pid, facts.readProcess);
    if (stopProblem !== null) {
      passed = false;
      detail = `${detail}; cleanup check failed: ${stopProblem}`;
    }
  }
  return { passed, detail };
}

function currentHeadCommit(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

function attempt<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

function linuxStat(pid: number): { readonly state: string; readonly ppid: number } | null {
  const stat = attempt(() => readFileSync(`/proc/${pid}/stat`, "utf8"));
  if (stat === null) return null;
  // The command name may contain spaces or parentheses; the fixed fields follow the last ")".
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return { state: fields[0] ?? "", ppid: Number(fields[1]) };
}

function psField(pid: number, field: string): string | null {
  return attempt(() =>
    execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf8" }).trim(),
  );
}

function ancestorsOf(pid: number, parentOf: (child: number) => number): number[] {
  const ancestors: number[] = [];
  let parent = parentOf(pid);
  while (Number.isSafeInteger(parent) && parent > 0 && ancestors.length < 64) {
    ancestors.push(parent);
    parent = parentOf(parent);
  }
  return ancestors;
}

/** Reads a process through /proc (Linux) or `ps` (other POSIX); null when it is not there. */
export function readProcessInfo(
  pid: number,
  via: "proc" | "ps" = process.platform === "linux" ? "proc" : "ps",
): HostProcessInfo | null {
  if (via === "proc") {
    const stat = linuxStat(pid);
    if (stat === null) return null;
    return {
      alive: stat.state !== "Z" && stat.state !== "X",
      ancestors: ancestorsOf(pid, (child) => linuxStat(child)?.ppid ?? 0),
      executable: attempt(() => realpathSync(readlinkSync(`/proc/${pid}/exe`))),
      args: attempt(() =>
        readFileSync(`/proc/${pid}/cmdline`, "utf8")
          .split("\0")
          .filter((arg) => arg !== ""),
      ),
    };
  }
  const state = psField(pid, "stat");
  if (state === null || state === "") return null;
  // macOS `ps` reports comm as the executable's path. Where it is only a short name (procps,
  // BSDs) the binary counts as unreadable: provenance then fails closed with that reason
  // instead of matching a bare name, or a same-named file in the judge's working directory.
  const command = psField(pid, "comm");
  return {
    alive: !state.startsWith("Z"),
    ancestors: ancestorsOf(pid, (child) => Number(psField(child, "ppid") ?? 0)),
    executable:
      command === null || !isAbsolute(command)
        ? null
        : (attempt(() => realpathSync(command)) ?? command),
    // `ps` joins argv with single spaces; keep empty words so a span rejoins to the original.
    args: psField(pid, "args")?.split(" ") ?? null,
    argvSplitOnSpaces: true,
  };
}

const SOURCE_FILE = /\.[cm]?[jt]sx?$/u;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const SKIPPED_DIRECTORIES = new Set(["node_modules", "__tests__", "test", "tests"]);

/**
 * A command-line argument that names an existing non-test source file under this checkout's
 * src/: the host's own entry, not the judge, a dependency, or code outside the checkout.
 */
export function isRepoEntryFile(arg: string, repoRoot: string): boolean {
  if (arg.startsWith("-")) return false;
  const inside = relative(repoRoot, resolve(repoRoot, arg));
  if (!inside.startsWith(`src${sep}`) || inside.split(sep).includes("node_modules")) return false;
  if (!SOURCE_FILE.test(inside) || TEST_FILE.test(inside)) return false;
  return attempt(() => statSync(join(repoRoot, inside)).isFile()) === true;
}

/**
 * GC-04 static half: non-test source files under `root` that spell out any of `terms`.
 * Paths are reported relative to `displayRoot`. Only judge fixture/roster ids can be found
 * this way; hard-coded production names are left to the two-world differential and review.
 */
export async function findSourceLiterals(
  root: string,
  terms: readonly string[],
  displayRoot: string = root,
): Promise<string[]> {
  if (terms.length === 0 || !existsSync(root)) return [];
  const hits: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) await walk(path);
      } else if (entry.isFile() && SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) {
        const text = await readFile(path, "utf8");
        if (terms.some((term) => text.includes(term))) hits.push(relative(displayRoot, path));
      }
    }
  };
  await walk(root);
  return hits.sort();
}

function driverFileExists(): boolean {
  return existsSync(fileURLToPath(new URL(DRIVER_SPECIFIER, import.meta.url)));
}

export interface LoadedDriver {
  readonly driver: GroupChatHostDriver;
  readonly stubbed: ReadonlySet<string>;
}

async function loadDriver(): Promise<LoadedDriver | null> {
  if (!driverFileExists()) return null;
  const mod = await import(DRIVER_SPECIFIER);
  if (typeof mod.createGroupChatHostDriver !== "function") {
    throw new Error(
      "src/group-chat-acceptance-driver.ts exists but does not export createGroupChatHostDriver()",
    );
  }
  const driver = mod.createGroupChatHostDriver() as GroupChatHostDriver;
  if (driver.kind !== "mist-host") {
    throw new Error('group-chat adapter must be typed kind: "mist-host"');
  }
  return {
    driver: cloneGroupChatDriverBoundary(driver),
    stubbed: new Set<string>(Array.isArray(mod.STUBBED) ? mod.STUBBED : []),
  };
}

/** Tests inject the driver loader and provenance facts; production leaves both real. */
export interface GroupChatAcceptanceOptions {
  readonly strict?: boolean;
  readonly loadDriver?: () => Promise<LoadedDriver | null>;
  readonly facts?: HostProvenanceFacts;
  readonly log?: (line: string) => void;
}

export interface GroupChatAcceptanceOutcome {
  readonly results: readonly GroupChatRunResult[];
  readonly judgeDurability: JudgeDurabilityResult | null;
  readonly driverMissing: boolean;
  readonly provenanceFailed: boolean;
  readonly strict: boolean;
  readonly exitCode: number;
}

interface JudgeDurabilityResult {
  readonly passed: boolean;
  readonly detail: string;
}

interface HostChecksResult {
  readonly lamps: GroupChatRunResult[];
  readonly judgeDurability: JudgeDurabilityResult;
}

async function runHostChecks(
  loaded: LoadedDriver,
  factsOverride?: HostProvenanceFacts,
  log: (line: string) => void = console.log,
): Promise<HostChecksResult> {
  const { driver, stubbed } = loaded;
  const facts: HostProvenanceFacts = factsOverride ?? {
    headCommit: currentHeadCommit(),
    judgePid: process.pid,
    judgeExecutable: realpathSync(process.execPath),
    repoRoot: REPO_ROOT,
    readProcess: (pid) => readProcessInfo(pid),
  };
  const host = await driver.startHost();
  const problem = hostProvenanceProblem(host, facts);
  if (problem !== null) {
    await driver.stopHost();
    throw new HostProvenanceError(`real-host provenance check failed: ${problem}`);
  }

  let activeHost = host;
  const context = {
    findSourceLiterals: (terms: readonly string[]) =>
      findSourceLiterals(SOURCE_ROOT, terms, REPO_ROOT),
    restartHost: async (restartDriver: GroupChatHostDriver) => {
      const previous = activeHost;
      const current = await restartDriver.restartHost();
      const restartProblem = restartedHostProvenanceProblem(previous, current, facts);
      // Restart provenance is whole-run evidence: a host whose restart cannot be
      // attributed leaves no lamp judgeable, exactly like the start/stop checks.
      // It must surface as HostProvenanceError so the runner paints every lamp red
      // instead of one lamp's "scenario threw".
      if (restartProblem !== null)
        throw new HostProvenanceError(
          `restarted real-host provenance check failed: ${restartProblem}`,
        );
      activeHost = current;
      return { previous, current };
    },
  };
  const results: GroupChatRunResult[] = [];
  try {
    for (const check of groupChatChecks) {
      try {
        const verdict = await runGroupChatCheck(check.id, driver, context);
        const isStubbed = check.uses.some((method) => stubbed.has(method));
        results.push({
          id: check.id,
          title: check.title,
          ...verdict,
          stubbed: isStubbed,
        });
      } catch (error) {
        // A provenance failure is not one lamp's scenario error: rethrow it to the
        // runner boundary so every lamp goes red and both modes exit nonzero.
        if (error instanceof HostProvenanceError) throw error;
        results.push({
          id: check.id,
          title: check.title,
          passed: false,
          stubbed: false,
          detail: `scenario threw: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  } finally {
    await driver.stopHost();
  }
  const stopProblem = await hostStopProblem(driver, activeHost.pid, facts.readProcess);
  if (stopProblem !== null)
    throw new HostProvenanceError(
      `real-host provenance check failed after stopHost(): ${stopProblem}`,
    );
  log(`真实宿主进程 PID ${activeHost.pid}；代码 ${activeHost.commit}`);
  const judgeDurability = await judgeDirectWriteReadback(driver, activeHost, facts);
  log(
    "宿主来源已由判卷核对：判卷子进程、同一 node、src/ 入口、当前 HEAD、停机后进程退出且读回拒绝。",
  );
  return { lamps: results, judgeDurability };
}

export async function executeGroupChatAcceptance(
  options: GroupChatAcceptanceOptions = {},
): Promise<GroupChatAcceptanceOutcome> {
  const isStrict = options.strict ?? false;
  const log = options.log ?? console.log;
  const driver = await (options.loadDriver ?? loadDriver)();
  log("Mist #191/#192 群聊验收：GC-01～10、GC-12、GC-15、GC-16");
  log(`合成夹具：${groupChatSyntheticFixture.roomId}；不读取真实聊天/记忆/凭据`);
  log("");

  let provenanceFailed = false;
  let judgeDurability: JudgeDurabilityResult | null = null;
  let results: GroupChatRunResult[];
  if (driver === null) {
    results = missingDriverResults();
  } else {
    try {
      const hostResults = await runHostChecks(driver, options.facts, log);
      results = hostResults.lamps;
      judgeDurability = hostResults.judgeDurability;
    } catch (error) {
      if (!(error instanceof HostProvenanceError)) throw error;
      provenanceFailed = true;
      results = provenanceFailedResults(error.message);
    }
  }
  const score = scoreGroupChatResults(results);
  for (const result of results) {
    log(
      `${result.passed ? (result.stubbed ? "🟡" : "🟢") : "🔴"} ${result.id} ${result.stubbed && result.passed ? `桩灯 — ${result.title}` : result.title}`,
    );
    log(`   ${result.detail}`);
  }
  if (judgeDurability !== null) {
    log(`${judgeDurability.passed ? "🟢" : "🔴"} 判卷直写耐久原账并重启后经 adapter 读回`);
    log(`   ${judgeDurability.detail}`);
  }
  log("");
  log(
    `真实宿主通过 ${driver === null ? 0 : score.trueGreen} / ${results.length}${score.stubGreen > 0 ? `；桩灯 ${score.stubGreen}` : ""}`,
  );
  if (driver === null)
    log("这轮只确认 #192 六灯 stacked 于已合入 #202 的预期红灯；没有执行宿主正向/负向验收。");
  if (provenanceFailed) {
    log("宿主来源核对未通过：这是坏 adapter，不是缺驱动的起点，报告模式同样非零退出。");
  }
  const exitCode =
    provenanceFailed ||
    (judgeDurability !== null && !judgeDurability.passed) ||
    (isStrict && !score.strictPass)
      ? 1
      : 0;
  return {
    results,
    judgeDurability,
    driverMissing: driver === null,
    provenanceFailed,
    strict: isStrict,
    exitCode,
  };
}

async function main(): Promise<void> {
  const outcome = await executeGroupChatAcceptance({ strict });
  if (outcome.exitCode !== 0) process.exitCode = outcome.exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
