/**
 * 住户宿主锁（D9 一流一写方，#234 并发两宿主）：落盘形状、活进程拒绝、死进程／本进程／坏锁
 * 接管、只放自己的锁、关了不再拿，以及多个真进程同时抢（无锁与陈锁两种起点）恰好一边拿到。
 * 运行时的拒绝面见 resident-runtime.test.ts，跨宿主见 resident-runtime-host-boundary.test.ts。
 */
import { type ChildProcess, spawn } from "node:child_process";
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
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ResidentHostLockError,
  ResidentHostLocks,
  residentLockPath,
} from "../src/resident-runtime/resident-lock.ts";

const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mist-resident-lock-"));
  roots.push(root);
  return root;
}

interface LockFile {
  schemaVersion: number;
  residentId: string;
  pid: number;
  token: string;
  startedAt: string;
}

const readLock = (root: string, residentId = "r-a"): LockFile =>
  JSON.parse(readFileSync(residentLockPath(root, residentId), "utf8")) as LockFile;

function writeLock(root: string, holder: Partial<LockFile>, residentId = "r-a"): void {
  const path = residentLockPath(root, residentId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 1,
      residentId,
      pid: process.pid,
      token: "someone-else",
      startedAt: "2026-10-17T00:00:00.000Z",
      ...holder,
    }),
  );
}

/** 一个活着的别的进程：测完由 afterEach 杀掉。 */
function liveProcess(): number {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  children.push(child);
  if (child.pid === undefined) throw new Error("夹具：活进程没起来");
  return child.pid;
}

/** 一个已经退出（且已回收）的进程号。 */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  if (pid === undefined) throw new Error("夹具：进程没起来");
  return pid;
}

