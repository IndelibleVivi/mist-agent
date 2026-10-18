/**
 * 住户宿主锁的确定性竞态与读失败（Grok 评审 #234 锁）：在 node:fs 的 rename / link /
 * readFileSync 上挂钩，把「三个进程抢同一把陈锁」和「判过之后锁路径变成目录」卡进挪走与
 * 放回之间的空档，以及把锁文件读不出造出来。真进程的并发抢锁见 resident-lock.test.ts。
 */
import type { PathLike } from "node:fs";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ResidentHostLockError,
  ResidentHostLocks,
  residentLockPath,
} from "../src/resident-runtime/resident-lock.ts";

const hooks = vi.hoisted(() => ({
  /** 接管时 rename(锁, 旁名) 真正执行之前跑一次（一次性）。 */
  beforeStaleRename: null as (() => void) | null,
  /** 放回 link(旁名, 锁) 时跑一次（一次性），代替或先于真 link。 */
  onPutBack: null as (() => void) | null,
  /** 读这些路径时抛这个错误码。 */
  readFails: null as ((path: string) => string | null) | null,
  /** 把旁名挪回锁路径的 rename 抛这个错误码。 */
  renameBackFails: null as string | null,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const fail = (code: string): NodeJS.ErrnoException =>
    Object.assign(new Error(`${code}: simulated`), { code });
  return {
    ...actual,
    renameSync: (from: PathLike, to: PathLike): void => {
      if (hooks.renameBackFails !== null && String(from).includes(".stale-")) {
        throw fail(hooks.renameBackFails);
      }
      const hook = hooks.beforeStaleRename;
      if (hook !== null && String(to).includes(".stale-")) {
        hooks.beforeStaleRename = null;
        hook();
      }
      actual.renameSync(from, to);
    },
    linkSync: (existing: PathLike, target: PathLike): void => {
      const hook = hooks.onPutBack;
      if (hook !== null && String(existing).includes(".stale-")) {
        hooks.onPutBack = null;
        hook();
      }
      actual.linkSync(existing, target);
    },
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      const code = hooks.readFails?.(String(args[0])) ?? null;
      if (code !== null) throw fail(code);
      return actual.readFileSync(...args);
    }) as typeof actual.readFileSync,
  };
});

const roots: string[] = [];

afterEach(() => {
  hooks.beforeStaleRename = null;
  hooks.onPutBack = null;
  hooks.readFails = null;
  hooks.renameBackFails = null;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mist-resident-lock-takeover-"));
  roots.push(root);
  return root;
}

/** 写一把形状合法的锁；pid 给一个肯定不在的大号，就是陈锁。 */
function writeLock(root: string, holder: { pid: number; token: string }): string {
  const path = residentLockPath(root, "r-a");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 1,
      residentId: "r-a",
      pid: holder.pid,
      token: holder.token,
      startedAt: "2026-10-17T00:00:00.000Z",
    }),
  );
  return path;
}

const DEAD_PID = 2 ** 22 + 12_345;
const tokenAt = (path: string): string =>
  (JSON.parse(readFileSync(path, "utf8")) as { token: string }).token;

function refusalOf(action: () => void): ResidentHostLockError {
  try {
    action();
  } catch (error) {
    if (error instanceof ResidentHostLockError) return error;
    throw error;
  }
  throw new Error("预期被拒却拿到了锁");
}

describe("ResidentHostLocks：三个进程抢同一把陈锁（挪走与放回之间的空档）", () => {
  it("第三个进程在空档里建上新锁：抢的一边认输；被挤掉的 B 下一回合核对令牌时停下，C 照常", () => {
    const root = tempRoot();
    const path = writeLock(root, { pid: DEAD_PID, token: "stale" });
    const a = new ResidentHostLocks(root);
    const b = new ResidentHostLocks(root);
    const c = new ResidentHostLocks(root);
    // A 判过陈锁、正要挪走时，B 先接管成功；A 挪走的其实是 B 的新锁。
    hooks.beforeStaleRename = () => b.acquire("r-a");
    // A 发现挪错了、放回之前，C 在空着的锁路径上建锁。
    hooks.onPutBack = () => c.acquire("r-a");
    expect(refusalOf(() => a.acquire("r-a")).message).toMatch(/正在另一个 mist 进程/);
    const cToken = tokenAt(path);
    expect(cToken).not.toBe("stale");

    expect(refusalOf(() => b.acquire("r-a")).message).toMatch(/已被接管或删除/);
    expect(() => c.acquire("r-a")).not.toThrow();
    expect(tokenAt(path)).toBe(cToken);
    expect(readdirSync(dirname(path))).toEqual(["r-a.lock"]);
  });

  it("放回时出 EEXIST 以外的错：照实报错，不冒充别人拿着；被挪走的 B 下一回合停下", () => {
    const root = tempRoot();
    const path = writeLock(root, { pid: DEAD_PID, token: "stale" });
    const a = new ResidentHostLocks(root);
    const b = new ResidentHostLocks(root);
    hooks.beforeStaleRename = () => b.acquire("r-a");
    hooks.onPutBack = () => {
      throw Object.assign(new Error("EIO: simulated"), { code: "EIO" });
    };
    const refused = refusalOf(() => a.acquire("r-a"));
    expect(refused.message).toMatch(/放回时出错（EIO）/);
    expect(refused.message).not.toMatch(/正在另一个 mist 进程/);
    expect(refused.remedy).toContain(path);
    expect(refusalOf(() => b.acquire("r-a")).message).toMatch(/已被接管或删除/);
    // 没人拿着，也没留下改名的残档；之后正常起的进程拿得到。
    expect(readdirSync(dirname(path))).toEqual([]);
    expect(() => new ResidentHostLocks(root).acquire("r-a")).not.toThrow();
  });
});

