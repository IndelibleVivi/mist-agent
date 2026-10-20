/**
 * #234 暂停记录的落盘与认领：形状、0600、只用一次、坏记录当没有，以及多个真进程同时认领
 * 同一笔时恰好一边拿到（运行时级的接回与猝死见 resident-runtime.test.ts，跨宿主见 RT-09）。
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
import { PauseRecordStore, pauseRecordPath } from "../src/resident-runtime/pause-records.ts";

const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mist-pause-records-"));
  roots.push(root);
  return root;
}

const paused = {
  residentId: "r-a",
  windowId: "w_01JABCDEFGHJKMNPQRSTVWXYZ0",
  scopeId: "private",
  scopeGeneration: 1,
  generation: 3,
  pausedAt: "2026-10-17T00:00:00.000Z",
};

describe("PauseRecordStore（#234）", () => {
  it("落在 sessions/paused/<residentId>.json、0600；认领一次拿到原样记录，第二次就没有了", () => {
    const root = tempRoot();
    const store = new PauseRecordStore(root);
    store.write(paused);
    const path = join(root, "sessions", "paused", "r-a.json");
    expect(pauseRecordPath(root, "r-a")).toBe(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ schemaVersion: 1, ...paused });

    expect(store.claim("r-a")).toEqual({ schemaVersion: 1, ...paused });
    expect(readdirSync(dirname(path))).toEqual([]);
    expect(store.claim("r-a")).toBeNull();
    expect(new PauseRecordStore(root).claim("r-b")).toBeNull();
  });

  it.each([
    ["截断", (raw: string) => raw.slice(0, 20)],
    ["不是 JSON", () => "\u0000\u0001garbage"],
    ["多带字段", (raw: string) => JSON.stringify({ ...JSON.parse(raw), extra: true })],
    ["少字段", (raw: string) => JSON.stringify({ ...JSON.parse(raw), pausedAt: undefined })],
    ["别的住户", (raw: string) => JSON.stringify({ ...JSON.parse(raw), residentId: "r-b" })],
    ["代际不是正整数", (raw: string) => JSON.stringify({ ...JSON.parse(raw), generation: 0 })],
    ["schema 不认识", (raw: string) => JSON.stringify({ ...JSON.parse(raw), schemaVersion: 2 })],
  ])("坏记录（%s）认领成 null，照样删掉", (_label, damage) => {
    const root = tempRoot();
    const store = new PauseRecordStore(root);
    store.write(paused);
    const path = pauseRecordPath(root, "r-a");
    writeFileSync(path, damage(readFileSync(path, "utf8")));
    expect(store.claim("r-a")).toBeNull();
    expect(readdirSync(dirname(path))).toEqual([]);
  });

  it("记录位置被目录占住：认领成 null 并清掉；写入失败显式抛错", () => {
    const root = tempRoot();
    const store = new PauseRecordStore(root);
    mkdirSync(join(pauseRecordPath(root, "r-a"), "occupied"), { recursive: true });
    expect(() => store.write(paused)).toThrow();
    expect(store.claim("r-a")).toBeNull();
    expect(readdirSync(join(root, "sessions", "paused"))).toEqual([]);
  });

  it("住户号先过文件名闸，才拼路径", () => {
    const root = tempRoot();
    const store = new PauseRecordStore(root);
    expect(() => pauseRecordPath(root, "../escape")).toThrow(/不可作为文件名/);
    expect(() => store.write({ ...paused, residentId: "../escape" })).toThrow(/不可作为文件名/);
    expect(() => store.claim("A/B")).toThrow(/不可作为文件名/);
  });

  it("多个真进程同时认领同一笔：恰好一个拿到，记录不留", async () => {
    const root = tempRoot();
    new PauseRecordStore(root).write(paused);
    const moduleUrl = pathToFileURL(
      fileURLToPath(new URL("../src/resident-runtime/pause-records.ts", import.meta.url)),
    ).href;
    // 每个子进程起好后报 ready，等父进程同一时刻发 go 再认领，把认领那一下真撞在一起。
    const claimer = [
      `import { PauseRecordStore } from ${JSON.stringify(moduleUrl)};`,
      "const store = new PauseRecordStore(process.env.PAUSE_RECORD_ROOT);",
      'process.on("message", (message) => {',
      '  if (message !== "go") return;',
      '  const record = store.claim("r-a");',
      "  process.send({ claimed: record === null ? null : record.generation }, () => process.disconnect());",
      "});",
      "process.send({ ready: true });",
    ].join("\n");
    const contenders = Array.from({ length: 6 }, () => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", claimer],
        {
          env: { ...process.env, PAUSE_RECORD_ROOT: root },
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        },
      );
      children.push(child);
      return child;
    });
    const outcome = (child: ChildProcess, key: "ready" | "claimed"): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const onMessage = (message: unknown): void => {
          if (typeof message !== "object" || message === null || !(key in message)) return;
          child.off("message", onMessage);
          resolve((message as Record<string, unknown>)[key]);
        };
        child.on("message", onMessage);
        child.once("exit", (code) => reject(new Error(`claimer exited ${String(code)} early`)));
      });
    await Promise.all(contenders.map((child) => outcome(child, "ready")));
    const claims = contenders.map((child) => outcome(child, "claimed"));
    for (const child of contenders) child.send("go");
    const results = await Promise.all(claims);
    expect(results.filter((generation) => generation === paused.generation)).toHaveLength(1);
    expect(results.filter((generation) => generation === null)).toHaveLength(5);
    expect(readdirSync(join(root, "sessions", "paused"))).toEqual([]);
  }, 30_000);
});
