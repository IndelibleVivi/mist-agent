import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  readonly DatabaseSync: new (location: string) => DatabaseSyncType;
};

export const ROOM_RECORDED_CLAIM = "房间已记录";

export interface RoomEvent {
  readonly id: string;
  readonly roomId: string;
  readonly position: number;
  readonly principalId: string;
  readonly authorId: string;
  readonly body: string;
  readonly visibility: "public" | "hidden";
  readonly mentions: readonly string[];
}

export interface RoomRecordedReceipt {
  readonly actor: "system";
  readonly phase: "recorded";
  readonly roomEventId: string;
  readonly claim: string;
}

export interface RoomEventAppend {
  readonly operationId: string;
  readonly roomId: string;
  readonly principalId: string;
  readonly authorId: string;
  readonly body: string;
  readonly visibility: "public" | "hidden";
  readonly mentions?: readonly string[];
  /** Stable serialization of the full accepted request, used to detect operation-id reuse. */
  readonly requestSemantics: string;
  /** When supplied, event and system receipt are committed in the same SQLite transaction. */
  readonly recordedClaim?: string;
}

export interface RoomEventAppendResult {
  readonly event: RoomEvent;
  readonly receipt: RoomRecordedReceipt | null;
  readonly replayed: boolean;
}

interface RoomEventRow {
  readonly id: string;
  readonly room_id: string;
  readonly position: number;
  readonly principal_id: string;
  readonly author_id: string;
  readonly body: string;
  readonly visibility: "public" | "hidden";
  readonly mentions_json: string;
  readonly request_semantics: string;
}

interface RoomReceiptRow {
  readonly event_id: string;
  readonly actor: "system";
  readonly phase: "recorded";
  readonly claim: string;
}

export class RoomOperationConflictError extends Error {
  override readonly name = "RoomOperationConflictError";

  constructor(readonly operationId: string) {
    super(`operation id was already used with different room-message semantics: ${operationId}`);
  }
}

/**
 * The room stream's single durable writer. SQLite's IMMEDIATE transaction serializes writers
 * across host processes, so position allocation and append cannot split into separate races.
 * This store is internal: authorization belongs to postRoomMessage before append is called.
 */
export class RoomEventStore {
  readonly #databasePath: string;
  readonly #database: DatabaseSyncType;

