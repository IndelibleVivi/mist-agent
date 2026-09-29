import type {
  AuthenticatedPrincipal,
  RoomBindingGrant,
  RoomMessageEnvelope,
} from "./post-room-message.ts";
import { RoomMessageHost } from "./room-message-host.ts";

type HostRequest =
  | { readonly id: string; readonly kind: "reset"; readonly grants: readonly RoomBindingGrant[] }
  | {
      readonly id: string;
      readonly kind: "post";
      readonly principal: AuthenticatedPrincipal | null;
      readonly envelope: RoomMessageEnvelope;
    }
  | { readonly id: string; readonly kind: "read-room-events"; readonly roomId?: string }
  | { readonly id: string; readonly kind: "read-system-receipts" }
  | { readonly id: string; readonly kind: "shutdown" };

type HostResponse =
  | { readonly id: string; readonly ok: true; readonly value?: unknown }
  | { readonly id: string; readonly ok: false; readonly error: string };

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

  try {
    switch (message.kind) {
      case "reset":
        host.replaceBindingGrants(message.grants);
        respond({ id: message.id, ok: true });
        return;
      case "post":
        respond({
          id: message.id,
          ok: true,
          value: host.post(message.principal, message.envelope),
        });
        return;
      case "read-room-events":
        respond({
          id: message.id,
          ok: true,
          value: host.readRoomEvents(message.roomId),
        });
        return;
      case "read-system-receipts":
        respond({ id: message.id, ok: true, value: host.readSystemReceipts() });
        return;
      case "shutdown":
        host.close();
        respond({ id: message.id, ok: true }, () => process.disconnect?.());
    }
  } catch (error) {
    respond({
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function respond(response: HostResponse, afterSend?: () => void): void {
  process.send?.(response, () => afterSend?.());
}

function isHostRequest(value: unknown): value is HostRequest {
  return (
    typeof value === "object" && value !== null && "id" in value && typeof value.id === "string"
  );
}
