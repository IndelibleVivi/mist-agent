/**
 * Host adapter contract for #191 group-chat acceptance. The judge issues
 * concrete operations and independently reads host-owned ledgers/projections;
 * an adapter never returns a pre-composed pass/fail evidence card.
 */
export const GROUP_CHAT_CHECK_IDS = [
  "GC-01",
  "GC-02",
  "GC-03",
  "GC-04",
  "GC-05",
  "GC-09",
  "GC-15",
] as const;

export type GroupChatCheckId = (typeof GROUP_CHAT_CHECK_IDS)[number];
export type ResidentId =
  | "test-resident:a"
  | "test-resident:b"
  | "test-resident:c"
  | "test-resident:novel-d"
  | "test-resident:novel-e";
export type DeliveryState = "loaded" | "queued" | "not-targeted";
export type RosterPath = "broadcast" | "mention" | "projection" | "feedback" | "status";

export const groupChatSyntheticFixture = Object.freeze({
  roomId: "test-room:gc-191",
  hiddenRoomId: "test-room:gc-191-hidden",
  humanId: "test-human:owner",
  residentIds: Object.freeze({
    a: "test-resident:a",
    b: "test-resident:b",
    c: "test-resident:c",
    newcomer: "test-resident:novel-d",
    /** GC-04 second world: a different newcomer, so a branch keyed on one id cannot pass. */
    newcomerAlt: "test-resident:novel-e",
  }),
  canaries: Object.freeze({
    privateA: "TEST-PRIVATE-CANARY:a",
    privateB: "TEST-PRIVATE-CANARY:b",
    privateC: "TEST-PRIVATE-CANARY:c",
    draft: "TEST-PRIVATE-CANARY:draft",
    tool: "TEST-PRIVATE-CANARY:tool",
  }),
});

/**
 * What startHost() reports about the host it launched. The runner checks it against facts it
 * reads itself: the pid must be a live descendant of the judge process running this judge's
 * node binary with an entry file from this checkout, and commit must be the checked-out HEAD.
 */
export interface GroupChatHostRun {
  readonly pid: number;
  readonly commit: string;
}

export type GroupChatCommand =
  | {
      readonly kind: "post";
      readonly roomId: string;
      readonly principalId: string;
      readonly claimedAuthorId?: string;
      readonly body: string;
      readonly visibility?: "public";
      readonly binding?: string;
      readonly privateFields?: readonly string[];
    }
  | {
      readonly kind: "save-memory";
      readonly residentId: ResidentId;
      readonly sourceEventId: string;
    }
  | {
      readonly kind: "seed-resident-private";
      readonly residentId: ResidentId;
      readonly canary: string;
    }
  | {
      readonly kind: "set-delivery-state";
      readonly eventMarker: string;
      readonly residentId: ResidentId;
      readonly state: DeliveryState;
    }
  | { readonly kind: "register-resident"; readonly residentId: ResidentId }
  | {
      readonly kind: "exercise-roster-path";
      readonly path: RosterPath;
      readonly residentId: ResidentId;
    }
  | {
      readonly kind: "plain-text-mention";
      /** Judge-issued id; the host keeps exactly one routing decision per operation. */
      readonly operationId: string;
      readonly roomId: string;
      readonly body: string;
    }
  | {
      readonly kind: "structured-mention";
      readonly operationId: string;
      readonly roomId: string;
      readonly targetId: string;
      readonly body: string;
    }
  | { readonly kind: "set-turn-gate"; readonly stopped: boolean; readonly turnOpen: boolean }
  | {
      readonly kind: "record-event";
      readonly roomId: string;
      readonly authorId: string;
      readonly body: string;
    }
  | { readonly kind: "dispatch-event"; readonly eventMarker: string }
  | { readonly kind: "commit-context"; readonly residentId: ResidentId; readonly marker: string }
  | { readonly kind: "react"; readonly residentId: ResidentId; readonly eventMarker: string }
  | {
      readonly kind: "create-room";
      readonly roomId: string;
      readonly visibility: "public" | "hidden";
      readonly body: string;
    }
  | {
      readonly kind: "replay-public-payload";
      readonly sourceRoomId: string;
      readonly targetRoomId: string;
      readonly eventMarker: string;
    }
  | { readonly kind: "attempt-room-read"; readonly roomId: string; readonly viewerId: string }
  | {
      /** A room member tries to read another resident's internal scope through the room. */
      readonly kind: "attempt-resident-scope-read";
      readonly roomId: string;
      readonly viewerId: ResidentId;
      readonly ownerId: ResidentId;
    }
  | { readonly kind: "set-resident"; readonly residentId: ResidentId };

