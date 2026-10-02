import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RoomEventStore } from "../../src/group-chat/room-event-store.ts";

const dataRoot = process.argv[2];
const writerId = process.argv[3];
if (dataRoot === undefined || writerId === undefined)
  throw new Error("room-event-store worker requires a data root and writer id");

const store = new RoomEventStore(dataRoot);
await writeFile(join(dataRoot, `${writerId}.ready`), "ready", { flag: "wx" });
const startFile = join(dataRoot, "start");
for (;;) {
  try {
    await access(startFile);
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

try {
  for (let sequence = 0; sequence < 64; sequence++) {
    const body = `${writerId}:${sequence}`;
    if (sequence === 0)
      await writeFile(join(dataRoot, `${writerId}.attempting`), "attempting", { flag: "wx" });
    store.append({
      operationId: body,
      roomId: "shared-room",
      principalId: writerId,
      authorId: writerId,
      body,
      visibility: "public",
      requestSemantics: JSON.stringify({ writerId, sequence }),
    });
    await new Promise((resolve) => setImmediate(resolve));
  }
} finally {
  store.close();
}
await writeFile(join(dataRoot, `${writerId}.done`), "done", { flag: "wx" });
