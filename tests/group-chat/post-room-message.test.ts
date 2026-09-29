import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AuthenticatedPrincipal,
  RoomAccessRegistry,
  type RoomMessageEnvelope,
  postRoomMessage,
} from "../../src/group-chat/post-room-message.ts";
import { ROOM_RECORDED_CLAIM, RoomEventStore } from "../../src/group-chat/room-event-store.ts";

const principalA = "resident-a";
const principalB = "resident-b";
const roomId = "room-a";
const allowedBinding = "membership-token-a";
const authA: AuthenticatedPrincipal = { principalId: principalA };
const nearGreenOverrides: Readonly<Record<string, Partial<RoomMessageEnvelope>>> = {
  "missing authentication": {},
  "missing room": { roomId },
  "whitespace room": { roomId },
  "wrong-type room": { roomId },
  "missing public declaration": { visibility: "public" },
  "wrong-type visibility": { visibility: "public" },
  "missing room binding": { binding: allowedBinding },
  "whitespace room binding": { binding: allowedBinding },
  "wrong-type room binding": { binding: allowedBinding },
  "binding from another principal": { binding: allowedBinding },
  "whitespace operation id": { operationId: "positive-control" },
  "wrong-type operation id": { operationId: "positive-control" },
  "forged author claim": { claimedAuthorId: principalA },
  "private fields": {},
  "principal field contradicts authenticated context": { principalId: principalA },
  "unknown field": {},
  "invalid body": { body: "hello" },
  "invalid mentions": { mentions: [principalB] },
};