describe("ResidentHostLocks", () => {
  it("落在 sessions/active/<residentId>.lock、0600，带 pid、令牌与起锁时刻；重复拿不换令牌，放了就没有", () => {
    const root = tempRoot();
    const locks = new ResidentHostLocks(root);
    locks.acquire("r-a");
    const path = join(root, "sessions", "active", "r-a.lock");
    expect(residentLockPath(root, "r-a")).toBe(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const held = readLock(root);
    expect(held).toEqual({
      schemaVersion: 1,
      residentId: "r-a",
      pid: process.pid,
      token: expect.any(String),
      startedAt: expect.any(String),
    });
    locks.acquire("r-a");
    expect(readLock(root).token).toBe(held.token);
    expect(readdirSync(dirname(path))).toEqual(["r-a.lock"]);

    locks.releaseAll();
    expect(readdirSync(dirname(path))).toEqual([]);
    locks.releaseAll();
    expect(() => locks.acquire("r-a")).toThrow(ResidentHostLockError);
    expect(readdirSync(dirname(path))).toEqual([]);
  });

  it("锁在别的活进程手里：拒绝，报出 pid 与锁文件，锁原样不动", () => {
    const root = tempRoot();
    const pid = liveProcess();
    writeLock(root, { pid });
    const before = readFileSync(residentLockPath(root, "r-a"), "utf8");
    let refused: unknown;
    try {
      new ResidentHostLocks(root).acquire("r-a");
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(ResidentHostLockError);
    const error = refused as ResidentHostLockError;
    expect(error.message).toContain(`pid ${pid}`);
    expect(error.remedy).toContain(residentLockPath(root, "r-a"));
    expect(readFileSync(residentLockPath(root, "r-a"), "utf8")).toBe(before);
    // 别的住户不受影响。
    new ResidentHostLocks(root).acquire("r-b");
  });

  it("持有进程已死、或就是本进程：接管成本进程的新锁", async () => {
    for (const pid of [await deadPid(), process.pid]) {
      const root = tempRoot();
      writeLock(root, { pid });
      new ResidentHostLocks(root).acquire("r-a");
      expect(readLock(root)).toMatchObject({ pid: process.pid });
      expect(readLock(root).token).not.toBe("someone-else");
      expect(readdirSync(dirname(residentLockPath(root, "r-a")))).toEqual(["r-a.lock"]);
    }
  });

  it.each([
    ["截断", (raw: string) => raw.slice(0, 15)],
    ["不是 JSON", () => "\u0000garbage"],
    ["空文件", () => ""],
    ["多带字段", (raw: string) => JSON.stringify({ ...JSON.parse(raw), extra: 1 })],
    ["别的住户", (raw: string) => JSON.stringify({ ...JSON.parse(raw), residentId: "r-b" })],
    ["pid 不是正整数", (raw: string) => JSON.stringify({ ...JSON.parse(raw), pid: 0 })],
    ["schema 不认识", (raw: string) => JSON.stringify({ ...JSON.parse(raw), schemaVersion: 2 })],
  ])("坏锁（%s）当陈锁接管，哪怕里面写的 pid 还活着", (_label, damage) => {
    const root = tempRoot();
    writeLock(root, { pid: liveProcess() });
    const path = residentLockPath(root, "r-a");
    writeFileSync(path, damage(readFileSync(path, "utf8")));
    new ResidentHostLocks(root).acquire("r-a");
    expect(readLock(root)).toMatchObject({ pid: process.pid, residentId: "r-a" });
    expect(readdirSync(dirname(path))).toEqual(["r-a.lock"]);
  });

  it("拿过的锁每次再用都核对令牌：被换成别人的、被删掉，都拒绝，且不自己重建", () => {
    const root = tempRoot();
    const locks = new ResidentHostLocks(root);
    locks.acquire("r-a");
    const path = residentLockPath(root, "r-a");
    writeLock(root, { pid: liveProcess(), token: "displacer" });
    expect(() => locks.acquire("r-a")).toThrow(/已被接管或删除/);
    expect(readLock(root).token).toBe("displacer");
    rmSync(path);
    let refused: unknown;
    try {
      locks.acquire("r-a");
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(ResidentHostLockError);
    expect((refused as ResidentHostLockError).message).toMatch(/已被接管或删除/);
    expect((refused as ResidentHostLockError).remedy).toContain(path);
    expect(readdirSync(dirname(path))).toEqual([]);
  });

  it("close() 之后拿过的锁也不认，releaseAll 才删文件", () => {
    const root = tempRoot();
    const locks = new ResidentHostLocks(root);
    locks.acquire("r-a");
    locks.close();
    expect(() => locks.acquire("r-a")).toThrow(/已关闭/);
    expect(() => locks.acquire("r-b")).toThrow(/已关闭/);
    expect(readdirSync(join(root, "sessions", "active"))).toEqual(["r-a.lock"]);
    locks.releaseAll();
    expect(readdirSync(join(root, "sessions", "active"))).toEqual([]);
  });

  it("锁的位置被目录占住：不是谁的锁，当陈锁接管", () => {
    const root = tempRoot();
    mkdirSync(join(residentLockPath(root, "r-a"), "occupied"), { recursive: true });
    new ResidentHostLocks(root).acquire("r-a");
    expect(readLock(root)).toMatchObject({ pid: process.pid });
  });

  it("关闭只放令牌还是自己的锁：被换掉的锁原样留下", () => {
    const root = tempRoot();
    const locks = new ResidentHostLocks(root);
    locks.acquire("r-a");
    locks.acquire("r-b");
    writeLock(root, { pid: liveProcess(), token: "taken-over" }, "r-b");
    locks.releaseAll();
    expect(readdirSync(join(root, "sessions", "active"))).toEqual(["r-b.lock"]);
    expect(readLock(root, "r-b").token).toBe("taken-over");
  });

  it("住户号先过文件名闸，才拼路径", () => {
    const root = tempRoot();
    expect(() => residentLockPath(root, "../escape")).toThrow(/不可作为文件名/);
    expect(() => new ResidentHostLocks(root).acquire("A/B")).toThrow(/不可作为文件名/);
  });

  it.each([
    ["没有锁", false],
    ["死进程留下的陈锁", true],
  ])(
    "多个真进程同时抢（%s）：恰好一个拿到，其余被拒",
    async (_label, stale) => {
      const root = tempRoot();
      if (stale) writeLock(root, { pid: await deadPid() });
      const moduleUrl = pathToFileURL(
        fileURLToPath(new URL("../src/resident-runtime/resident-lock.ts", import.meta.url)),
      ).href;
      // ready → 同一时刻 go → 报结果；拿到锁的一边要活到父进程说散场，别的进程才判得出它活着。
      const contender = [
        `import { ResidentHostLocks } from ${JSON.stringify(moduleUrl)};`,
        "const locks = new ResidentHostLocks(process.env.RESIDENT_LOCK_ROOT);",
        'process.on("message", (message) => {',
        '  if (message === "exit") { process.disconnect(); return; }',
        '  if (message !== "go") return;',
        "  let outcome;",
        '  try { locks.acquire("r-a"); outcome = "acquired"; }',
        "  catch (error) { outcome = error.name; }",
        "  process.send({ outcome });",
        "});",
        "process.send({ ready: true });",
      ].join("\n");
      const contenders = Array.from({ length: 6 }, () => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "-e", contender],
          {
            env: { ...process.env, RESIDENT_LOCK_ROOT: root },
            stdio: ["ignore", "ignore", "pipe", "ipc"],
          },
        );
        children.push(child);
        return child;
      });
      const reply = (child: ChildProcess, key: "ready" | "outcome"): Promise<unknown> =>
        new Promise((resolve, reject) => {
          const onMessage = (message: unknown): void => {
            if (typeof message !== "object" || message === null || !(key in message)) return;
            child.off("message", onMessage);
            resolve((message as Record<string, unknown>)[key]);
          };
          child.on("message", onMessage);
          child.once("exit", (code) => reject(new Error(`contender exited ${String(code)} early`)));
        });
      await Promise.all(contenders.map((child) => reply(child, "ready")));
      const outcomes = contenders.map((child) => reply(child, "outcome"));
      for (const child of contenders) child.send("go");
      const results = await Promise.all(outcomes);
      expect(results.filter((outcome) => outcome === "acquired")).toHaveLength(1);
      expect(results.filter((outcome) => outcome === "ResidentHostLockError")).toHaveLength(5);
      const winner = contenders[results.indexOf("acquired")];
      expect(readLock(root).pid).toBe(winner?.pid);
      expect(readdirSync(dirname(residentLockPath(root, "r-a")))).toEqual(["r-a.lock"]);
      for (const child of contenders) child.send("exit");
    },
    30_000,
  );
});
