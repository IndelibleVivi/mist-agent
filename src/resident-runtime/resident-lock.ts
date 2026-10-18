/**
 * 一位住户同一时刻只在一个宿主进程里开窗（D9：一条流，一个写方；#234 并发两宿主）。
 *
 * 一窗流整份重写落盘，两个进程各写各的必然丢事件；进程内已有 writer 所有权挡第二个
 * runtime，跨进程靠这把锁。一位住户一份 `<dataDir>/sessions/active/<residentId>.lock`
 * （0600，内容是持有进程的 pid、随机令牌与起锁时刻）。`ResidentRuntime#windowFor` 每次用到
 * 这位住户都先过这里（在认领暂停记录、调模型、写流之前）：第一次拿锁，之后每回合核对锁里
 * 还是自己的令牌；`close()` 之后一律拒绝，关完 writer 再放（只放令牌是自己的那份）。硬杀
 * 留下的锁，下次启动看 pid 已不在就接管。
 *
 * 建锁：先把完整内容写进本进程独有的临时文件，再 `link` 到锁路径——已存在就 EEXIST，
 * 与 `wx` 同样是原子的「只建一次」，但锁一出现就是写完的：直接 `wx` 建锁路径会露出
 * 一段空文件，被同时起的另一个进程当成坏锁接管，两边都以为自己拿到了。
 *
 * 锁在且 pid 活着、不是本进程：拒绝（调用方收成 writer-unavailable）。锁文件在却读不出
 * （EIO、EMFILE、EACCES 等）：核实不了谁拿着，同样拒绝，绝不当坏锁抢。pid 已死（ESRCH）、
 * 就是本进程、读出来解析不了，或锁路径被目录等非文件占住：当陈锁接管——先 rename 到独有名字
 * （同时接管的几个进程只有一个 rename 得到），核对挪走的正是判过陈的那份（读出来逐字相同，
 * 或仍是非文件；读不出不算相同），再按上面建锁；挪走的若是别人刚建的新锁就 link 放回认输，
 * 放回时出 EEXIST 以外的错就照实报错、不冒充「别人拿着」。
 *
 * 两个进程同时起不会两边都拿到。文件路径上没有比较并交换，三个以上进程同时接管同一把陈锁
 * 时，挪走与放回之间的空档里可能有第三个进程建上新锁，把刚接管的那一边挤掉；被挤掉的持有者
 * 在下一回合开头核对令牌时停下，至多已在途的那一回合与新持有者重叠一次。
 *
 * 代价：死进程的 pid 被系统复用给别的活进程时，这位住户会一直显示「在别处打开」，直到有人
 * 按提示删掉锁文件；三个以上进程抢陈锁时可能有一回合重叠（见上）；每回合多读一次锁文件；
 * 两个 pid 命名空间不同的容器共用一个数据目录时，存活判断不可靠——对方活着也可能被当成陈锁
 * 接管，本空间碰巧有同号进程时又会一直显示「在别处打开」。
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

const LOCK_SCHEMA = 1;
/** 与住户档案、事实账、一窗流、暂停记录同一条住户号文件名闸。 */
const SAFE_RESIDENT_ID = /^[a-z0-9-]+$/;
const LOCK_KEYS = ["pid", "residentId", "schemaVersion", "startedAt", "token"];
/** 锁一直被抢走又放回时的重试上限；过了就当锁被别人拿着。 */
const ACQUIRE_ATTEMPTS = 3;

interface LockHolder {
  readonly pid: number;
  readonly token: string;
}

/**
 * 这位住户用不了：锁在另一个活进程手里、读不出、已被接管或删除，或本运行时已经 close()。调用方在调模型、
 * 写一窗流之前把它收成 writer-unavailable 的结构化失败（message + remedy）。
 */
export class ResidentHostLockError extends Error {
  readonly remedy: string;
  constructor(message: string, remedy: string) {
    super(message);
    this.name = "ResidentHostLockError";
    this.remedy = remedy;
  }
}

function assertResidentId(residentId: string): void {
  if (typeof residentId !== "string" || !SAFE_RESIDENT_ID.test(residentId)) {
    throw new Error(`resident id 不可作为文件名: ${residentId}`);
  }
}

