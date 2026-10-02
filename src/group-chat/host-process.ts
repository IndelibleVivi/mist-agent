import { createHash } from "node:crypto";
import type {
  AuthenticatedPrincipal,
  RoomBindingGrant,
  RoomMessageEnvelope,
} from "./post-room-message.ts";
import { RoomMessageHost } from "./room-message-host.ts";

type HostRequestPayload =
  | { readonly kind: "reset"; readonly grants: readonly RoomBindingGrant[] }
  | {
      readonly kind: "post";
      readonly principal: AuthenticatedPrincipal | null;
      readonly envelope: RoomMessageEnvelope;
    }
  | { readonly kind: "read-room-events"; readonly roomId?: string }
  | { readonly kind: "read-system-receipts" }
  | { readonly kind: "shutdown" };

type HostRequest = HostRequestPayload & {
  readonly id: string;
  readonly requestHash: string;
};

type HostResponse =
  | {
      readonly id: string;
      readonly ok: true;
      readonly value?: unknown;
      readonly hostPid: number;
      readonly requestHash: string;
    }
  | {
      readonly id: string;
      readonly ok: false;
      readonly error: string;
      readonly hostPid: number;
      readonly requestHash: string;
    };

const dataRoot = process.env.MIST_GROUP_CHAT_DATA_ROOT;
if (typeof dataRoot !== "string" || dataRoot.trim() === "")
  throw new Error("MIST_GROUP_CHAT_DATA_ROOT must be set by the host launcher");
if (typeof process.send !== "function")
  throw new Error("group-chat host must run with an IPC channel");

const host = new RoomMessageHost(dataRoot);

process.on("message", (message: unknown) => {
  void handleMessage(message);
});
process.on("disconnect", () => host.close());

process.send({ kind: "ready", pid: process.pid });

async function handleMessage(message: unknown): Promise<void> {
  if (!isHostRequest(message)) return;
  const requestHash = hashReceivedRequest(message);

  try {
    switch (message.kind) {
      case "reset":
        host.replaceBindingGrants(message.grants);
        respond({ id: message.id, ok: true, hostPid: process.pid, requestHash });
        return;
      case "post":
        respond({
          id: message.id,
          ok: true,
          value: host.post(message.principal, message.envelope),
          hostPid: process.pid,
          requestHash,
        });
        return;
      case "read-room-events":
        respond({
          id: message.id,
          ok: true,
          value: host.readRoomEvents(message.roomId),
          hostPid: process.pid,
          requestHash,
        });
        return;
      case "read-system-receipts":
        respond({
          id: message.id,
          ok: true,
          value: host.readSystemReceipts(),
          hostPid: process.pid,
          requestHash,
        });
        return;
      case "shutdown":
        host.close();
        respond({ id: message.id, ok: true, hostPid: process.pid, requestHash }, () =>
          process.disconnect?.(),
        );
    }
  } catch (error) {
    respond({
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      hostPid: process.pid,
      requestHash,
    });
  }
}

function respond(response: HostResponse, afterSend?: () => void): void {
  process.send?.(response, () => afterSend?.());
}

function isHostRequest(value: unknown): value is HostRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "requestHash" in value &&
    typeof value.requestHash === "string"
  );
}

function hashReceivedRequest(message: HostRequest): string {
  const payload = Object.fromEntries(
    Object.entries(message).filter(([key]) => key !== "id" && key !== "requestHash"),
  );
  const serialized = JSON.stringify(payload);
  if (serialized === undefined) throw new Error("received group-chat request is not serializable");
  return createHash("sha256").update(serialized).digest("hex");
}