export interface RoomEvent {
  readonly id: string;
  readonly roomId: string;
  /** Unique, increasing position in this room's ledger, assigned by the host on record. */
  readonly position: number;
  readonly authorId: string;
  readonly body: string;
  readonly visibility: "public" | "hidden";
}
export interface DeliveryRecord {
  readonly residentId: ResidentId;
  readonly state: DeliveryState;
}
export interface MemoryRecord {
  readonly residentId: ResidentId;
  readonly sourceEventId: string | null;
  readonly body: string;
}
export interface RosterSnapshot {
  readonly version: number;
  readonly residentIds: readonly ResidentId[];
}
export interface RosterProjection {
  readonly residentIds: readonly ResidentId[];
  readonly humanIds: readonly string[];
}
/** The host's routing decision for one judge operation, with a stable reason code. */
export interface MentionDecision {
  readonly operationId: string;
  readonly outcome: "accepted" | "rejected" | "held";
  readonly reason: string;
  readonly targetId: string | null;
  /** Receipts this decision produced in the host-owned call ledger. */
  readonly callReceiptIds: readonly string[];
}
/** One entry per resident call the host actually made. */
export interface CallReceipt {
  readonly id: string;
  readonly targetId: string;
}
export interface SystemReceipt {
  readonly actor: "system" | ResidentId;
  readonly phase: string;
  readonly claim?: string;
  readonly contextCommitRef?: string;
}
export interface ContextCommit {
  readonly id: string;
  readonly residentId: ResidentId;
  readonly marker: string;
}
export interface SurfaceSnapshot {
  readonly body: string;
  /** Ledger event ids this viewer's projection of the room includes. */
  readonly visibleEventIds: readonly string[];
  readonly candidates: readonly string[];
  readonly count: number;
  readonly errorCode: string | null;
  readonly receipt: string | null;
}
export interface AccessAudit {
  readonly crossResidentPrivateReads: number;
  readonly unauthorizedReadResults: readonly string[];
}
export interface ResidentReaction {
  readonly residentId: string;
  readonly eventMarker: string;
}

/** One GC-04 world: add a single newcomer, then read every roster-driven path back. */
export interface GroupChatRosterWorldEvidence {
  readonly newResidentId: ResidentId;
  readonly rosterVersionBefore: number;
  readonly rosterVersionAfter: number;
  readonly rosterResidentIdsBefore: readonly ResidentId[];
  readonly rosterResidentIdsAfter: readonly ResidentId[];
  readonly residentIdsByPath: Readonly<Record<RosterPath, readonly ResidentId[]>>;
  readonly humanRenderedAsResident: boolean;
}

/** What the judge requires of the routing decision for one GC-05 operation. */
export type GroupChatMentionExpectation = "text-only" | "route" | "reject" | "gate-closed";
export interface GroupChatMentionOperation {
  readonly operationId: string;
  readonly expect: GroupChatMentionExpectation;
}

/** GC-15, one world: what a newcomer without a history grant sees around its join. */
export interface GroupChatNewcomerHistoryEvidence {
  /** Room positions of the judge's own posts, in the order the judge made them. */
  readonly judgePostPositions: readonly (number | null)[];
  readonly positionsUnique: boolean;
  /** Public room events at or below the high-water mark read just before the join. */
  readonly preJoinEventIds: readonly string[];
  /** Public room events above the high-water mark read just after the join. */
  readonly postJoinEventIds: readonly string[];
  readonly roomPublicEventIds: readonly string[];
  readonly visibleEventIds: readonly string[];
  /** Judge-seeded pre-join bodies that still appear anywhere on the newcomer's surface. */
  readonly preJoinTextOnSurface: readonly string[];
}

