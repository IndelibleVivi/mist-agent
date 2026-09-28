/**
 * Host adapter contract for #191/#192 group-chat acceptance. The judge issues
 * concrete operations and independently reads host-owned ledgers/projections;
 * an adapter never returns a pre-composed pass/fail evidence card.
 */
export const GROUP_CHAT_CHECK_IDS = [
  "GC-01",
  "GC-02",
  "GC-03",
  "GC-04",
  "GC-05",
  "GC-06",
  "GC-07",
  "GC-08",
  "GC-09",
  "GC-10",
  "GC-12",
  "GC-15",
  "GC-16",
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
export type MemberBehavior = "complete" | "pass" | "fail" | "hold";
export type PressureMode = "normal" | "batch" | "not-included" | "stopped" | "cooling";

export interface DispatchIdentity {
  readonly residentId: ResidentId;
  readonly scopeId: string;
  readonly scopeGeneration: number;
  readonly windowId: string;
  readonly generation: number;
  readonly dispatchId: string;
}

export const groupChatSyntheticFixture = Object.freeze({
  roomId: "test-room:gc-191",
  otherRoomId: "test-room:gc-192-other",
  hiddenRoomId: "test-room:gc-191-hidden",
  humanId: "test-human:owner",
  unauthorizedHumanId: "test-human:unauthorized",
  /**
   * Judge-owned setup grant: the only trusted source of the owner binding. An adapter
   * registers it from resetScenario(id, fixture); the `binding` field of a perform()
   * command stays untrusted request input and can never create this trust by itself.
   */
  trustedOwnerBinding: "test-binding:owner",
  roots: Object.freeze({ first: "test-root:one", second: "test-root:two" }),
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
    blocked: "TEST-PRIVATE-CANARY:blocked-body",
    hiddenProjection: "TEST-PRIVATE-CANARY:hidden-projection",
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
      /** Untrusted request field; the host only compares it against its registered setup grant. */
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
  | { readonly kind: "set-resident"; readonly residentId: ResidentId }
  | {
      readonly kind: "configure-orchestration";
      readonly rootId: string;
      readonly policyVersion: string;
      readonly turnBudget: number | null;
      readonly deadlineTicks: number;
      readonly maxMemberAttempts: number;
    }
  | {
      readonly kind: "human-trigger";
      readonly operationId: string;
      readonly rootId: string;
      readonly body: string;
    }
  | {
      readonly kind: "member-turn";
      readonly operationId: string;
      readonly rootId: string;
      readonly claimedRootId?: string;
      readonly residentId: ResidentId;
      readonly body: string;
      readonly target?: DispatchIdentity;
    }
  | { readonly kind: "retry-operation"; readonly operationId: string }
  | {
      readonly kind: "set-member-behavior";
      readonly residentId: ResidentId;
      readonly behavior: MemberBehavior;
    }
  | {
      readonly kind: "set-pressure";
      readonly residentId: ResidentId;
      readonly mode: PressureMode;
    }
  | { readonly kind: "advance-scheduler"; readonly ticks: number }
  | { readonly kind: "fill-ordinary-queue"; readonly depth: number }
  | {
      readonly kind: "submit-control";
      readonly controlId: string;
      readonly issuerId: string;
      readonly targetId: ResidentId;
      readonly action: "stop" | "continue";
      readonly structured: boolean;
      /** Synthetic credential/binding handle; the host decides whether it authorizes control. */
      readonly binding: string;
    }
  | {
      readonly kind: "mark-external-effect";
      readonly operationId: string;
      readonly targetId: ResidentId;
    }
  | {
      readonly kind: "set-sender-online";
      readonly residentId: ResidentId;
      readonly online: boolean;
    }
  | {
      readonly kind: "query-feedback";
      readonly residentId: ResidentId;
      readonly via: "query" | "wake";
    }
  | {
      readonly kind: "inject-next-fault";
      readonly fault: "decision-persist" | "member-dispatch";
      readonly residentId?: ResidentId;
    }
  | {
      readonly kind: "seed-projection-event";
      readonly eventId: string;
      readonly body: string;
      readonly authorized: boolean;
    }
  | {
      readonly kind: "request-projection";
      readonly projectionId: string;
      readonly viewerId: ResidentId;
      readonly mode: "batch" | "latest" | "truncate";
      readonly maxCharacters?: number;
    }
  | {
      readonly kind: "attempt-source-read";
      readonly viewerId: ResidentId;
      readonly sourceRef: string;
    }
  | { readonly kind: "set-room-access"; readonly residentId: ResidentId; readonly allowed: boolean }
  | {
      readonly kind: "set-room-membership";
      readonly residentId: ResidentId;
      readonly active: boolean;
    }
  | { readonly kind: "attempt-delivery"; readonly operationId: string }
  | { readonly kind: "set-delivery-target"; readonly target: DispatchIdentity }
  | {
      readonly kind: "return-member-result";
      readonly operationId: string;
      readonly target: DispatchIdentity;
      readonly body: string;
    };

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

/** Acceptance readback vocabulary: adapters map production records into these semantic facts. */
export interface RoundRecord {
  readonly sequence: number;
  readonly operationId: string;
  readonly rootId: string;
  readonly senderId: string;
  readonly policyVersion: string | null;
  readonly decision:
    | "human-trigger"
    | "permitted"
    | "passed"
    | "failed"
    | "held"
    | "blocked"
    | "retry-replayed";
  readonly consumedTurns: number;
  readonly reasonCode: string | null;
  readonly target: DispatchIdentity | null;
}

export interface SchedulerSnapshot {
  readonly tick: number;
  readonly ordinaryQueueDepth: number;
  readonly heldOperationIds: readonly string[];
  readonly stoppedResidentIds: readonly ResidentId[];
}

export interface ControlRecord {
  readonly sequence: number;
  readonly controlId: string;
  readonly issuerId: string;
  readonly targetId: ResidentId;
  readonly action: "stop" | "continue";
  readonly phase: "accepted" | "effective" | "rejected" | "incomplete";
  readonly cutoffId: string | null;
  readonly externalEffectReversed: boolean;
}

export interface DeliveryDecisionRecord {
  readonly sequence: number;
  readonly operationId: string;
  readonly senderId: ResidentId;
  readonly state:
    | "queued"
    | "batched"
    | "not-included"
    | "stop-blocked"
    | "dispatch-failed"
    | "persist-failed"
    | "dispatched"
    | "context-committed"
    | "rejected";
  readonly reasonCode: string;
  readonly count: number;
  readonly permitConsumed: boolean;
  readonly rosterVersion: number;
  readonly target: DispatchIdentity | null;
}

export interface SenderFeedbackRecord {
  readonly operationId: string;
  readonly senderId: ResidentId;
  readonly roomId: string;
  readonly scopeId: string;
  readonly reasonCode: string;
  readonly count: number;
  readonly phase: "pending" | "delivered";
  readonly deliveryReceipt: string | null;
  readonly body: string | null;
}

export interface ProjectionTruncation {
  readonly eventId: string;
  readonly originalLength: number;
  readonly unit: "characters";
  readonly keptStart: number;
  readonly keptEnd: number;
  readonly sourceRef: string;
  readonly modelVisible: boolean;
}

export interface ProjectionReceipt {
  readonly projectionId: string;
  readonly viewerId: ResidentId;
  readonly sourceRange: readonly [string, string];
  readonly watermark: string;
  readonly policyVersion: string;
  readonly includedEventIds: readonly string[];
  readonly omittedEventIds: readonly string[];
  readonly complete: boolean;
  readonly errorCode: string | null;
  readonly truncations: readonly ProjectionTruncation[];
}

export interface SourceReadAudit {
  readonly sourceRef: string;
  readonly viewerId: ResidentId;
  readonly outcome: "granted" | "denied";
  readonly eventId: string | null;
  readonly body: string | null;
  readonly errorCode: string | null;
}

export interface MemberAttemptRecord {
  readonly sequence: number;
  readonly operationId: string;
  readonly memberId: ResidentId;
  readonly attempt: number;
  readonly outcome: "in-flight" | "failed" | "unknown" | "completed";
  readonly reasonCode: string | null;
}

export interface MemberResultRecord {
  readonly sequence: number;
  readonly operationId: string;
  readonly target: DispatchIdentity;
  readonly phase: "returned" | "committed" | "rejected";
  readonly reasonCode: string | null;
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
  "GC-06": {
    boundedWorlds: readonly {
      budget: number;
      permitted: number;
      blocked: number;
      oneRoot: boolean;
      policyVersionStable: boolean;
    }[];
    retryAddedDispatch: boolean;
    passRecorded: boolean;
    failureRecorded: boolean;
    identityChangesResetBudget: boolean;
    generationChangeStimulated: boolean;
    selfRootAccepted: boolean;
    restartPidChanged: boolean;
    restartCommitStable: boolean;
    highWaterBeforeRestart: number;
    highWaterAfterRestart: number;
    humanAfterLimitAccepted: boolean;
    invalidConfigDispatched: boolean;
    invalidConfigReasoned: boolean;
  };
  "GC-07": {
    ordinaryQueueDepthBeforeControl: number;
    heldBeforeControl: boolean;
    stopAcceptedBeforeQueueRelease: boolean;
    stopEffective: boolean;
    oldPermitCommitted: boolean;
    falseControlsChangedLatch: boolean;
    acceptedAndEffectiveSeparated: boolean;
    unreachableReportedIncomplete: boolean;
    externalEffectClaimedReversed: boolean;
    continueEffectiveWhileQueueBlocked: boolean;
    postContinueNewPermitCommitted: boolean;
  };
  "GC-08": {
    decisions: readonly DeliveryDecisionRecord[];
    offlineFeedbackMarkedDelivered: boolean;
    deliveredFeedback: readonly SenderFeedbackRecord[];
    crossSenderFeedback: readonly SenderFeedbackRecord[];
    leakedBlockedBody: boolean;
    stableReasonsAcrossRestart: boolean;
    persistFailureConsumedPermit: boolean;
    persistedDecisionCountAfterRetry: number;
    /** Sender-feedback free text flagged by the shared personal-claim judge. */
    unsupportedClaims: readonly string[];
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
  "GC-10": {
    batch: ProjectionReceipt | null;
    latest: ProjectionReceipt | null;
    truncated: ProjectionReceipt | null;
    projectionContext: string;
    hiddenWorldFingerprints: readonly string[];
    grantedRead: SourceReadAudit | null;
    deniedRead: SourceReadAudit | null;
  };
  "GC-12": {
    revokedDeliveryCommitted: boolean;
    revokedDeliveryReasoned: boolean;
    rosterVersionAdvanced: boolean;
    staleResultActuallyReturned: boolean;
    staleResultCommitted: boolean;
    staleResultReasoned: boolean;
    stoppedResultActuallyReturned: boolean;
    stoppedResultCommitted: boolean;
    postContinueResultCommitted: boolean;
    forgedTupleAttempts: number;
    forgedTupleCommits: number;
    currentTupleCommits: number;
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
  "GC-16": {
    failedMemberAttempts: readonly MemberAttemptRecord[];
    normalMemberCompleted: boolean;
    humanContinued: boolean;
    controlContinued: boolean;
    heldWasActuallyInFlight: boolean;
    heldTimedOut: boolean;
    attemptsWithinBound: boolean;
    restartPidChanged: boolean;
    restartCommitStable: boolean;
    failuresBeforeRestart: number;
    failuresAfterRestart: number;
    highWaterBeforeRestart: number;
    highWaterAfterRestart: number;
    failureFeedbackRetained: boolean;
    falsePresenceClaims: readonly string[];
    /** System-receipt claims flagged by the shared personal-claim judge. */
    unsupportedClaims: readonly string[];
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
  restartHost(): Promise<GroupChatHostRun>;
  /** Resolve only after the host process has exited; every readback must reject afterwards. */
  stopHost(): Promise<void>;
  /** Delivers the judge-owned setup grant: fixture.trustedOwnerBinding is the only trusted binding source. */
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
  readRoundRecords(): Promise<readonly RoundRecord[]>;
  readScheduler(): Promise<SchedulerSnapshot>;
  readControlRecords(): Promise<readonly ControlRecord[]>;
  readDeliveryDecisions(): Promise<readonly DeliveryDecisionRecord[]>;
  readSenderFeedback(residentId: ResidentId): Promise<readonly SenderFeedbackRecord[]>;
  readProjectionReceipts(): Promise<readonly ProjectionReceipt[]>;
  readProjectionContext(residentId: ResidentId): Promise<string>;
  readSourceReads(): Promise<readonly SourceReadAudit[]>;
  readMemberAttempts(): Promise<readonly MemberAttemptRecord[]>;
  readMemberResults(): Promise<readonly MemberResultRecord[]>;
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