  constructor(dataRoot: string) {
    const resolvedRoot = resolve(dataRoot);
    mkdirSync(resolvedRoot, { recursive: true, mode: 0o700 });
    this.#databasePath = join(resolvedRoot, "room-events.sqlite");
    this.#database = new DatabaseSync(this.#databasePath);
    this.#database.exec("PRAGMA busy_timeout = 10000");
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec("PRAGMA synchronous = FULL");
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#initializeSchema();
    chmodSync(this.#databasePath, 0o600);
  }

  append(input: RoomEventAppend): RoomEventAppendResult {
    const appended = this.#append(input);
    if (appended === null) throw new Error("unconditional room-event append was denied");
    return appended;
  }

  /**
   * Replay an identical durable operation before consulting volatile grants. A genuinely new
   * operation must pass the supplied authorization while this store holds its writer lock.
   */
  appendIfNewAuthorized(
    input: RoomEventAppend,
    authorizeNew: () => boolean,
  ): RoomEventAppendResult | null {
    return this.#append(input, authorizeNew);
  }

  #append(input: RoomEventAppend, authorizeNew?: () => boolean): RoomEventAppendResult | null {
    if (!this.#database.isOpen) throw new Error("room event store is closed");

    let inTransaction = false;
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      inTransaction = true;

      const existing = this.#database
        .prepare(
          `SELECT id, room_id, position, principal_id, author_id, body, visibility, mentions_json, request_semantics
           FROM room_events WHERE operation_id = ?`,
        )
        .get(input.operationId) as RoomEventRow | undefined;

      if (existing !== undefined) {
        const receiptRow = this.#readReceiptRow(existing.id);
        if (
          existing.request_semantics !== input.requestSemantics ||
          (receiptRow?.claim ?? null) !== (input.recordedClaim ?? null)
        ) {
          throw new RoomOperationConflictError(input.operationId);
        }
        this.#database.exec("COMMIT");
        inTransaction = false;
        return {
          event: eventFromRow(existing),
          receipt: receiptRow === undefined ? null : receiptFromRow(receiptRow),
          replayed: true,
        };
      }

      if (authorizeNew !== undefined && !authorizeNew()) {
        this.#database.exec("COMMIT");
        inTransaction = false;
        return null;
      }

      const currentHead = this.#database
        .prepare("SELECT last_position FROM room_heads WHERE room_id = ?")
        .get(input.roomId) as { readonly last_position: number } | undefined;
      const position = (currentHead?.last_position ?? 0) + 1;
      const mentions = [...(input.mentions ?? [])];
      const event: RoomEvent = {
        id: randomUUID(),
        roomId: input.roomId,
        position,
        principalId: input.principalId,
        authorId: input.authorId,
        body: input.body,
        visibility: input.visibility,
        mentions,
      };

      this.#database
        .prepare(
          `INSERT INTO room_events
            (id, operation_id, room_id, position, principal_id, author_id, body, visibility, mentions_json, request_semantics)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.id,
          input.operationId,
          event.roomId,
          event.position,
          event.principalId,
          event.authorId,
          event.body,
          event.visibility,
          JSON.stringify(event.mentions),
          input.requestSemantics,
        );
      this.#database
        .prepare(
          `INSERT INTO room_heads (room_id, last_position) VALUES (?, ?)
           ON CONFLICT(room_id) DO UPDATE SET last_position = excluded.last_position`,
        )
        .run(event.roomId, event.position);

      let receipt: RoomRecordedReceipt | null = null;
      if (input.recordedClaim !== undefined) {
        this.#database
          .prepare(
            `INSERT INTO room_system_receipts (event_id, actor, phase, claim)
             VALUES (?, 'system', 'recorded', ?)`,
          )
          .run(event.id, input.recordedClaim);
        receipt = {
          actor: "system",
          phase: "recorded",
          roomEventId: event.id,
          claim: input.recordedClaim,
        };
      }

      this.#database.exec("COMMIT");
      inTransaction = false;
      return { event, receipt, replayed: false };
    } catch (error) {
      if (inTransaction) {
        try {
          this.#database.exec("ROLLBACK");
        } catch {
          // Preserve the original transaction error.
        }
      }
      throw error;
    }
  }

  readRoomEvents(roomId?: string): readonly RoomEvent[] {
    if (!this.#database.isOpen) throw new Error("room event store is closed");
    const rows = (roomId === undefined
      ? this.#database
          .prepare(
            `SELECT id, room_id, position, principal_id, author_id, body, visibility, mentions_json, request_semantics
               FROM room_events ORDER BY room_id, position`,
          )
          .all()
      : this.#database
          .prepare(
            `SELECT id, room_id, position, principal_id, author_id, body, visibility, mentions_json, request_semantics
               FROM room_events WHERE room_id = ? ORDER BY position`,
          )
          .all(roomId)) as unknown as RoomEventRow[];
    return rows.map(eventFromRow);
  }

  readSystemReceipts(): readonly RoomRecordedReceipt[] {
    if (!this.#database.isOpen) throw new Error("room event store is closed");
    const rows = this.#database
      .prepare(
        `SELECT receipt.event_id, receipt.actor, receipt.phase, receipt.claim
         FROM room_system_receipts AS receipt
         JOIN room_events AS event ON event.id = receipt.event_id
         ORDER BY event.room_id, event.position`,
      )
      .all() as unknown as RoomReceiptRow[];
    return rows.map(receiptFromRow);
  }

  close(): void {
    if (this.#database.isOpen) this.#database.close();
  }

  #readReceiptRow(eventId: string): RoomReceiptRow | undefined {
    return this.#database
      .prepare("SELECT event_id, actor, phase, claim FROM room_system_receipts WHERE event_id = ?")
      .get(eventId) as RoomReceiptRow | undefined;
  }

  #initializeSchema(): void {
    const versionRow = this.#database.prepare("PRAGMA user_version").get() as
      | { readonly user_version: number }
      | undefined;
    const version = versionRow?.user_version ?? 0;
    if (version > 2) throw new Error(`unsupported room-event schema version: ${version}`);

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const lockedVersionRow = this.#database.prepare("PRAGMA user_version").get() as
        | { readonly user_version: number }
        | undefined;
      const lockedVersion = lockedVersionRow?.user_version ?? 0;
      if (lockedVersion > 2)
        throw new Error(`unsupported room-event schema version: ${lockedVersion}`);
      if (lockedVersion === 1) {
        this.#database.exec(
          "ALTER TABLE room_events ADD COLUMN mentions_json TEXT NOT NULL DEFAULT '[]'",
        );
        this.#database.exec("PRAGMA user_version = 2");
      } else if (lockedVersion === 0) {
        this.#database.exec(`
          CREATE TABLE IF NOT EXISTS room_events (
            id TEXT PRIMARY KEY NOT NULL,
            operation_id TEXT UNIQUE NOT NULL,
            room_id TEXT NOT NULL,
            position INTEGER NOT NULL CHECK (position > 0),
            principal_id TEXT NOT NULL,
            author_id TEXT NOT NULL,
            body TEXT NOT NULL,
            visibility TEXT NOT NULL CHECK (visibility IN ('public', 'hidden')),
            mentions_json TEXT NOT NULL DEFAULT '[]',
            request_semantics TEXT NOT NULL,
            UNIQUE (room_id, position)
          ) STRICT;
          CREATE TABLE IF NOT EXISTS room_heads (
            room_id TEXT PRIMARY KEY NOT NULL,
            last_position INTEGER NOT NULL CHECK (last_position > 0)
          ) STRICT;
          CREATE TABLE IF NOT EXISTS room_system_receipts (
            event_id TEXT PRIMARY KEY NOT NULL REFERENCES room_events(id),
            actor TEXT NOT NULL CHECK (actor = 'system'),
            phase TEXT NOT NULL CHECK (phase = 'recorded'),
            claim TEXT NOT NULL
          ) STRICT;
          CREATE INDEX IF NOT EXISTS room_events_room_position
            ON room_events (room_id, position);
          PRAGMA user_version = 2;
        `);
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        // Preserve the original schema error.
      }
      throw error;
    }
  }
}

function eventFromRow(row: RoomEventRow): RoomEvent {
  return {
    id: row.id,
    roomId: row.room_id,
    position: row.position,
    principalId: row.principal_id,
    authorId: row.author_id,
    body: row.body,
    visibility: row.visibility,
    mentions: parseMentions(row.mentions_json),
  };
}

function receiptFromRow(row: RoomReceiptRow): RoomRecordedReceipt {
  return {
    actor: row.actor,
    phase: row.phase,
    roomEventId: row.event_id,
    claim: row.claim,
  };
}

function parseMentions(serialized: string): readonly string[] {
  const parsed: unknown = JSON.parse(serialized);
  if (!Array.isArray(parsed) || parsed.some((mention) => typeof mention !== "string"))
    throw new Error("room-event mentions are not a string array");
  return parsed;
}