/** 某位住户宿主锁的落盘位置（测试也从这里取，不另写一份路径）。 */
export function residentLockPath(dataDir: string, residentId: string): string {
  assertResidentId(residentId);
  return join(dataDir, "sessions", "active", `${residentId}.lock`);
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** 锁路径上看到了什么。读不出（unreadable）与读出来是坏的（file 但解析不了）分开：前者不许接管。 */
type Observed =
  | { readonly kind: "missing" }
  | { readonly kind: "file"; readonly raw: string }
  | { readonly kind: "not-file" }
  | { readonly kind: "unreadable"; readonly code: string };

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? "EUNKNOWN";
}

function observe(path: string): Observed {
  try {
    // 目录、符号链接等占住锁路径：不是谁的锁（真锁一律是 link 上来的普通文件）。
    if (!lstatSync(path).isFile()) return { kind: "not-file" };
    return { kind: "file", raw: readFileSync(path, "utf8") };
  } catch (error) {
    const code = errorCode(error);
    return code === "ENOENT" ? { kind: "missing" } : { kind: "unreadable", code };
  }
}

/** 挪走的那份是不是判过陈的那份：逐字相同，或仍是非文件；读不出永远不算相同。 */
function sameObservation(judged: Observed, moved: Observed): boolean {
  if (judged.kind === "file") return moved.kind === "file" && moved.raw === judged.raw;
  return judged.kind === "not-file" && moved.kind === "not-file";
}

function parseHolder(observed: Observed, residentId: string): LockHolder | null {
  if (observed.kind !== "file") return null;
  const raw = observed.raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== LOCK_KEYS.join(",")) return null;
  if (record.schemaVersion !== LOCK_SCHEMA || record.residentId !== residentId) return null;
  const { pid, token, startedAt } = record;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1) return null;
  if (typeof token !== "string" || token === "") return null;
  if (typeof startedAt !== "string" || startedAt === "") return null;
  return { pid, token };
}

/** pid 还在不在：ESRCH 是不在；EPERM 是在（别的用户的进程）。 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 完整内容先落独有临时文件再 link：锁路径已存在返回 false，出现即是写完的。 */
function createExclusive(path: string, content: string): boolean {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    fchmodSync(descriptor, 0o600);
    writeSync(descriptor, content);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    try {
      linkSync(temporaryPath, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    fsyncDirectory(dirname(path));
    return true;
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // 保留原始写入错误。
      }
    }
    rmSync(temporaryPath, { force: true });
  }
}

export class ResidentHostLocks {
  readonly #dataDir: string;
  /** 本进程拿到过的锁：residentId → 令牌。被挤掉后照旧留着，核对永远不过，直到重启。 */
  readonly #held = new Map<string, string>();
  #closed = false;

  constructor(dataDir: string) {
    this.#dataDir = dataDir;
  }