describe("ResidentHostLocks：锁文件读不出就拒绝，不当坏锁抢", () => {
  it.each(["EIO", "EMFILE", "EACCES"])(
    "锁文件在、读它抛 %s（挪走后再读也抛）：拒绝并给出锁路径，锁原样留着",
    (code) => {
      const root = tempRoot();
      const path = writeLock(root, { pid: process.pid, token: "unverifiable" });
      hooks.readFails = (target) => (target.includes("r-a.lock") ? code : null);
      const refused = refusalOf(() => new ResidentHostLocks(root).acquire("r-a"));
      expect(refused.message).toContain(`读不出（${code}）`);
      expect(refused.remedy).toContain(path);
      hooks.readFails = null;
      expect(readdirSync(dirname(path))).toEqual(["r-a.lock"]);
      expect(tokenAt(path)).toBe("unverifiable");
    },
  );

  it("坏锁挪走后再读读不出：不算核对通过，放回原样并认输", () => {
    const root = tempRoot();
    const path = residentLockPath(root, "r-a");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "garbage");
    hooks.readFails = (target) => (target.includes(".stale-") ? "EIO" : null);
    refusalOf(() => new ResidentHostLocks(root).acquire("r-a"));
    hooks.readFails = null;
    expect(readdirSync(dirname(path))).toEqual(["r-a.lock"]);
    expect(readFileSync(path, "utf8")).toBe("garbage");
  });

  it("拿着的锁每回合核对时读不出：停下，不当作还拿着", () => {
    const root = tempRoot();
    const locks = new ResidentHostLocks(root);
    locks.acquire("r-a");
    hooks.readFails = (target) => (target.endsWith("r-a.lock") ? "EIO" : null);
    expect(refusalOf(() => locks.acquire("r-a")).message).toContain("读不出（EIO）");
  });
});

describe("ResidentHostLocks：判过陈锁之后锁路径变成非文件（绝不递归删除）", () => {
  /** 判过陈锁、正要挪走时，锁路径被换成一个装着东西的目录。 */
  function directoryRacesIn(path: string): void {
    hooks.beforeStaleRename = () => {
      rmSync(path);
      mkdirSync(join(path, "nested"), { recursive: true });
      writeFileSync(join(path, "nested", "keep.txt"), "别人的东西");
    };
  }

  it("挪走的是目录：原样挪回锁路径，里面的东西一样不少；拒绝并说那不是 mist 的锁", () => {
    const root = tempRoot();
    const path = writeLock(root, { pid: DEAD_PID, token: "stale" });
    directoryRacesIn(path);
    const refused = refusalOf(() => new ResidentHostLocks(root).acquire("r-a"));
    expect(statSync(path).isDirectory()).toBe(true);
    expect(readFileSync(join(path, "nested", "keep.txt"), "utf8")).toBe("别人的东西");
    expect(refused.message).toContain("不是 mist 锁");
    expect(refused.remedy).toContain(path);
    expect(readdirSync(dirname(path))).toEqual(["r-a.lock"]);
  });

  it("挪不回去：留在旁名、东西不少，报错里给出旁名", () => {
    const root = tempRoot();
    const path = writeLock(root, { pid: DEAD_PID, token: "stale" });
    directoryRacesIn(path);
    hooks.renameBackFails = "EXDEV";
    const refused = refusalOf(() => new ResidentHostLocks(root).acquire("r-a"));
    hooks.renameBackFails = null;
    const [aside, ...rest] = readdirSync(dirname(path));
    expect(rest).toEqual([]);
    expect(aside).toMatch(/^r-a\.lock\.stale-/);
    const asidePath = join(dirname(path), aside ?? "");
    expect(refused.message).toContain(asidePath);
    expect(refused.message).toContain("EXDEV");
    expect(refused.remedy).toContain(asidePath);
    expect(readFileSync(join(asidePath, "nested", "keep.txt"), "utf8")).toBe("别人的东西");
  });
});

describe("ResidentHostLocks.stillHolds", () => {
  it("锁文件读不出就不算还拿着", () => {
    const root = tempRoot();
    const locks = new ResidentHostLocks(root);
    locks.acquire("r-a");
    expect(locks.stillHolds("r-a")).toBe(true);
    hooks.readFails = (target) => (target.endsWith("r-a.lock") ? "EIO" : null);
    expect(locks.stillHolds("r-a")).toBe(false);
  });
});
