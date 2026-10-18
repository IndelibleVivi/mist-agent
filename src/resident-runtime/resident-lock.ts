/**
 * 一位住户同一时刻只在一个宿主进程里开窗（D9：一条流，一个写方；#234 并发两宿主）。
 *
 * 一窗流整份重写落盘，两个进程各写各的必然丢事件；进程内已有 writer 所有权挡第二个
 * runtime，跨进程靠这把锁。一位住户一份 `<dataDir>/sessions/active/<residentId>.lock`
 * （0600，内容是持有进程的 pid、随机令牌与起锁时刻），本进程第一次给这位住户开窗时拿
 * （`ResidentRuntime#windowFor`，在认领暂停记录之前），`close()` 关完 writer 后放（只放
 * 令牌是自己的那份）。硬杀留下的锁，下次启动看 pid 已不在就接管。
 *
 * 建锁：先把完整内容写进本进程独有的临时文件，再 `link` 到锁路径——已存在就 EEXIST，
 * 与 `wx` 同样是原子的「只建一次」，但锁一出现就是写完的：直接 `wx` 建锁路径会露出
 * 一段空文件，被同时起的另一个进程当成坏锁接管，两边都以为自己拿到了。
 *
 * 锁在且 pid 活着、不是本进程：拒绝（调用方在调模型、写流之前收成 writer-unavailable）。
 * pid 已死（ESRCH）、就是本进程，或锁读不出、形状不对：当陈锁接管——先 rename 到独有名字
 * （同时接管的几个进程只有一个 rename 得到），核对挪走的正是判过陈的那份，再按上面建锁；
 * 哪一步输了都当锁被别人拿着。
 *
 * 代价：死进程的 pid 被系统复用给别的活进程时，这位住户会一直显示「在别处打开」，直到有人
 * 按提示删掉锁文件；三个以上进程同时接管同一把陈锁、且时序恰好卡在挪走与放回之间时，
 * 仍可能两边都拿到（两个进程同时起不会）。
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  linkSync,
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
 * 这位住户开不了窗：锁在另一个活进程手里，或本运行时已经 close()。调用方在调模型、
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

function readIfPresent(path: string): { raw: string | null; missing: boolean } {
  try {
    return { raw: readFileSync(path, "utf8"), missing: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { raw: null, missing: true };
    // 读不出（权限、被目录占住等）：内容当坏锁，按陈锁接管。
    return { raw: null, missing: false };
  }
}

function parseHolder(raw: string | null, residentId: string): LockHolder | null {
  if (raw === null) return null;
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
  /** 本进程拿着的锁：residentId → 令牌。 */
  readonly #held = new Map<string, string>();
  #closed = false;

  constructor(dataDir: string) {
    this.#dataDir = dataDir;
  }

  /**
   * 拿这位住户的锁；已经拿着就什么都不做。拿不到抛 `ResidentHostLockError`；
   * 落盘本身失败（盘满、目录建不了）照原样抛，调用方按开窗失败处理。
   */
  acquire(residentId: string): void {
    if (this.#closed) {
      throw new ResidentHostLockError(
        `运行时已关闭，不再为住户 ${residentId} 开窗`,
        "重新启动宿主后再说话",
      );
    }
    if (this.#held.has(residentId)) return;
    const path = residentLockPath(this.#dataDir, residentId);
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
      const observed = readIfPresent(path);
      if (observed.missing) continue; // 持有者刚放了锁：再建一次。
      const holder = parseHolder(observed.raw, residentId);
      if (holder !== null && holder.pid !== process.pid && isAlive(holder.pid)) {
        throw this.#busy(residentId, holder.pid, path);
      }
      if (!this.#takeOver(path, observed.raw)) break;
      if (createExclusive(path, content)) {
        this.#held.set(residentId, token);
        return;
      }
      break;
    }
    throw this.#busy(residentId, parseHolder(readIfPresent(path).raw, residentId)?.pid, path);
  }

  /** 关闭时放掉本进程拿着的每把锁（只删令牌还是自己的那份）。之后不再拿锁；重复调用无事。 */
  releaseAll(): void {
    this.#closed = true;
    for (const [residentId, token] of this.#held) {
      const path = residentLockPath(this.#dataDir, residentId);
      try {
        if (parseHolder(readIfPresent(path).raw, residentId)?.token === token) {
          rmSync(path, { force: true });
        }
      } catch {
        // 删不掉：本进程退出后 pid 不在，下次启动按陈锁接管。
      }
    }
    this.#held.clear();
  }

  /**
   * 接管陈锁：rename 到独有名字（抢不到就是别人先接管了），核对挪走的正是判过陈的那份；
   * 挪走的若是别人刚建的新锁，按原样 link 回去并认输。
   */
  #takeOver(path: string, staleRaw: string | null): boolean {
    const aside = `${path}.stale-${process.pid}-${randomUUID()}`;
    try {
      renameSync(path, aside);
    } catch {
      return false;
    }
    try {
      if (readIfPresent(aside).raw === staleRaw) return true;
      try {
        linkSync(aside, path);
      } catch {
        // 锁路径又被人建上了：那份才是现役的锁。
      }
      return false;
    } finally {
      rmSync(aside, { force: true, recursive: true });
    }
  }

  #busy(residentId: string, pid: number | undefined, path: string): ResidentHostLockError {
    const who = pid === undefined ? "另一个 mist 进程" : `另一个 mist 进程（pid ${pid}）`;
    return new ResidentHostLockError(
      `住户 ${residentId} 正在${who}里打开：本进程不开窗、不调模型、不写一窗流`,
      `先到那个进程里退出（/exit）再来；若确认没有别的 mist 进程在跑，删掉锁文件 ${path} 后重试`,
    );
  }
}