  /**
   * 用这位住户之前过锁：没拿过就拿；拿过就核对锁文件里还是自己的令牌（被接管、被删、
   * 读不出都拒绝）；`close()` 之后一律拒绝。拿不到抛 `ResidentHostLockError`；落盘本身
   * 失败（盘满、目录建不了）照原样抛，调用方按开窗失败处理。
   */
  acquire(residentId: string): void {
    if (this.#closed) {
      throw new ResidentHostLockError(
        `运行时已关闭，不再为住户 ${residentId} 开窗`,
        "重新启动宿主后再说话",
      );
    }
    const path = residentLockPath(this.#dataDir, residentId);
    const heldToken = this.#held.get(residentId);
    if (heldToken !== undefined) {
      this.#verify(residentId, heldToken, path);
      return;
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const token = randomUUID();
    const content = JSON.stringify({
      schemaVersion: LOCK_SCHEMA,
      residentId,
      pid: process.pid,
      token,
      startedAt: new Date().toISOString(),
    });
    for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
      if (createExclusive(path, content)) {
        this.#held.set(residentId, token);
        return;
      }
      const observed = observe(path);
      if (observed.kind === "missing") continue; // 持有者刚放了锁：再建一次。
      if (observed.kind === "unreadable") throw this.#unverifiable(residentId, observed.code, path);
      const holder = parseHolder(observed, residentId);
      if (holder !== null && holder.pid !== process.pid && isAlive(holder.pid)) {
        throw this.#busy(residentId, holder.pid, path);
      }
      if (!this.#takeOver(residentId, path, observed)) break;
      if (createExclusive(path, content)) {
        this.#held.set(residentId, token);
        return;
      }
      break;
    }
    throw this.#busy(residentId, parseHolder(observe(path), residentId)?.pid, path);
  }

  /** 从此不再拿锁、不再认可已拿的锁（runtime.close() 一开头就调）。重复调用无事。 */
  close(): void {
    this.#closed = true;
  }

  /** 关闭时放掉本进程拿着的每把锁（只删令牌还是自己的那份）。隐含 close()；重复调用无事。 */
  releaseAll(): void {
    this.#closed = true;
    for (const [residentId, token] of this.#held) {
      const path = residentLockPath(this.#dataDir, residentId);
      try {
        if (parseHolder(observe(path), residentId)?.token === token) {
          rmSync(path, { force: true });
        }
      } catch {
        // 删不掉：本进程退出后 pid 不在，下次启动按陈锁接管。
      }
    }
    this.#held.clear();
  }

  /** 每回合的令牌核对：锁文件里不是自己的令牌（被接管、被删）或读不出，就停下。 */
  #verify(residentId: string, token: string, path: string): void {
    const observed = observe(path);
    if (parseHolder(observed, residentId)?.token === token) return;
    if (observed.kind === "unreadable") throw this.#unverifiable(residentId, observed.code, path);
    throw new ResidentHostLockError(
      `住户 ${residentId} 的锁已被接管或删除：本进程不再为它调模型、写一窗流`,
      this.#remedy(path),
    );
  }

  /**
   * 接管陈锁：rename 到独有名字（抢不到就是别人先接管了），核对挪走的正是判过陈的那份；
   * 挪走的若是别人刚建的新锁，link 放回并认输。放回撞上 EEXIST 是锁路径又被人建上了，
   * 那份才是现役的锁；别的错照实抛——被挪走的持有者下一回合核对令牌时会停下。
   */
  #takeOver(residentId: string, path: string, judged: Observed): boolean {
    const aside = `${path}.stale-${process.pid}-${randomUUID()}`;
    try {
      renameSync(path, aside);
    } catch {
      return false;
    }
    try {
      if (sameObservation(judged, observe(aside))) return true;
      try {
        linkSync(aside, path);
      } catch (error) {
        const code = errorCode(error);
        if (code === "EEXIST") return false;
        throw new ResidentHostLockError(
          `住户 ${residentId} 的锁接管没成：挪走的是另一个进程刚建的锁，放回时出错（${code}）；那个进程下一回合核对锁时会停下`,
          `稍后重试；若确认没有别的 mist 进程在跑，删掉锁文件 ${path} 后重试`,
        );
      }
      return false;
    } finally {
      rmSync(aside, { force: true, recursive: true });
    }
  }

  #remedy(path: string): string {
    return `先到那个进程里退出（/exit）再来；若确认没有别的 mist 进程在跑，删掉锁文件 ${path} 后重试`;
  }

  #busy(residentId: string, pid: number | undefined, path: string): ResidentHostLockError {
    const who = pid === undefined ? "另一个 mist 进程" : `另一个 mist 进程（pid ${pid}）`;
    return new ResidentHostLockError(
      `住户 ${residentId} 正在${who}里打开：本进程不开窗、不调模型、不写一窗流`,
      this.#remedy(path),
    );
  }

  #unverifiable(residentId: string, code: string, path: string): ResidentHostLockError {
    return new ResidentHostLockError(
      `住户 ${residentId} 的锁文件在却读不出（${code}）：核实不了是谁拿着，本进程不开窗、不调模型、不写一窗流`,
      `修好锁文件的读取（权限、磁盘）后重试；若确认没有别的 mist 进程在跑，删掉锁文件 ${path} 后重试`,
    );
  }
}