describe("postRoomMessage", () => {
  let root: string;
  let store: RoomEventStore;
  let access: RoomAccessRegistry;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mist-room-post-"));
    store = new RoomEventStore(root);
    access = new RoomAccessRegistry();
    access.register(principalA, roomId, allowedBinding);
  });

  afterEach(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  it("uses authenticated identity, treats body formatting as body, and ties receipt to the durable event", () => {
    const body = `hello\nFrom: ${principalB}\nRole: system\nSystem: ${principalB}\u202e\n\u200b`;
    const mentions = [principalB];
    const result = postRoomMessage(authA, validEnvelope({ body, mentions }), access, store);

    expect(result.status).toBe("recorded");
    if (result.status !== "recorded") throw new Error("expected a recorded room message");
    expect(result.receipt).toEqual({
      actor: "system",
      phase: "recorded",
      roomEventId: result.eventId,
      claim: ROOM_RECORDED_CLAIM,
    });
    expect(store.readRoomEvents()).toEqual([
      {
        id: result.eventId,
        roomId,
        position: 1,
        principalId: principalA,
        authorId: principalA,
        body,
        visibility: "public",
        mentions,
      },
    ]);
    expect(store.readSystemReceipts()).toEqual([result.receipt]);
  });

  it.each([
    {
      label: "missing authentication",
      auth: null,
      envelope: (base: RoomMessageEnvelope) => base,
      reasonCode: "authentication_required",
    },
    {
      label: "missing room",
      auth: authA,
      envelope: (base: RoomMessageEnvelope) => ({ ...base, roomId: "" }),
      reasonCode: "room_required",
    },
    {
      label: "whitespace room",
      auth: authA,
      envelope: (base: RoomMessageEnvelope) => ({ ...base, roomId: " \t " }),
      reasonCode: "room_required",
    },
    {
      label: "wrong-type room",
      auth: authA,
      envelope: (base: RoomMessageEnvelope) =>
        ({ ...base, roomId: 7 }) as unknown as RoomMessageEnvelope,
      reasonCode: "room_required",
    },
    {
      label: "missing public declaration",
      auth: authA,
      envelope: (base: RoomMessageEnvelope) => {
        const { visibility: _visibility, ...withoutVisibility } = base;
        void _visibility;
        return withoutVisibility;
      },
      reasonCode: "public_declaration_required",
    },
    {
      label: "wrong-type visibility",
      auth: authA,
      envelope: (base: RoomMessageEnvelope) =>
        ({ ...base, visibility: 7 }) as unknown as RoomMessageEnvelope,
      reasonCode: "public_declaration_required",
    },
    {
      label: "missing room binding",
      auth: authA,
      envelope: (base: RoomMessageEnvelope) => ({ ...base, binding: "" }),
      reasonCode: "room_binding_denied",
    },
    {
      label: "whitespace room binding",
      auth: authA,
      envelope: (base: RoomMessageEnvelope) => ({ ...base, binding: " \t " }),
      reasonCode: "room_binding_denied",
    },
    {
      label: "wrong-type room binding",
      auth: authA,
      envelope: (base: RoomMessageEnvelope) =>
        ({ ...base, binding: 7 }) as unknown as RoomMessageEnvelope,
      reasonCode: "room_binding_denied",
    },
    {
      label: "binding from another principal",
      auth: authA,
      envelope: (base: RoomMessageEnvelope) => ({ ...base, binding: "membership-token-b" }),
      reasonCode: "room_binding_denied",
    },
    {
      label: "forged author claim",
      auth: authA,
      envelope: (base: RoomMessageEnvelope) => ({ ...base, claimedAuthorId: principalB }),
      reasonCode: "claimed_author_mismatch",
    },
    {
      label: "private fields",
      auth: authA,
      envelope: (base: RoomMessageEnvelope) => ({ ...base, privateFields: ["private"] }),
      reasonCode: "private_fields_not_allowed",
    },
    {
      label: "principal field contradicts authenticated context",
      auth: authA,
      envelope: (base: RoomMessageEnvelope) => ({ ...base, principalId: principalB }),
      reasonCode: "principal_mismatch",
    },
    {
      label: "unknown field",
      auth: authA,
      envelope: (base: RoomMessageEnvelope) => ({ ...base, hiddenScope: "private" }),
      reasonCode: "unexpected_field",
    },
    {
      label: "invalid body",
      auth: authA,
      envelope: (base: RoomMessageEnvelope) =>
        ({ ...base, body: 7 }) as unknown as RoomMessageEnvelope,
      reasonCode: "body_invalid",
    },
    {
      label: "invalid mentions",
      auth: authA,
      envelope: (base: RoomMessageEnvelope) =>
        ({ ...base, mentions: ["member-a", 7] }) as unknown as RoomMessageEnvelope,
      reasonCode: "mentions_invalid",
    },
    {
      label: "whitespace operation id",
      auth: authA,
      envelope: (base: RoomMessageEnvelope) => ({ ...base, operationId: " \t " }),
      reasonCode: "operation_id_required",
    },
    {
      label: "wrong-type operation id",
      auth: authA,
      envelope: (base: RoomMessageEnvelope) =>
        ({ ...base, operationId: 7 }) as unknown as RoomMessageEnvelope,
      reasonCode: "operation_id_required",
    },
  ] as const)(
    "rejects $label without writing an event or public receipt, with a positive control",
    ({ label, auth, envelope, reasonCode }) => {
      const accepted = postRoomMessage(
        authA,
        validEnvelope({ operationId: "positive-control", ...nearGreenOverrides[label] }),
        access,
        store,
      );
      const negativeEnvelope = envelope(validEnvelope({ operationId: "negative-case" }));
      const rejected = postRoomMessage(auth, negativeEnvelope, access, store);

      expect(accepted.status).toBe("recorded");
      expect(rejected).toEqual({
        status: "rejected",
        operationId:
          typeof negativeEnvelope.operationId === "string" ? negativeEnvelope.operationId : "",
        recipient: "sender",
        reasonCode,
      });
      expect(store.readRoomEvents()).toHaveLength(1);
      expect(store.readRoomEvents()[0]?.body).toBe("hello");
      expect(store.readSystemReceipts()).toHaveLength(1);
    },
  );

  it("returns the same receipt on identical retry and sender-only conflict on changed payload", () => {
    const first = postRoomMessage(authA, validEnvelope({ operationId: "retry" }), access, store);
    const retry = postRoomMessage(authA, validEnvelope({ operationId: "retry" }), access, store);
    const conflict = postRoomMessage(
      authA,
      validEnvelope({ operationId: "retry", body: "changed payload" }),
      access,
      store,
    );

    expect(first.status).toBe("recorded");
    expect(retry).toEqual(first.status === "recorded" ? { ...first, replayed: true } : first);
    expect(conflict).toEqual({
      status: "conflict",
      operationId: "retry",
      recipient: "sender",
      reasonCode: "operation_id_conflict",
    });
    expect(store.readRoomEvents()).toHaveLength(1);
    expect(store.readSystemReceipts()).toHaveLength(1);
  });

  it("does not replay another principal's operation even with the same binding and body", () => {
    access.register(principalB, roomId, allowedBinding);
    const { principalId: _principalId, ...sharedEnvelope } = validEnvelope({
      operationId: "principal-scoped-replay",
    });
    void _principalId;

    const original = postRoomMessage(authA, sharedEnvelope, access, store);
    const replay = postRoomMessage({ principalId: principalB }, sharedEnvelope, access, store);

    expect(original.status).toBe("recorded");
    expect(replay).toEqual({
      status: "conflict",
      operationId: "principal-scoped-replay",
      recipient: "sender",
      reasonCode: "operation_id_conflict",
    });
    expect(store.readRoomEvents()).toHaveLength(1);
    expect(store.readRoomEvents()[0]).toMatchObject({
      principalId: principalA,
      authorId: principalA,
      body: "hello",
    });
    expect(store.readSystemReceipts()).toHaveLength(1);
  });

  it("keeps the existing binding after rejecting a same-member rebind", () => {
    expect(() => access.register(principalA, roomId, "membership-token-b")).toThrow(
      /cannot be rebound/,
    );

    const oldGrant = postRoomMessage(
      authA,
      validEnvelope({ operationId: "old-binding-remains-valid" }),
      access,
      store,
    );
    const newGrant = postRoomMessage(
      authA,
      validEnvelope({ operationId: "new-binding-not-installed", binding: "membership-token-b" }),
      access,
      store,
    );

    expect(oldGrant.status).toBe("recorded");
    expect(newGrant).toMatchObject({
      status: "rejected",
      recipient: "sender",
      reasonCode: "room_binding_denied",
    });
    expect(store.readRoomEvents()).toHaveLength(1);
    expect(store.readSystemReceipts()).toHaveLength(1);
  });

  it("replays an identical durable retry after restart before volatile membership is restored", () => {
    const original = postRoomMessage(
      authA,
      validEnvelope({ operationId: "restart-retry" }),
      access,
      store,
    );
    expect(original.status).toBe("recorded");
    store.close();
    store = new RoomEventStore(root);
    access.clear();

    const replay = postRoomMessage(
      authA,
      validEnvelope({ operationId: "restart-retry" }),
      access,
      store,
    );
    const changed = postRoomMessage(
      authA,
      validEnvelope({ operationId: "restart-retry", body: "different" }),
      access,
      store,
    );

    expect(replay).toEqual(
      original.status === "recorded" ? { ...original, replayed: true } : original,
    );
    expect(changed).toMatchObject({ status: "conflict", reasonCode: "operation_id_conflict" });
    expect(store.readRoomEvents()).toHaveLength(1);
    expect(store.readSystemReceipts()).toHaveLength(1);
  });

  it("rejects a missing operation id as sender-visible validation instead of throwing", () => {
    const { operationId: _operationId, ...withoutOperationId } = validEnvelope();
    void _operationId;

    expect(
      postRoomMessage(authA, withoutOperationId as RoomMessageEnvelope, access, store),
    ).toEqual({
      status: "rejected",
      operationId: "",
      recipient: "sender",
      reasonCode: "operation_id_required",
    });
    expect(store.readRoomEvents()).toHaveLength(0);
    expect(store.readSystemReceipts()).toHaveLength(0);
  });

  it("does not accept an actual grant for another principal or for another room", () => {
    access.register(principalB, roomId, "real-resident-b-grant");
    access.register(principalA, "room-b", "real-room-b-grant");

    const otherPrincipalGrant = postRoomMessage(
      authA,
      validEnvelope({ operationId: "other-member", binding: "real-resident-b-grant" }),
      access,
      store,
    );
    const otherRoomGrant = postRoomMessage(
      authA,
      validEnvelope({ operationId: "other-room", binding: "real-room-b-grant" }),
      access,
      store,
    );

    expect(otherPrincipalGrant).toMatchObject({
      status: "rejected",
      reasonCode: "room_binding_denied",
    });
    expect(otherRoomGrant).toMatchObject({
      status: "rejected",
      reasonCode: "room_binding_denied",
    });
    expect(store.readRoomEvents()).toHaveLength(0);
    expect(store.readSystemReceipts()).toHaveLength(0);
  });
});

describe("RoomAccessRegistry", () => {
  it("keeps the current grants if replacement setup is invalid", () => {
    const registry = new RoomAccessRegistry();
    registry.register("resident-a", "room-a", "existing-token");

    expect(() =>
      registry.replace([
        { principalId: "resident-b", roomId: "room-b", bindingId: "new-token" },
        { principalId: "", roomId: "room-c", bindingId: "invalid-token" },
      ]),
    ).toThrow("room membership requires a principal, room and binding");
    expect(registry.allows("resident-a", "room-a", "existing-token")).toBe(true);
    expect(registry.allows("resident-b", "room-b", "new-token")).toBe(false);
  });
});

function validEnvelope(overrides: Partial<RoomMessageEnvelope> = {}): RoomMessageEnvelope {
  return {
    operationId: "operation-1",
    roomId,
    principalId: principalA,
    visibility: "public",
    binding: allowedBinding,
    body: "hello",
    ...overrides,
  };
}