/** Judge-derived observations assembled from the readback APIs below. */
export interface GroupChatEvidenceById {
  "GC-01": {
    legitimateHuman: { accepted: boolean; authorId: string };
    legitimate: { accepted: boolean; authorId: string };
    forgedEnvelopeAccepted: boolean;
    forgedBodyAccepted: boolean;
    forgedBodyAuthorId: string | null;
    unexpectedAuthors: readonly string[];
    recordedAuthorIds: readonly string[];
  };
  "GC-02": {
    publicPayloadAccepted: boolean;
    missingVisibilityAccepted: boolean;
    missingRoomAccepted: boolean;
    missingBindingAccepted: boolean;
    extraPrivateFieldsAccepted: boolean;
    senderPrivateCanariesMissing: readonly string[];
    leakedCanaries: readonly string[];
  };
  "GC-03": {
    roomEventIdsBeforeSave: readonly string[];
    roomEventIdsAfterSave: readonly string[];
    deliveryByResident: Readonly<Partial<Record<ResidentId, DeliveryState | "missing">>>;
    deliveryRowsRead: number;
    memoryWritesByResident: Readonly<Partial<Record<ResidentId, number>>>;
    privateCanariesMissingFromOwners: readonly string[];
    privateCanariesVisibleToOtherResidents: readonly string[];
    judgeSeededEventId: string | null;
    savedSourceEventId: string | null;
  };
  "GC-04": {
    worlds: readonly GroupChatRosterWorldEvidence[];
    /** Repo-relative non-test files under src/ that spell out a roster/fixture member id. */
    sourceFilesWithRosterIdLiterals: readonly string[];
  };
  "GC-05": {
    operations: readonly GroupChatMentionOperation[];
    /** Every decision read back; only those for the judge's operations are judged. */
    decisions: readonly MentionDecision[];
    /** Call-ledger entries that appeared during this scenario (read after minus read before). */
    newCallReceipts: readonly CallReceipt[];
    /** Ids of entries present before the scenario that vanished or changed afterwards. */
    rewrittenCallReceiptIds: readonly string[];
    structuredTargetId: ResidentId;
  };
  "GC-09": {
    receipts: readonly SystemReceipt[];
    prematureReceiptPhases: readonly string[];
    judgeSeededContextCommitId: string | null;
    /** Reactions on the judge event read back before the resident's own react command. */
    reactionAuthorsBeforeResidentReacted: readonly string[];
    reactionAuthorsAfterResidentReacted: readonly string[];
    memoryRecordsAddedByContextCommit: number;
  };
  "GC-15": {
    authorizedPublicSurface: string;
    hiddenWorldSeedsPresent: boolean;
    unauthorizedSurfaceLeaks: readonly string[];
    crossResidentPrivateReads: number;
    scopeReadSeedPresent: boolean;
    crossResidentScopeLeaks: readonly string[];
    scopeReadDenied: boolean;
    newResidentHistory: readonly GroupChatNewcomerHistoryEvidence[];
    crossRoomReplayAccepted: boolean;
  };
}

/**
 * Methods are intentionally commands plus independent readbacks, not a
 * driver-authored evidence object. All fixtures are synthetic and judge-owned.
 */
export interface GroupChatHostDriver {
  readonly kind: "mist-host";
  /** Launch the host as a child process of this judge run (see GroupChatHostRun). */
  startHost(): Promise<GroupChatHostRun>;
  /** Resolve only after the host process has exited; every readback must reject afterwards. */
  stopHost(): Promise<void>;
  resetScenario(id: GroupChatCheckId, fixture: typeof groupChatSyntheticFixture): Promise<void>;
  perform(command: GroupChatCommand): Promise<void>;
  /** Omitted roomId means all records in the synthetic test namespace. */
  readRoomEvents(roomId?: string): Promise<readonly RoomEvent[]>;
  readDeliveries(eventId: string): Promise<readonly DeliveryRecord[]>;
  readMemories(): Promise<readonly MemoryRecord[]>;
  readResidentContext(residentId: ResidentId): Promise<string>;
  readRoster(): Promise<RosterSnapshot>;
  readRosterPath(path: RosterPath): Promise<RosterProjection>;
  readMentionDecisions(): Promise<readonly MentionDecision[]>;
  readCallLedger(): Promise<readonly CallReceipt[]>;
  readSystemReceipts(): Promise<readonly SystemReceipt[]>;
  readContextCommits(): Promise<readonly ContextCommit[]>;
  readSurface(roomId: string, viewerId: string): Promise<SurfaceSnapshot>;
  readAccessAudit(): Promise<AccessAudit>;
  readReactions(): Promise<readonly ResidentReaction[]>;
}

/** Clone both arguments and return values at the adapter boundary (#196/#200 pattern). */
export function cloneGroupChatDriverBoundary(driver: GroupChatHostDriver): GroupChatHostDriver {
  return new Proxy(driver, {
    get(target, property) {
      const member = Reflect.get(target, property, target);
      if (typeof member !== "function") return member;
      return async (...args: unknown[]) => {
        const result = await Reflect.apply(member, target, structuredClone(args));
        return structuredClone(result);
      };
    },
  });
}
