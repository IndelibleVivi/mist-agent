/**
 * 正常退出的「这一代暂停」记录（#234 主笔裁定 A）。
 *
 * 一位住户一份 `<dataDir>/sessions/paused/<residentId>.json`，由 `ResidentRuntime.close()`
 * 在关 writer 之前写（终端 `/exit`、stdin 结束、Ctrl-C 与宿主子进程 `stop` 都走这一条）。
 * 下次启动开窗时先**认领**：原子 rename 到本进程独有的名字，抢不到（ENOENT）就是没有；
 * 抢到的那份读完、校验完，无论结果都删掉。所以一笔记录至多被一个进程用一次——两个进程
 * 同时起，只有 rename 成功的那一边拿得到它。
 *
 * 本模块只管落盘形状与认领；对不对得上（窗号、代际、scope 是否还在）由运行时和
 * SessionRegistry 判。读不出、形状不对一律当没有（宁可忘，不冒认）。
 *
 * 写盘纪律照凭证面与安装器：临时文件 0600 → fsync → 原子 rename → fsync 目录。
 *
 * 代价：多一个目录要随 runtime 数据一起备份；写失败只能让下次启动按猝死开新一代
 * （住户忘这一次）；认领后进程恰好崩在删除之前会留下一个改了名的残档，不会被再认领，
 * 只占一点盘。
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

const PAUSE_RECORD_SCHEMA = 1;
/** 与住户档案、事实账、一窗流同一条住户号文件名闸。 */
const SAFE_RESIDENT_ID = /^[a-z0-9-]+$/;
const RECORD_KEYS = [
  "generation",
  "pausedAt",
  "residentId",
  "schemaVersion",
  "scopeGeneration",
  "scopeId",
  "windowId",
];

/** 暂停的是哪一次激活：与派发回执同一组身份字段，外加暂停时刻（只供追溯）。 */
export interface PauseRecord {
  readonly schemaVersion: typeof PAUSE_RECORD_SCHEMA;
  readonly residentId: string;
  readonly windowId: string;
  readonly scopeId: string;
  readonly scopeGeneration: number;
  readonly generation: number;
  readonly pausedAt: string;
}

function assertResidentId(residentId: string): void {
  if (typeof residentId !== "string" || !SAFE_RESIDENT_ID.test(residentId)) {
    throw new Error(`resident id 不可作为文件名: ${residentId}`);
  }
}

/** 某位住户暂停记录的落盘位置（验收夹具也从这里取，不另写一份路径）。 */
export function pauseRecordPath(dataDir: string, residentId: string): string {
  assertResidentId(residentId);
  return join(dataDir, "sessions", "paused", `${residentId}.json`);
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writePrivateFile(path: string, content: string): void {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    fchmodSync(descriptor, 0o600);
    writeSync(descriptor, content);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporaryPath, path);
    fsyncDirectory(dirname(path));
  } catch (error) {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // 保留原始写入错误。
      }
    }
    rmSync(temporaryPath, { force: true, recursive: true });
    throw error;
  }
}

function isSafeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** 读回的不可信字节 → 记录；字段集合要恰好、类型要对，否则 null（当没有）。 */
function parsePauseRecord(raw: string, residentId: string): PauseRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== RECORD_KEYS.length || keys.some((key, index) => key !== RECORD_KEYS[index])) {
    return null;
  }
  if (
    record.schemaVersion !== PAUSE_RECORD_SCHEMA ||
    record.residentId !== residentId ||
    !isNonEmptyString(record.windowId) ||
    !isNonEmptyString(record.scopeId) ||
    !isSafeCount(record.scopeGeneration) ||
    !isSafeCount(record.generation) ||
    !isNonEmptyString(record.pausedAt)
  ) {
    return null;
  }
  return {
    schemaVersion: PAUSE_RECORD_SCHEMA,
    residentId,
    windowId: record.windowId,
    scopeId: record.scopeId,
    scopeGeneration: record.scopeGeneration,
    generation: record.generation,
    pausedAt: record.pausedAt,
  };
}

export class PauseRecordStore {
  readonly #dataDir: string;

  constructor(dataDir: string) {
    this.#dataDir = dataDir;
  }

  /** 落一笔暂停（覆盖这位住户的旧记录）。失败就抛，由调用方决定怎么收。 */
  write(record: Omit<PauseRecord, "schemaVersion">): void {
    const path = pauseRecordPath(this.#dataDir, record.residentId);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const content: PauseRecord = {
      schemaVersion: PAUSE_RECORD_SCHEMA,
      residentId: record.residentId,
      windowId: record.windowId,
      scopeId: record.scopeId,
      scopeGeneration: record.scopeGeneration,
      generation: record.generation,
      pausedAt: record.pausedAt,
    };
    writePrivateFile(path, JSON.stringify(content));
  }

  /**
   * 认领并作废这位住户的暂停记录：先原子 rename 成本进程独有的名字（抢不到就是没有，
   * 另一个进程同时认领也只有一边 rename 成功），再读、再删——删除不看校验结果。
   * 没有、读不出、形状不对都返回 null；对不对得上这扇窗这一代由调用方判。
   */
  claim(residentId: string): PauseRecord | null {
    const path = pauseRecordPath(this.#dataDir, residentId);
    const claimed = `${path}.claimed-${process.pid}-${randomUUID()}`;
    try {
      renameSync(path, claimed);
    } catch {
      // ENOENT 是「没有暂停记录」；别的错（权限、路径被占）同样拿不到可信记录，按没有处理。
      return null;
    }
    try {
      return parsePauseRecord(readFileSync(claimed, "utf8"), residentId);
    } catch {
      return null;
    } finally {
      try {
        rmSync(claimed, { force: true, recursive: true });
      } catch {
        // 删不掉也只是个改过名的残档：它不叫 `<residentId>.json`，不会被再认领。
      }
    }
  }
}
