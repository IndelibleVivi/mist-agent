import { spawn } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ROOM_RECORDED_CLAIM,
  RoomEventStore,
  RoomOperationConflictError,
} from "../../src/group-chat/room-event-store.ts";

const roots: string[] = [];
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  readonly DatabaseSync: new (
    location: string,
  ) => {
    exec(sql: string): void;
    prepare(sql: string): { run(...parameters: (string | number)[]): unknown };
    close(): void;
  };
};

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mist-room-events-"));
  roots.push(root);
  return root;
}

function appendInput(overrides: Partial<Parameters<RoomEventStore["append"]>[0]> = {}) {
  return {
    operationId: "operation-1",
    roomId: "room-a",
    principalId: "resident-a",
    authorId: "resident-a",
    body: "hello",
    visibility: "public" as const,
    requestSemantics: JSON.stringify({ body: "hello", roomId: "room-a" }),
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("RoomEventStore", () => {
  it("keeps the event, per-room position and recorded receipt durable together", async () => {
    const root = await makeRoot();
    const first = new RoomEventStore(root);
    const appended = first.append({ ...appendInput(), recordedClaim: ROOM_RECORDED_CLAIM });
    first.close();

    const reopened = new RoomEventStore(root);
    expect(reopened.readRoomEvents()).toEqual([appended.event]);
    expect(reopened.readSystemReceipts()).toEqual([
      {
        actor: "system",
        phase: "recorded",
        roomEventId: appended.event.id,
        claim: "房间已记录",
      },
    ]);
    expect(appended.receipt?.roomEventId).toBe(appended.event.id);
    expect(appended.event.position).toBe(1);
    reopened.close();
  });

  it("returns the original event for an identical operation retry and rejects changed semantics", async () => {
    const store = new RoomEventStore(await makeRoot());
    const original = store.append({ ...appendInput(), recordedClaim: ROOM_RECORDED_CLAIM });
    const replay = store.append({ ...appendInput(), recordedClaim: ROOM_RECORDED_CLAIM });

    expect(replay).toEqual({ ...original, replayed: true });
    expect(() =>
      store.append({
        ...appendInput({ body: "changed", requestSemantics: JSON.stringify({ body: "changed" }) }),
        recordedClaim: ROOM_RECORDED_CLAIM,
      }),
    ).toThrow(RoomOperationConflictError);
    expect(store.readRoomEvents()).toHaveLength(1);
    expect(store.readSystemReceipts()).toHaveLength(1);
    store.close();
  });

  it("rejects replay when the original operation had no receipt claim", async () => {
    const store = new RoomEventStore(await makeRoot());
    const original = store.append(appendInput());

    expect(original.receipt).toBeNull();
    expect(() => store.append({ ...appendInput(), recordedClaim: ROOM_RECORDED_CLAIM })).toThrow(
      /already used/,
    );
    expect(store.readRoomEvents()).toHaveLength(1);
    expect(store.readSystemReceipts()).toHaveLength(0);
    store.close();
  });

  it("migrates the existing v1 ledger without losing records or inventing mentions", async () => {
    const root = await makeRoot();
    const legacy = new DatabaseSync(join(root, "room-events.sqlite"));
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE room_events (
        id TEXT PRIMARY KEY NOT NULL,
        operation_id TEXT UNIQUE NOT NULL,
        room_id TEXT NOT NULL,
        position INTEGER NOT NULL CHECK (position > 0),
        principal_id TEXT NOT NULL,
        author_id TEXT NOT NULL,
        body TEXT NOT NULL,
        visibility TEXT NOT NULL CHECK (visibility IN ('public', 'hidden')),
        request_semantics TEXT NOT NULL,
        UNIQUE (room_id, position)
      ) STRICT;
      CREATE TABLE room_heads (
        room_id TEXT PRIMARY KEY NOT NULL,
        last_position INTEGER NOT NULL CHECK (last_position > 0)
      ) STRICT;
      CREATE TABLE room_system_receipts (
        event_id TEXT PRIMARY KEY NOT NULL REFERENCES room_events(id),
        actor TEXT NOT NULL CHECK (actor = 'system'),
        phase TEXT NOT NULL CHECK (phase = 'recorded'),
        claim TEXT NOT NULL
      ) STRICT;
    `);
    legacy
      .prepare(
        `INSERT INTO room_events
          (id, operation_id, room_id, position, principal_id, author_id, body, visibility, request_semantics)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "legacy-event",
        "legacy-operation",
        "room-a",
        1,
        "resident-a",
        "resident-a",
        "legacy",
        "public",
        "legacy",
      );
    legacy
      .prepare("INSERT INTO room_heads (room_id, last_position) VALUES (?, ?)")
      .run("room-a", 1);
    legacy
      .prepare(
        "INSERT INTO room_system_receipts (event_id, actor, phase, claim) VALUES (?, ?, ?, ?)",
      )
      .run("legacy-event", "system", "recorded", "房间已记录");
    legacy.exec("PRAGMA user_version = 1");
    legacy.close();

    const migrated = new RoomEventStore(root);
    expect(migrated.readRoomEvents()).toEqual([
      {
        id: "legacy-event",
        roomId: "room-a",
        position: 1,
        principalId: "resident-a",
        authorId: "resident-a",
        body: "legacy",
        visibility: "public",
        mentions: [],
      },
    ]);
    expect(migrated.readSystemReceipts()).toEqual([
      {
        actor: "system",
        phase: "recorded",
        roomEventId: "legacy-event",
        claim: "房间已记录",
      },
    ]);
    const next = migrated.append(
      appendInput({
        operationId: "after-migration",
        mentions: ["resident-b"],
        requestSemantics: "mentions-after-migration",
      }),
    );
    expect(next.event.mentions).toEqual(["resident-b"]);
    migrated.close();
  });

  it("allocates positions independently for each room", async () => {
    const store = new RoomEventStore(await makeRoot());
    const firstA = store.append(appendInput());
    const firstB = store.append(
      appendInput({
        operationId: "operation-2",
        roomId: "room-b",
        requestSemantics: JSON.stringify({ roomId: "room-b" }),
      }),
    );
    const secondA = store.append(
      appendInput({ operationId: "operation-3", requestSemantics: "second" }),
    );

    expect([firstA.event.position, firstB.event.position, secondA.event.position]).toEqual([
      1, 1, 2,
    ]);
    store.close();
  });

  it("serializes position allocation across independent host processes", async () => {
    const root = await makeRoot();
    const initialize = new RoomEventStore(root);
    initialize.close();

    const worker = fileURLToPath(new URL("./room-event-store-worker.ts", import.meta.url));
    const writers = ["writer-a", "writer-b"].map((writer) => runWriter(worker, root, writer));
    await Promise.all([
      waitForFile(join(root, "writer-a.ready")),
      waitForFile(join(root, "writer-b.ready")),
    ]);
    await writeFile(join(root, "start"), "go", { flag: "wx" });
    await Promise.all(writers);

    const reader = new RoomEventStore(root);
    const events = reader.readRoomEvents("shared-room");
    const positions = events.map((event) => event.position).sort((left, right) => left - right);
    expect(events).toHaveLength(128);
    expect(positions).toEqual(Array.from({ length: 128 }, (_, index) => index + 1));
    expect(new Set(events.map((event) => event.id)).size).toBe(128);
    reader.close();
  }, 20_000);

  it("waits for an external SQLite writer lock and commits after it is released", async () => {
    const root = await makeRoot();
    const initialize = new RoomEventStore(root);
    initialize.close();

    const writerId = "locked-writer";
    const worker = fileURLToPath(new URL("./room-event-store-worker.ts", import.meta.url));
    const writer = runWriter(worker, root, writerId);
    await waitForFile(join(root, `${writerId}.ready`));

    const blocker = new DatabaseSync(join(root, "room-events.sqlite"));
    blocker.exec("PRAGMA busy_timeout = 10000; BEGIN IMMEDIATE");
    try {
      await writeFile(join(root, "start"), "go", { flag: "wx" });
      await waitForFile(join(root, `${writerId}.attempting`));
      await new Promise((resolve) => setTimeout(resolve, 100));

      await expect(access(join(root, `${writerId}.done`))).rejects.toThrow();
      blocker.exec("COMMIT");
      await writer;
      await expect(access(join(root, `${writerId}.done`))).resolves.toBeUndefined();
    } finally {
      try {
        blocker.exec("ROLLBACK");
      } catch {
        // The successful path has already committed the lock transaction.
      }
      blocker.close();
      await writer.catch(() => undefined);
    }

    const reader = new RoomEventStore(root);
    expect(reader.readRoomEvents("shared-room")).toHaveLength(64);
    reader.close();
  }, 20_000);
});

function runWriter(worker: string, root: string, writerId: string): Promise<void> {
  const child = spawn(process.execPath, ["--import", "tsx", worker, root, writerId], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `room-event writer ${writerId} exited ${String(code)}/${String(signal)}: ${stderr}`,
          ),
        );
    });
  });
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`timed out waiting for concurrent writer file: ${path}`);
}
