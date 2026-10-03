import {
  type AuthenticatedPrincipal,
  RoomAccessRegistry,
  type RoomBindingGrant,
  type RoomMessageEnvelope,
  type RoomPostResult,
  postRoomMessage,
} from "./post-room-message.ts";
import { RoomEventStore } from "./room-event-store.ts";

/** Production composition: trusted grants arrive separately from untrusted post envelopes. */
export class RoomMessageHost {
  readonly #store: RoomEventStore;
  readonly #access = new RoomAccessRegistry();

  constructor(dataRoot: string) {
    this.#store = new RoomEventStore(dataRoot);
  }

  replaceBindingGrants(grants: readonly RoomBindingGrant[]): void {
    this.#access.replace(grants);
  }

  post(
    authenticatedPrincipal: AuthenticatedPrincipal | null,
    untrustedEnvelope: RoomMessageEnvelope,
  ): RoomPostResult {
    return postRoomMessage(authenticatedPrincipal, untrustedEnvelope, this.#access, this.#store);
  }

  readRoomEvents(roomId?: string) {
    return this.#store.readRoomEvents(roomId);
  }

  readSystemReceipts() {
    return this.#store.readSystemReceipts();
  }

  close(): void {
    this.#store.close();
  }
}
