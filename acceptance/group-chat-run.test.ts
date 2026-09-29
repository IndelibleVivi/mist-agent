import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type GroupChatJudgeContext,
  evaluateGroupChatEvidence,
  groupChatChecks,
  isPersonalStatePhase,
  isUnsupportedPersonalClaim,
  runGroupChatCheck,
} from "./group-chat-checks.ts";
import {
  type AccessAudit,
  type CallReceipt,
  type ContextCommit,
  type ControlRecord,
  type DeliveryDecisionRecord,
  type DeliveryRecord,
  type DispatchIdentity,
  GROUP_CHAT_CHECK_IDS,
  type GroupChatCheckId,
  type GroupChatCommand,
  type GroupChatEvidenceById,
  type GroupChatHostDriver,
  type MemberAttemptRecord,
  type MemberBehavior,
  type MemberResultRecord,
  type MemoryRecord,
  type MentionDecision,
  type PressureMode,
  type ProjectionReceipt,
  type ResidentId,
  type ResidentReaction,
  type RoomEvent,
  type RosterPath,
  type RosterProjection,
  type RosterSnapshot,
  type RoundRecord,
  type SchedulerSnapshot,
  type SenderFeedbackRecord,
  type SourceReadAudit,
  type SurfaceSnapshot,
  type SystemReceipt,
  cloneGroupChatDriverBoundary,
  groupChatSyntheticFixture as fixture,
} from "./group-chat-driver.ts";
import {
  type HostProcessInfo,
  type HostProvenanceFacts,
  executeGroupChatAcceptance,
  findSourceLiterals,
  hostProvenanceProblem,
  hostStopProblem,
  isRepoEntryFile,
  provenanceFailedResults,
  readProcessInfo,
  restartedHostProvenanceProblem,
  missingDriverResults as runnerMissingDriverResults,
  scoreGroupChatResults,
} from "./group-chat-run.ts";

interface TestOptions {
  readonly acceptForged?: boolean;
  readonly dropForgedBodyPost?: boolean;
  readonly trustBodyAuthorHeader?: boolean;
  readonly acceptInvalidPosts?: boolean;
  /** Checks boundaries on the human entry only: accept a resident post with just this defect. */
  readonly acceptOnlyInvalid?: "visibility" | "room" | "binding" | "private-fields";
  readonly wrongMemorySource?: boolean;
  readonly noopSeedPrivate?: boolean;
  readonly leakPrivateCanariesIntoRoom?: boolean;
  readonly noRosterVersionBump?: boolean;
  readonly rosterSnapshotOmitsNewResident?: boolean;
  readonly projectionsHardcode?: ResidentId;
  readonly bypassGate?: boolean;
  readonly deadRouter?: boolean;
  readonly contextCommitRef?: string;
  readonly claimOverride?: string;
  readonly publishFutureReceiptsEarly?: boolean;
  readonly extraSystemPhase?: string;
  readonly proxyReaction?: boolean;
  readonly commitWritesMemory?: boolean;
  readonly residentReceiptAfterReaction?: boolean;
  readonly forgedResidentReceipt?: boolean;
  readonly skipRosterPath?: RosterPath;
  readonly leakHiddenToUnauthorized?: boolean;
  readonly revealHiddenExistence?: boolean;
  readonly noHiddenRoom?: boolean;
  readonly publicBodyX?: boolean;
  readonly acceptCrossRoomReplay?: boolean;
  readonly newResidentGetsHistory?: boolean;
  readonly leakResidentScope?: boolean;
  readonly silentScopeRead?: boolean;
  readonly leakPrivateCanaries?: boolean;
  readonly skipDeliveryFor?: ResidentId;
  readonly routePlainText?: boolean;
  readonly routeBareName?: boolean;
  readonly resolvePlainTextTarget?: boolean;
  readonly omitPlainDecisions?: boolean;
  readonly holdGatedMentions?: boolean;
  readonly acceptUnknownTargetWithoutCall?: boolean;
  /** #206 review 1: sender feedback free text carries a resident id claiming a personal state. */
  readonly feedbackClaimsMemberRead?: boolean;
  /** #206 review 1: a failure receipt carries a canonical resident id claiming a personal state. */
  readonly failureReceiptClaimsMemberRead?: boolean;
  /** #202 second-review probes: calls the decisions do not account for. */
  readonly plainCallOffDecision?: boolean;
  readonly orphanCalls?: boolean;
  readonly gatedCallsWithoutDecision?: boolean;
  readonly heldButCalled?: boolean;
  readonly phantomReceipt?: boolean;
  readonly wrongTargetReceipt?: boolean;
  readonly duplicateDecision?: boolean;
  readonly blankReason?: boolean;
  readonly preexistingCall?: boolean;
  readonly rewriteLedger?: boolean;
  readonly newcomerSurfaceIncludesRoomBody?: boolean;
  readonly newcomerSeesPreJoinIds?: boolean;
  readonly newcomerMissesPostJoin?: boolean;
  readonly duplicatePositions?: boolean;
  readonly ignoreTurnBudget?: boolean;
  readonly duplicateRetry?: boolean;
  readonly omitPassRecord?: boolean;
  readonly omitFailureRecord?: boolean;
  readonly resetBudgetOnIdentityChange?: boolean;
  readonly omitRoundTarget?: boolean;
  readonly acceptSelfDeclaredRoot?: boolean;
  readonly resetRoundOnRestart?: boolean;
  readonly reuseRestartPid?: boolean;
  readonly changeRestartCommit?: boolean;
  readonly dispatchWithInvalidPolicy?: boolean;
  readonly emptyOrdinaryQueue?: boolean;
  readonly controlSharesOrdinaryQueue?: boolean;
  readonly acceptFalseControl?: boolean;
  readonly mergeControlReceipts?: boolean;
  readonly reportUnreachableEffective?: boolean;
  readonly claimExternalEffectReversed?: boolean;
  readonly continueDeadlocks?: boolean;
  readonly acceptPreCutoffResult?: boolean;
  readonly markOfflineFeedbackDelivered?: boolean;
  readonly feedbackNoteOnly?: boolean;
  readonly leakBlockedBody?: boolean;
  readonly crossDeliverFeedback?: boolean;
  readonly unstableReasonAfterRestart?: boolean;
  readonly consumeOnDecisionPersistFailure?: boolean;
  readonly duplicateDecisionOnRetry?: boolean;
  readonly omitProjectionGaps?: boolean;
  readonly truncationMetadataNotModelVisible?: boolean;
  readonly leakHiddenProjection?: boolean;
  readonly allowRevokedSourceRead?: boolean;
  readonly wrongSourceRead?: boolean;
  readonly useStaleRoster?: boolean;
  readonly skipReturnedResultRecord?: boolean;
  readonly acceptStaleTarget?: boolean;
  readonly acceptForgedTarget?: boolean;
  readonly starveOtherMembers?: boolean;
  readonly synchronousHoldFailure?: boolean;
  readonly neverTimeoutHeld?: boolean;
  readonly unboundedMemberRetries?: boolean;
  readonly washFailuresOnRestart?: boolean;
  readonly dropFailureFeedback?: boolean;
  readonly falseFailurePresenceReceipt?: boolean;
  /** #206 review 3: the host keeps no record at all for the self-declared-root stimulus. */
  readonly omitSelfRootRecord?: boolean;
  /** #206 review 3: forged controls are silently dropped without an explicit rejected record. */
  readonly omitFalseControlRecords?: boolean;
  /** #206 review 3: two pressured decision states are swapped between their operations. */
  readonly permuteDeliveryStates?: boolean;
  /** #206 review 3: every projection mode includes nothing, omitting the whole authorized set. */
  readonly omitAllProjected?: boolean;
  /** #206 review 3: the cutoff-stopped late result is dropped without a rejected record. */
  readonly omitStoppedResultRejection?: boolean;
  /** #206 review 3: the first failing attempt is numbered far beyond the configured bound. */
  readonly forgeAttemptOutOfBound?: boolean;
  /** #206 review 4: every forged control's rejected record is written twice. */
  readonly duplicateFalseControlRecord?: boolean;
  /** #206 review 4: the batch projection repeats one authorized id while dropping another. */
  readonly duplicateProjectedId?: boolean;
  /** #206 review 4: every returned gc12-tuple target is washed into the same residentId variant. */
  readonly washForgedTupleTargets?: boolean;
  /** #206 review 5: a receipt signed by a resident (seen/已读/记住) appears at record time. */
  readonly proxySignedReceiptAtRecord?: boolean;
  /** #206 review 5: an unreachable control reports an extra effective row next to incomplete. */
  readonly unreachableAlsoEffective?: boolean;
  /** #206 review 5: the generation-change stimulus is washed into a zero-cost human trigger. */
  readonly identityChangeAsHumanTrigger?: boolean;
  /** #206 review 5: the B=1 world's turn-1/turn-2 records carry each other's operationId. */
  readonly swapBoundedTurnRecords?: boolean;
  /** #206 review 5: truncation originalLength is forged to kept+1 and the context synced. */
  readonly forgeTruncationMetadata?: boolean;
  /** #206 review 5: the forged envelope is recorded twice, defeating unique-match readbacks. */
  readonly duplicateForgedEnvelope?: boolean;
  /** #206 review 8: continue wipes the cutoff state, reviving pre-stop permits afterwards. */
  readonly clearCutoffOnContinue?: boolean;
  /** #206 review 8: the granted source read returns only the truncated prefix of the body. */
  readonly truncateSourceReadBody?: boolean;
  /** #206 review 8: GC-08 delivery decisions are recorded under the other resident's id. */
  readonly misattributeDecisionSender?: boolean;
  /** #206 review 8: GC-08 sender feedback is recorded under the other resident's id. */
  readonly misattributeFeedbackSender?: boolean;
  /** #206 review 9: post-continue cutoff rows carry a washed dispatchId on the ledger. */
  readonly washPostContinueTarget?: boolean;
}

interface SyntheticSubmission {
  readonly operationId: string;
  readonly rootId: string;
  readonly residentId: ResidentId;
  readonly body: string;
  readonly target: DispatchIdentity | null;
  persistFailed: boolean;
}

interface ProjectionSource {
  readonly eventId: string;
  readonly body: string;
  readonly authorized: boolean;
}

/** Test-only host model; production runner never imports this adapter. */
class SyntheticGroupChatHost implements GroupChatHostDriver {
  readonly kind = "mist-host" as const;
  readonly options: TestOptions;
  private events: RoomEvent[] = [];
  private eventTime = new Map<string, number>();
  private roomCounters = new Map<string, number>();
  private clock = 1;
  private deliveries = new Map<string, DeliveryRecord[]>();
  private memories: MemoryRecord[] = [];
  private privateContexts = new Map<ResidentId, string[]>();
  private roster = new Set<ResidentId>([fixture.residentIds.a, fixture.residentIds.b]);
  private joinedAt = new Map<ResidentId, number>();
  private rosterVersion = 1;
  private projections = new Map<RosterPath, RosterProjection>();
  private decisions: MentionDecision[] = [];
  private callLedger: CallReceipt[] = [];
  private callCounter = 0;
  private receipts: SystemReceipt[] = [];
  private commits: ContextCommit[] = [];
  private reactions: ResidentReaction[] = [];
  private rooms = new Map<string, { visibility: "public" | "hidden"; body: string }>();
  private gateStopped = false;
  private gateTurnOpen = true;
  private crossResidentPrivateReads = 0;
  private unauthorizedReadResults: string[] = [];
  private hostPid = 12345;
  private hostCommit = "synthetic-test-only";
  private scenarioId: GroupChatCheckId = "GC-01";
  /** The owner binding is trusted only after resetScenario registers the judge-owned setup grant. */
  private trustedOwnerBinding: string | null = null;
  private sequence = 0;
  private roundRecords: RoundRecord[] = [];
  private policy: {
    rootId: string;
    policyVersion: string;
    turnBudget: number | null;
    deadlineTicks: number;
    maxMemberAttempts: number;
  } | null = null;
  private knownRoots = new Set<string>();
  private consumedByRoot = new Map<string, number>();
  private submissions = new Map<string, SyntheticSubmission>();
  private memberBehaviors = new Map<ResidentId, MemberBehavior>();
  private pressure = new Map<ResidentId, PressureMode>();
  private schedulerTick = 0;
  private ordinaryQueueDepth = 0;
  private held = new Map<
    string,
    SyntheticSubmission & { readonly startedAt: number; readonly issuedControlSequence: number }
  >();
  private stopped = new Set<ResidentId>();
  private controlRecords: ControlRecord[] = [];
  private lastStopSequence = new Map<ResidentId, number>();
  private externalEffects = new Set<ResidentId>();
  private deliveryDecisions: DeliveryDecisionRecord[] = [];
  private feedback: SenderFeedbackRecord[] = [];
  private senderOnline = new Map<ResidentId, boolean>();
  private nextDecisionPersistFault = false;
  private nextDispatchFaultFor: ResidentId | null = null;
  private projectionSources: ProjectionSource[] = [];
  private projectionReceipts: ProjectionReceipt[] = [];
  private projectionContexts = new Map<ResidentId, string[]>();
  private sourceReads: SourceReadAudit[] = [];
  private roomAccess = new Map<ResidentId, boolean>();
  private roomMembers = new Set<ResidentId>([fixture.residentIds.a, fixture.residentIds.b]);
  private currentTarget: DispatchIdentity | null = null;
  private attempts: MemberAttemptRecord[] = [];
  private results: MemberResultRecord[] = [];

  constructor(options: TestOptions = {}) {
    this.options = options;
  }

  async startHost() {
    return { pid: this.hostPid, commit: this.hostCommit };
  }
  async restartHost() {
    if (!this.options.reuseRestartPid) this.hostPid += 1;
    if (this.options.changeRestartCommit) this.hostCommit = "synthetic-test-changed";
    if (this.options.resetRoundOnRestart) this.consumedByRoot.clear();
    if (this.options.washFailuresOnRestart) {
      this.attempts = this.attempts.filter((row) => row.outcome === "completed");
      this.roundRecords = this.roundRecords.filter((row) => row.decision !== "failed");
      this.feedback = [];
    }
    if (this.options.unstableReasonAfterRestart) {
      this.deliveryDecisions = this.deliveryDecisions.map((row) => ({
        ...row,
        reasonCode: `${row.reasonCode}:changed`,
      }));
      this.feedback = this.feedback.map((row) => ({
        ...row,
        reasonCode: `${row.reasonCode}:changed`,
      }));
    }
    return { pid: this.hostPid, commit: this.hostCommit };
  }
  async stopHost(): Promise<void> {}

  async resetScenario(id: GroupChatCheckId, setup: typeof fixture): Promise<void> {
    this.scenarioId = id;
    // Setup grant: the only moment the owner binding becomes trusted. A perform() command
    // carrying the same string is still untrusted request input and proves nothing alone.
    this.trustedOwnerBinding = setup.trustedOwnerBinding;
    this.events = [];
    this.eventTime.clear();
    this.roomCounters.clear();
    this.clock = 1;
    this.deliveries.clear();
    this.memories = [];
    this.privateContexts.clear();
    this.roster = new Set([fixture.residentIds.a, fixture.residentIds.b]);
    this.joinedAt = new Map<ResidentId, number>([
      [fixture.residentIds.a, 0],
      [fixture.residentIds.b, 0],
    ]);
    this.rosterVersion = 1;
    this.projections.clear();
    this.decisions = [];
    // A durable ledger may survive a scenario reset; the judge must only count its own window.
    this.callLedger = this.options.preexistingCall
      ? [{ id: "call:before-scenario", targetId: fixture.residentIds.a }]
      : [];
    this.callCounter = 0;
    this.receipts = [];
    this.commits = [];
    this.reactions = [];
    this.rooms.clear();
    this.gateStopped = false;
    this.gateTurnOpen = true;
    this.crossResidentPrivateReads = 0;
    this.unauthorizedReadResults = [];
    this.sequence = 0;
    this.roundRecords = [];
    this.policy = null;
    this.knownRoots.clear();
    this.consumedByRoot.clear();
    this.submissions.clear();
    this.memberBehaviors.clear();
    this.pressure.clear();
    this.schedulerTick = 0;
    this.ordinaryQueueDepth = 0;
    this.held.clear();
    this.stopped.clear();
    this.controlRecords = [];
    this.lastStopSequence.clear();
    this.externalEffects.clear();
    this.deliveryDecisions = [];
    this.feedback = [];
    this.senderOnline.clear();
    this.nextDecisionPersistFault = false;
    this.nextDispatchFaultFor = null;
    this.projectionSources = [];
    this.projectionReceipts = [];
    this.projectionContexts.clear();
    this.sourceReads = [];
    this.roomAccess.clear();
    this.roomMembers = new Set([fixture.residentIds.a, fixture.residentIds.b]);
    this.currentTarget = null;
    this.attempts = [];
    this.results = [];
  }

  /** Per-room event ids: a global counter would itself reveal hidden-room traffic (GC-15). */
  private addEvent(event: Omit<RoomEvent, "id" | "position">): void {
    const next = (this.roomCounters.get(event.roomId) ?? 0) + 1;
    this.roomCounters.set(event.roomId, next);
    const id = `event:${event.roomId}#${next}`;
    this.eventTime.set(id, this.clock++);
    this.events.push({ ...event, id, position: this.options.duplicatePositions ? 1 : next });
  }

  private call(targetId: string): string {
    this.callCounter += 1;
    const id = `call:${this.callCounter}`;
    this.callLedger.push({ id, targetId });
    return id;
  }

  private decide(decision: MentionDecision): void {
    const recorded = this.options.blankReason ? { ...decision, reason: "" } : decision;
    this.decisions.push(recorded);
    if (this.options.duplicateDecision && decision.outcome === "accepted")
      this.decisions.push({ ...recorded });
  }

  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private consumed(rootId: string): number {
    return this.consumedByRoot.get(rootId) ?? 0;
  }

  private appendRound(
    input: Omit<RoundRecord, "sequence" | "consumedTurns" | "policyVersion" | "target"> & {
      readonly target?: DispatchIdentity | null;
    },
  ): void {
    // Review probe: the B=1 bounded world mislabels turn-1/turn-2 records with each other's
    // operationId — a count-only judge stays green, an operationId-pinned judge goes red.
    const operationId =
      this.options.swapBoundedTurnRecords && this.scenarioId === "GC-06"
        ? input.operationId === "gc06-B1-turn-1"
          ? "gc06-B1-turn-2"
          : input.operationId === "gc06-B1-turn-2"
            ? "gc06-B1-turn-1"
            : input.operationId
        : input.operationId;
    this.roundRecords.push({
      sequence: this.nextSequence(),
      consumedTurns: this.consumed(input.rootId),
      policyVersion: this.policy?.policyVersion ?? null,
      ...input,
      operationId,
      target: this.options.omitRoundTarget ? null : (input.target ?? null),
    });
  }

  private sameTarget(left: DispatchIdentity | null, right: DispatchIdentity | null): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  private appendDecision(
    input: Omit<DeliveryDecisionRecord, "sequence" | "count" | "rosterVersion">,
  ): void {
    const count =
      this.deliveryDecisions.filter(
        (row) => row.operationId === input.operationId && row.state !== "persist-failed",
      ).length + (input.state === "persist-failed" ? 0 : 1);
    this.deliveryDecisions.push({
      sequence: this.nextSequence(),
      count,
      rosterVersion: this.rosterVersion,
      ...input,
      // Review probe: a decision recorded under another resident's id must fail sender binding.
      senderId:
        this.options.misattributeDecisionSender && this.scenarioId === "GC-08"
          ? fixture.residentIds.b
          : input.senderId,
    });
  }

  private appendFeedback(submission: SyntheticSubmission, reasonCode: string, count = 1): void {
    if (this.options.dropFailureFeedback && this.scenarioId === "GC-16") return;
    const online = this.senderOnline.get(submission.residentId) ?? true;
    this.feedback.push({
      operationId: submission.operationId,
      // Review probe: feedback recorded under another resident's id must fail sender binding.
      senderId:
        this.options.misattributeFeedbackSender && this.scenarioId === "GC-08"
          ? fixture.residentIds.b
          : submission.residentId,
      roomId: fixture.roomId,
      scopeId: submission.target?.scopeId ?? "test-scope:room",
      reasonCode,
      count,
      phase: online || this.options.markOfflineFeedbackDelivered ? "delivered" : "pending",
      deliveryReceipt:
        online || this.options.markOfflineFeedbackDelivered
          ? `feedback-receipt:${submission.operationId}`
          : null,
      body: this.options.leakBlockedBody
        ? submission.body
        : this.options.feedbackClaimsMemberRead
          ? `${submission.residentId} 已读完配置`
          : null,
    });
  }

  private appendAttempt(
    operationId: string,
    memberId: ResidentId,
    outcome: MemberAttemptRecord["outcome"],
    reasonCode: string | null,
  ): void {
    // Review probe: a single attempt numbered far past the configured bound must still go red.
    const attempt =
      this.options.forgeAttemptOutOfBound &&
      outcome === "failed" &&
      !this.attempts.some((row) => row.operationId === operationId && row.memberId === memberId)
        ? 999
        : this.attempts.filter(
            (row) => row.operationId === operationId && row.memberId === memberId,
          ).length + 1;
    this.attempts.push({
      sequence: this.nextSequence(),
      operationId,
      memberId,
      attempt,
      outcome,
      reasonCode,
    });
  }

  private decisionForPressure(submission: SyntheticSubmission, mode: PressureMode): void {
    let state: DeliveryDecisionRecord["state"] =
      mode === "batch"
        ? "batched"
        : mode === "not-included"
          ? "not-included"
          : mode === "stopped"
            ? "stop-blocked"
            : "queued";
    // Review probe: states swapped between operations — the judge must pin state to operationId.
    if (this.options.permuteDeliveryStates) {
      if (state === "batched") state = "not-included";
      else if (state === "not-included") state = "batched";
    }
    const reasonCode =
      mode === "batch"
        ? "ROOM_BATCHED"
        : mode === "not-included"
          ? "ROOM_NOT_INCLUDED"
          : mode === "stopped"
            ? "ROOM_STOPPED"
            : "ROOM_COOLING";
    this.appendDecision({
      operationId: submission.operationId,
      senderId: submission.residentId,
      state,
      reasonCode,
      permitConsumed: mode !== "cooling",
      target: submission.target,
    });
    if (mode !== "cooling") this.appendFeedback(submission, reasonCode);
  }

  private processMemberTurn(submission: SyntheticSubmission, claimedRootId?: string): void {
    if (
      this.options.identityChangeAsHumanTrigger &&
      submission.operationId === "gc06-identity-change"
    ) {
      // Review probe: the generation-change stimulus washed into a zero-cost human trigger —
      // the judge must require exactly one reasoned blocked record from the host's own ledger.
      this.roundRecords.push({
        sequence: this.nextSequence(),
        operationId: submission.operationId,
        rootId: submission.rootId,
        senderId: fixture.humanId,
        policyVersion: this.policy?.policyVersion ?? null,
        decision: "human-trigger",
        consumedTurns: 0,
        reasonCode: null,
        target: submission.target,
      });
      return;
    }
    const policyValid =
      this.policy !== null &&
      Number.isSafeInteger(this.policy.turnBudget) &&
      (this.policy.turnBudget ?? 0) > 0;
    if (!policyValid && !this.options.dispatchWithInvalidPolicy) {
      this.appendRound({
        operationId: submission.operationId,
        rootId: submission.rootId,
        senderId: submission.residentId,
        decision: "blocked",
        reasonCode: "ROOM_POLICY_INVALID",
        target: submission.target,
      });
      return;
    }
    if (
      claimedRootId !== undefined &&
      claimedRootId !== submission.rootId &&
      !this.options.acceptSelfDeclaredRoot
    ) {
      this.appendRound({
        operationId: submission.operationId,
        rootId: submission.rootId,
        senderId: submission.residentId,
        decision: "blocked",
        reasonCode: "ROOM_ROOT_FORGED",
        target: submission.target,
      });
      return;
    }
    if (!this.knownRoots.has(submission.rootId) && !this.options.acceptSelfDeclaredRoot) {
      this.appendRound({
        operationId: submission.operationId,
        rootId: submission.rootId,
        senderId: submission.residentId,
        decision: "blocked",
        reasonCode: "ROOM_ROOT_UNKNOWN",
        target: submission.target,
      });
      return;
    }
    const pressure = this.pressure.get(submission.residentId) ?? "normal";
    if (this.nextDecisionPersistFault) {
      this.nextDecisionPersistFault = false;
      submission.persistFailed = true;
      this.appendDecision({
        operationId: submission.operationId,
        senderId: submission.residentId,
        state: "persist-failed",
        reasonCode: "ROOM_DECISION_PERSIST_FAILED",
        permitConsumed: this.options.consumeOnDecisionPersistFailure === true,
        target: submission.target,
      });
      if (this.options.consumeOnDecisionPersistFailure) {
        this.consumedByRoot.set(submission.rootId, this.consumed(submission.rootId) + 1);
      }
      return;
    }
    if (pressure !== "normal") {
      this.decisionForPressure(submission, pressure);
      return;
    }
    if (this.nextDispatchFaultFor === submission.residentId) {
      this.nextDispatchFaultFor = null;
      this.appendDecision({
        operationId: submission.operationId,
        senderId: submission.residentId,
        state: "dispatch-failed",
        reasonCode: "ROOM_DISPATCH_FAILED",
        permitConsumed: true,
        target: submission.target,
      });
      this.appendFeedback(submission, "ROOM_DISPATCH_FAILED");
      this.appendAttempt(
        submission.operationId,
        submission.residentId,
        "failed",
        "ROOM_DISPATCH_FAILED",
      );
      return;
    }
    if (
      this.options.resetBudgetOnIdentityChange &&
      submission.operationId === "gc06-identity-change" &&
      this.roundRecords.some(
        (row) => row.senderId !== submission.residentId && row.senderId !== fixture.humanId,
      )
    ) {
      this.consumedByRoot.set(submission.rootId, 0);
    }
    const budget = this.policy?.turnBudget ?? (this.options.dispatchWithInvalidPolicy ? 1 : 0);
    if (!this.options.ignoreTurnBudget && this.consumed(submission.rootId) >= budget) {
      this.appendRound({
        operationId: submission.operationId,
        rootId: submission.rootId,
        senderId: submission.residentId,
        decision: "blocked",
        reasonCode: "ROOM_TURN_BUDGET_EXHAUSTED",
        target: submission.target,
      });
      return;
    }
    if (this.stopped.has(submission.residentId)) {
      this.appendRound({
        operationId: submission.operationId,
        rootId: submission.rootId,
        senderId: submission.residentId,
        decision: "blocked",
        reasonCode: "ROOM_MEMBER_STOPPED",
        target: submission.target,
      });
      return;
    }
    this.consumedByRoot.set(submission.rootId, this.consumed(submission.rootId) + 1);
    const behavior = this.memberBehaviors.get(submission.residentId) ?? "complete";
    if (behavior === "pass") {
      if (!this.options.omitPassRecord)
        this.appendRound({
          operationId: submission.operationId,
          rootId: submission.rootId,
          senderId: submission.residentId,
          decision: "passed",
          reasonCode: null,
          target: submission.target,
        });
      return;
    }
    if (behavior === "fail") {
      if (!this.options.omitFailureRecord)
        this.appendRound({
          operationId: submission.operationId,
          rootId: submission.rootId,
          senderId: submission.residentId,
          decision: "failed",
          reasonCode: "ROOM_MEMBER_FAILED",
          target: submission.target,
        });
      this.appendAttempt(
        submission.operationId,
        submission.residentId,
        "failed",
        "ROOM_MEMBER_FAILED",
      );
      this.appendDecision({
        operationId: submission.operationId,
        senderId: submission.residentId,
        state: "dispatch-failed",
        reasonCode: "ROOM_MEMBER_FAILED",
        permitConsumed: true,
        target: submission.target,
      });
      this.appendFeedback(submission, "ROOM_MEMBER_FAILED");
      if (this.options.falseFailurePresenceReceipt)
        this.receipts.push({ actor: "system", phase: "seen", claim: "成员已读且讨论有产出" });
      if (this.options.failureReceiptClaimsMemberRead)
        this.receipts.push({
          actor: "system",
          phase: "failed",
          // 记忆类声称：旧的 falsePresence 正则不管记忆，只有共享判卷能拦。
          claim: `${submission.residentId} 已写入记忆`,
        });
      return;
    }
    if (behavior === "hold") {
      if (this.options.synchronousHoldFailure) {
        this.appendRound({
          operationId: submission.operationId,
          rootId: submission.rootId,
          senderId: submission.residentId,
          decision: "failed",
          reasonCode: "SYNCHRONOUS_THROW",
          target: submission.target,
        });
        this.appendAttempt(
          submission.operationId,
          submission.residentId,
          "failed",
          "SYNCHRONOUS_THROW",
        );
        return;
      }
      this.appendRound({
        operationId: submission.operationId,
        rootId: submission.rootId,
        senderId: submission.residentId,
        decision: "held",
        reasonCode: null,
        target: submission.target,
      });
      this.appendAttempt(submission.operationId, submission.residentId, "in-flight", null);
      this.held.set(submission.operationId, {
        ...submission,
        startedAt: this.schedulerTick,
        issuedControlSequence: this.sequence,
      });
      return;
    }
    if (
      this.options.starveOtherMembers &&
      submission.operationId === "gc16-normal-member" &&
      submission.residentId === fixture.residentIds.b &&
      this.attempts.some(
        (row) => row.memberId === fixture.residentIds.a && row.outcome !== "completed",
      )
    )
      return;
    this.appendRound({
      operationId: submission.operationId,
      rootId: submission.rootId,
      senderId: submission.residentId,
      decision: "permitted",
      reasonCode: null,
      target: submission.target,
    });
    this.appendAttempt(submission.operationId, submission.residentId, "completed", null);
    this.addEvent({
      roomId: fixture.roomId,
      authorId: submission.residentId,
      body: submission.body,
      visibility: "public",
    });
  }

  async perform(command: GroupChatCommand): Promise<void> {
    switch (command.kind) {
      case "post": {
        if (this.options.dropForgedBodyPost && command.body.includes("TEST-GC01-BODY-FORGERY"))
          return;
        if (this.options.duplicateForgedEnvelope && command.claimedAuthorId !== undefined) {
          // Review probe: the forged envelope is recorded twice; a unique-match readback
          // ("multiple => null") would wash the acceptance into a false green.
          for (let copy = 0; copy < 2; copy += 1)
            this.addEvent({
              roomId: command.roomId,
              authorId: command.principalId,
              body: command.body,
              visibility: "public",
            });
          return;
        }
        const valid =
          command.roomId !== "" &&
          command.visibility === "public" &&
          command.binding === this.trustedOwnerBinding &&
          command.privateFields === undefined &&
          command.claimedAuthorId === undefined;
        const defects = [
          command.visibility !== "public" ? "visibility" : null,
          command.roomId === "" ? "room" : null,
          command.binding !== this.trustedOwnerBinding ? "binding" : null,
          command.privateFields !== undefined ? "private-fields" : null,
          command.claimedAuthorId !== undefined ? "claimed-author" : null,
        ].filter((defect) => defect !== null);
        const toleratedDefect =
          command.principalId !== fixture.humanId &&
          defects.length === 1 &&
          defects[0] === this.options.acceptOnlyInvalid;
        if (
          !valid &&
          !toleratedDefect &&
          !this.options.acceptInvalidPosts &&
          !this.options.acceptForged
        )
          return;
        const bodyAuthor = this.options.trustBodyAuthorHeader
          ? command.body.match(/^From:\s*([^\r\n]+)/mu)?.[1]
          : undefined;
        const actualAuthor =
          command.claimedAuthorId && this.options.acceptForged
            ? command.claimedAuthorId
            : (bodyAuthor ?? command.principalId);
        const privateContext = this.privateContexts.get(command.principalId as ResidentId) ?? [];
        const body = command.privateFields
          ? `${command.body} ${command.privateFields.join(" ")}`
          : this.options.leakPrivateCanariesIntoRoom &&
              command.body === "TEST-GC02-VALID" &&
              privateContext.length > 0
            ? `${command.body} ${privateContext.join(" ")}`
            : command.body;
        this.addEvent({
          roomId: command.roomId,
          authorId: actualAuthor,
          body,
          visibility: command.visibility ?? "hidden",
        });
        return;
      }
      case "save-memory": {
        const event = this.events.find(({ id }) => id === command.sourceEventId);
        if (event) {
          this.memories.push({
            residentId: command.residentId,
            sourceEventId: this.options.wrongMemorySource ? "event:wrong" : event.id,
            body: event.body,
          });
        }
        return;
      }
      case "seed-resident-private": {
        if (this.options.noopSeedPrivate) return;
        const targets: ResidentId[] = this.options.leakPrivateCanaries
          ? [fixture.residentIds.a, fixture.residentIds.b, fixture.residentIds.c]
          : [command.residentId];
        for (const target of targets) {
          const context = this.privateContexts.get(target) ?? [];
          context.push(command.canary);
          this.privateContexts.set(target, context);
        }
        return;
      }
      case "set-delivery-state": {
        if (this.options.skipDeliveryFor === command.residentId) return;
        const event = this.events.find((item) => item.body.includes(command.eventMarker));
        if (!event) return;
        const rows = this.deliveries.get(event.id) ?? [];
        rows.push({ residentId: command.residentId, state: command.state });
        this.deliveries.set(event.id, rows);
        return;
      }
      case "register-resident":
        if (!this.roster.has(command.residentId)) {
          this.roster.add(command.residentId);
          this.joinedAt.set(command.residentId, this.clock);
          if (!this.options.noRosterVersionBump) this.rosterVersion += 1;
        }
        return;
      case "exercise-roster-path": {
        if (this.options.skipRosterPath === command.path) return;
        const hardcoded = this.options.projectionsHardcode;
        const residentIds =
          hardcoded === undefined
            ? [...this.roster]
            : [...this.roster].filter(
                (id) =>
                  id === fixture.residentIds.a || id === fixture.residentIds.b || id === hardcoded,
              );
        this.projections.set(command.path, { residentIds, humanIds: [fixture.humanId] });
        return;
      }
      case "plain-text-mention": {
        if (this.options.omitPlainDecisions) return;
        const target = fixture.residentIds.b;
        const bareName = command.body.replaceAll(`@${target}`, "").includes(target);
        const routed =
          this.options.routePlainText === true || (this.options.routeBareName === true && bareName);
        // Review probe: the call happens, but this operation's decision does not cite it.
        if (this.options.plainCallOffDecision) this.call(target);
        this.decide({
          operationId: command.operationId,
          outcome: routed ? "accepted" : "rejected",
          reason: routed ? "text-mention" : "no-structured-target",
          targetId: routed || this.options.resolvePlainTextTarget ? target : null,
          callReceiptIds: routed ? [this.call(target)] : [],
        });
        return;
      }
      case "structured-mention": {
        const validTarget = [...this.roster].includes(command.targetId as ResidentId);
        const gateClosed = this.gateStopped || !this.gateTurnOpen;
        const operationId = command.operationId;
        if (this.options.rewriteLedger)
          this.callLedger = this.callLedger.filter(({ id }) => id !== "call:before-scenario");
        // Review probe: calls made while the gate is closed, with no decision at all.
        if (gateClosed && this.options.gatedCallsWithoutDecision) {
          this.call(command.targetId);
          return;
        }
        if (!validTarget && !gateClosed && this.options.acceptUnknownTargetWithoutCall) {
          this.decide({
            operationId,
            outcome: "accepted",
            reason: "unchecked-target",
            targetId: command.targetId,
            callReceiptIds: [],
          });
          return;
        }
        if (
          gateClosed &&
          validTarget &&
          (this.options.holdGatedMentions || this.options.heldButCalled)
        ) {
          if (this.options.heldButCalled) this.call(command.targetId);
          this.decide({
            operationId,
            outcome: "held",
            reason: "gate-closed",
            targetId: command.targetId,
            callReceiptIds: [],
          });
          return;
        }
        const rejected = gateClosed || !validTarget || this.options.deadRouter === true;
        const calls = !rejected || (gateClosed && this.options.bypassGate === true);
        // Review probe: extra calls outside every decision (the NOT-A-JUDGE-MARKER rows).
        if (calls && !gateClosed && this.options.orphanCalls)
          for (let extra = 0; extra < 5; extra += 1) this.call(command.targetId);
        let callReceiptIds: string[] = [];
        if (calls && this.options.phantomReceipt) callReceiptIds = ["call:never-made"];
        else if (calls)
          callReceiptIds = [
            this.call(this.options.wrongTargetReceipt ? fixture.residentIds.a : command.targetId),
          ];
        this.decide({
          operationId,
          outcome: calls ? "accepted" : "rejected",
          reason: calls ? "structured-target" : gateClosed ? "gate-closed" : "invalid-target",
          targetId: validTarget ? command.targetId : null,
          callReceiptIds,
        });
        return;
      }
      case "set-turn-gate":
        this.gateStopped = command.stopped;
        this.gateTurnOpen = command.turnOpen;
        return;
      case "record-event": {
        this.addEvent({
          roomId: command.roomId,
          authorId: command.authorId,
          body: command.body,
          visibility: "public",
        });
        const claim = this.options.claimOverride ?? "系统已收，成员尚未派发";
        this.receipts.push({ actor: "system", phase: "recorded", claim });
        if (this.options.proxySignedReceiptAtRecord) {
          // Review probe: a resident-signed personal-state receipt before any reaction must stay red
          // even after that resident later reacts for real.
          this.receipts.push({
            actor: fixture.residentIds.a,
            phase: "seen",
            claim: "成员已读并记住了",
          });
        }
        if (this.options.publishFutureReceiptsEarly) {
          this.receipts.push({ actor: "system", phase: "dispatched", claim });
          this.receipts.push({
            actor: "system",
            phase: "context-committed",
            claim: "仍不等于理解或记忆",
            contextCommitRef: "context-commit:premature",
          });
        }
        return;
      }
      case "dispatch-event": {
        if (!this.events.some((event) => event.body.includes(command.eventMarker))) return;
        const claim = this.options.claimOverride ?? "已派发，尚未装入成员上下文";
        this.receipts.push({ actor: "system", phase: "dispatched", claim });
        if (this.options.extraSystemPhase !== undefined) {
          this.receipts.push({
            actor: "system",
            phase: this.options.extraSystemPhase,
            claim: "排队等待装入",
          });
        }
        if (this.options.proxyReaction) {
          this.reactions.push({
            residentId: fixture.residentIds.a,
            eventMarker: command.eventMarker,
          });
        }
        if (this.options.forgedResidentReceipt) {
          this.receipts.push({ actor: fixture.residentIds.b, phase: "reaction" });
        }
        return;
      }
      case "commit-context": {
        const id = `context-commit:${this.clock++}`;
        this.commits.push({ id, residentId: command.residentId, marker: command.marker });
        this.receipts.push({
          actor: "system",
          phase: "context-committed",
          claim: this.options.claimOverride ?? "已装入，不代表理解",
          contextCommitRef: this.options.contextCommitRef ?? id,
        });
        if (this.options.commitWritesMemory) {
          this.memories.push({
            residentId: command.residentId,
            sourceEventId: null,
            body: command.marker,
          });
        }
        return;
      }
      case "react":
        this.reactions.push({ residentId: command.residentId, eventMarker: command.eventMarker });
        if (this.options.residentReceiptAfterReaction) {
          this.receipts.push({ actor: command.residentId, phase: "reaction" });
        }
        return;
      case "create-room":
        if (this.options.noHiddenRoom && command.visibility === "hidden") return;
        this.rooms.set(command.roomId, { visibility: command.visibility, body: command.body });
        this.addEvent({
          roomId: command.roomId,
          authorId: "test-host:room-seed",
          body: command.body,
          visibility: command.visibility,
        });
        return;
      case "replay-public-payload": {
        if (!this.options.acceptCrossRoomReplay) return;
        const source = this.events.find(
          (event) =>
            event.roomId === command.sourceRoomId && event.body.includes(command.eventMarker),
        );
        const target = this.rooms.get(command.targetRoomId);
        if (source && target) {
          this.addEvent({
            roomId: command.targetRoomId,
            authorId: source.authorId,
            body: source.body,
            visibility: target.visibility,
          });
        }
        return;
      }
      case "attempt-room-read": {
        const room = this.rooms.get(command.roomId);
        const allowed = room?.visibility === "public" && command.viewerId === fixture.humanId;
        if (room?.visibility === "hidden" && !allowed) {
          this.unauthorizedReadResults.push("not-found");
          if (this.options.leakHiddenToUnauthorized) this.crossResidentPrivateReads += 1;
        }
        if (room?.visibility === "hidden" && allowed) this.crossResidentPrivateReads += 1;
        return;
      }
      case "attempt-resident-scope-read": {
        if (this.options.silentScopeRead) return;
        this.unauthorizedReadResults.push("not-found");
        if (this.options.leakResidentScope) {
          const owner = this.privateContexts.get(command.ownerId) ?? [];
          const viewer = this.privateContexts.get(command.viewerId) ?? [];
          this.privateContexts.set(command.viewerId, [...viewer, ...owner]);
        }
        return;
      }
      case "configure-orchestration":
        this.policy = {
          rootId: command.rootId,
          policyVersion: command.policyVersion,
          turnBudget: command.turnBudget,
          deadlineTicks: command.deadlineTicks,
          maxMemberAttempts: command.maxMemberAttempts,
        };
        return;
      case "human-trigger":
        this.knownRoots.add(command.rootId);
        if (!this.consumedByRoot.has(command.rootId)) this.consumedByRoot.set(command.rootId, 0);
        this.appendRound({
          operationId: command.operationId,
          rootId: command.rootId,
          senderId: fixture.humanId,
          decision: "human-trigger",
          reasonCode: null,
        });
        this.addEvent({
          roomId: fixture.roomId,
          authorId: fixture.humanId,
          body: command.body,
          visibility: "public",
        });
        return;
      case "member-turn": {
        // Review probe: the self-declared-root stimulus vanishes without any record.
        if (this.options.omitSelfRootRecord && command.claimedRootId !== undefined) return;
        const effectiveRoot =
          this.options.acceptSelfDeclaredRoot && command.claimedRootId !== undefined
            ? command.claimedRootId
            : command.rootId;
        if (this.options.acceptSelfDeclaredRoot && command.claimedRootId !== undefined) {
          this.knownRoots.add(effectiveRoot);
          if (!this.consumedByRoot.has(effectiveRoot)) this.consumedByRoot.set(effectiveRoot, 0);
        }
        const submission: SyntheticSubmission = {
          operationId: command.operationId,
          rootId: effectiveRoot,
          residentId: command.residentId,
          body: command.body,
          target: command.target ?? this.currentTarget,
          persistFailed: false,
        };
        this.submissions.set(command.operationId, submission);
        this.processMemberTurn(submission, command.claimedRootId);
        return;
      }
      case "retry-operation": {
        const submission = this.submissions.get(command.operationId);
        if (submission === undefined) return;
        if (submission.persistFailed) {
          submission.persistFailed = false;
          this.processMemberTurn(submission);
          if (this.options.duplicateDecisionOnRetry) this.processMemberTurn(submission);
          return;
        }
        if (this.options.duplicateRetry) {
          this.consumedByRoot.set(submission.rootId, this.consumed(submission.rootId) + 1);
          this.appendRound({
            operationId: submission.operationId,
            rootId: submission.rootId,
            senderId: submission.residentId,
            decision: "permitted",
            reasonCode: null,
            target: submission.target,
          });
          this.addEvent({
            roomId: fixture.roomId,
            authorId: submission.residentId,
            body: submission.body,
            visibility: "public",
          });
          return;
        }
        this.appendRound({
          operationId: submission.operationId,
          rootId: submission.rootId,
          senderId: submission.residentId,
          decision: "retry-replayed",
          reasonCode: null,
          target: submission.target,
        });
        return;
      }
      case "set-member-behavior":
        this.memberBehaviors.set(command.residentId, command.behavior);
        return;
      case "set-pressure":
        this.pressure.set(command.residentId, command.mode);
        return;
      case "advance-scheduler": {
        this.schedulerTick += command.ticks;
        for (const [operationId, submission] of this.submissions) {
          const failures = this.attempts.filter(
            (row) => row.operationId === operationId && row.outcome === "failed",
          ).length;
          if (failures > 0) {
            const limit = this.options.unboundedMemberRetries
              ? failures + command.ticks
              : (this.policy?.maxMemberAttempts ?? 1);
            for (let attempt = failures; attempt < limit; attempt += 1) {
              this.appendAttempt(
                operationId,
                submission.residentId,
                "failed",
                "ROOM_MEMBER_FAILED",
              );
              if (!this.options.unboundedMemberRetries) break;
            }
          }
        }
        for (const [operationId, held] of [...this.held]) {
          const deadline = this.policy?.deadlineTicks ?? 1;
          if (this.schedulerTick - held.startedAt < deadline || this.options.neverTimeoutHeld)
            continue;
          this.appendAttempt(operationId, held.residentId, "unknown", "ROOM_MEMBER_DEADLINE");
          this.appendDecision({
            operationId,
            senderId: held.residentId,
            state: "dispatch-failed",
            reasonCode: "ROOM_MEMBER_DEADLINE",
            permitConsumed: true,
            target: held.target,
          });
          this.appendFeedback(held, "ROOM_MEMBER_DEADLINE");
          this.held.delete(operationId);
        }
        return;
      }
      case "fill-ordinary-queue":
        this.ordinaryQueueDepth = this.options.emptyOrdinaryQueue ? 0 : command.depth;
        return;
      case "submit-control": {
        const valid =
          command.structured &&
          command.binding === "test-control-binding:owner" &&
          command.issuerId === fixture.humanId;
        if (!valid && !this.options.acceptFalseControl) {
          // Review probe: silently dropping a forged control leaves no rejected record to audit.
          if (!this.options.omitFalseControlRecords) {
            const rejected: ControlRecord = {
              sequence: this.nextSequence(),
              controlId: command.controlId,
              issuerId: command.issuerId,
              targetId: command.targetId,
              action: command.action,
              phase: "rejected",
              cutoffId: null,
              externalEffectReversed: false,
            };
            this.controlRecords.push(rejected);
            // Review probe: a duplicated rejected record must not count as exactly one.
            if (this.options.duplicateFalseControlRecord)
              this.controlRecords.push({ ...rejected, sequence: this.nextSequence() });
          }
          return;
        }
        const cutoffId = `control-cutoff:${command.controlId}`;
        const accepted: ControlRecord = {
          sequence: this.nextSequence(),
          controlId: command.controlId,
          issuerId: command.issuerId,
          targetId: command.targetId,
          action: command.action,
          phase: "accepted",
          cutoffId,
          externalEffectReversed:
            this.options.claimExternalEffectReversed === true &&
            this.externalEffects.has(command.targetId),
        };
        const reachable = this.roomMembers.has(command.targetId);
        if (!reachable && !this.options.reportUnreachableEffective) {
          // An unreachable target yields exactly one incomplete record: no accepted/effective
          // row and no cutoff, so the control ledger cannot wash the failure into a success.
          this.controlRecords.push({
            ...accepted,
            sequence: this.nextSequence(),
            phase: "incomplete",
            cutoffId: null,
          });
          // Review probe: an extra effective row next to the incomplete one must go red.
          if (this.options.unreachableAlsoEffective)
            this.controlRecords.push({
              ...accepted,
              sequence: this.nextSequence(),
              phase: "effective",
              cutoffId: null,
            });
          return;
        }
        if (!this.options.mergeControlReceipts) this.controlRecords.push(accepted);
        const blockedByOrdinaryQueue =
          this.options.controlSharesOrdinaryQueue && this.ordinaryQueueDepth > 0;
        const continueBlocked = this.options.continueDeadlocks && command.action === "continue";
        let phase: ControlRecord["phase"] = "effective";
        if (blockedByOrdinaryQueue || continueBlocked) phase = "accepted";
        const effective: ControlRecord = {
          ...accepted,
          sequence: this.nextSequence(),
          phase,
        };
        this.controlRecords.push(effective);
        if (phase === "effective") {
          if (command.action === "stop") {
            this.stopped.add(command.targetId);
            this.lastStopSequence.set(command.targetId, effective.sequence);
          } else {
            this.stopped.delete(command.targetId);
            // Review probe: wiping the cutoff state at continue revives pre-stop permits.
            if (this.options.clearCutoffOnContinue) this.lastStopSequence.delete(command.targetId);
          }
        }
        return;
      }
      case "mark-external-effect":
        this.externalEffects.add(command.targetId);
        return;
      case "set-sender-online":
        this.senderOnline.set(command.residentId, command.online);
        return;
      case "query-feedback": {
        if (this.options.feedbackNoteOnly) return;
        this.feedback = this.feedback.map((row) =>
          row.senderId === command.residentId
            ? {
                ...row,
                phase: "delivered" as const,
                deliveryReceipt: `feedback-receipt:${row.operationId}:${command.via}`,
              }
            : row,
        );
        return;
      }
      case "inject-next-fault":
        if (command.fault === "decision-persist") this.nextDecisionPersistFault = true;
        else this.nextDispatchFaultFor = command.residentId ?? fixture.residentIds.a;
        return;
      case "seed-projection-event":
        this.projectionSources.push({
          eventId: command.eventId,
          body: command.body,
          authorized: command.authorized,
        });
        return;
      case "request-projection": {
        const authorized = this.projectionSources.filter((item) => item.authorized);
        const hidden = this.projectionSources.filter((item) => !item.authorized);
        // Review probe: omit-everything — included stays empty, all authorized land in omitted.
        let included = this.options.omitAllProjected
          ? []
          : command.mode === "batch"
            ? authorized.filter((_item, index) => index === 0 || index === authorized.length - 1)
            : command.mode === "latest"
              ? authorized.slice(-2)
              : authorized.slice(2, 3);
        // Review probe: repeat one authorized id and drop another — a length-only check stays green.
        if (this.options.duplicateProjectedId && command.mode === "batch") {
          const first = included[0];
          if (first !== undefined) included = included.map(() => first);
        }
        const omitted = this.options.omitProjectionGaps
          ? []
          : authorized.filter((item) => !included.includes(item));
        const truncate = command.mode === "truncate" ? included[0] : undefined;
        const maxCharacters = command.maxCharacters ?? 24;
        // Review probe: originalLength forged to kept+1 (25) with the context line synced —
        // only a judge-truth length check and field-exact context matching can catch it.
        const keptEnd = truncate === undefined ? 0 : Math.min(maxCharacters, truncate.body.length);
        const truncations =
          truncate === undefined
            ? []
            : [
                {
                  eventId: truncate.eventId,
                  originalLength: this.options.forgeTruncationMetadata
                    ? keptEnd + 1
                    : truncate.body.length,
                  unit: "characters" as const,
                  keptStart: 0,
                  keptEnd,
                  sourceRef: `room-source:${truncate.eventId}`,
                  modelVisible: !this.options.truncationMetadataNotModelVisible,
                },
              ];
        const leakSuffix = this.options.leakHiddenProjection ? `:${hidden.length}` : "";
        const receipt: ProjectionReceipt = {
          projectionId: command.projectionId,
          viewerId: command.viewerId,
          sourceRange: [authorized[0]?.eventId ?? "none", authorized.at(-1)?.eventId ?? "none"],
          watermark: `watermark:${authorized.at(-1)?.eventId ?? "none"}${leakSuffix}`,
          policyVersion: "test-projection-policy:v1",
          includedEventIds: included.map((item) => item.eventId),
          omittedEventIds: omitted.map((item) => item.eventId),
          complete: false,
          errorCode: null,
          truncations,
        };
        this.projectionReceipts.push(receipt);
        const context = this.projectionContexts.get(command.viewerId) ?? [];
        for (const item of included) {
          context.push(command.mode === "truncate" ? item.body.slice(0, maxCharacters) : item.body);
        }
        for (const item of truncations) {
          if (item.modelVisible) {
            context.push(
              `${item.sourceRef} ${item.originalLength} ${item.unit} ${item.keptStart}:${item.keptEnd}`,
            );
          }
        }
        this.projectionContexts.set(command.viewerId, context);
        return;
      }
      case "attempt-source-read": {
        const eventId = command.sourceRef.startsWith("room-source:")
          ? command.sourceRef.slice("room-source:".length)
          : "";
        const source = this.projectionSources.find((item) => item.eventId === eventId);
        const allowed =
          (this.roomAccess.get(command.viewerId) ?? false) || this.options.allowRevokedSourceRead;
        this.sourceReads.push({
          sourceRef: command.sourceRef,
          viewerId: command.viewerId,
          outcome: allowed && source?.authorized ? "granted" : "denied",
          eventId:
            allowed && source?.authorized
              ? this.options.wrongSourceRead
                ? "wrong-event"
                : source.eventId
              : null,
          body:
            allowed && source?.authorized
              ? this.options.wrongSourceRead
                ? "wrong-body"
                : this.options.truncateSourceReadBody
                  ? source.body.slice(0, 24)
                  : source.body
              : null,
          errorCode: allowed && source?.authorized ? null : "not-found",
        });
        return;
      }
      case "set-room-access":
        this.roomAccess.set(command.residentId, command.allowed);
        return;
      case "set-room-membership": {
        const had = this.roomMembers.has(command.residentId);
        if (command.active) {
          this.roomMembers.add(command.residentId);
          this.roster.add(command.residentId);
        } else {
          this.roomMembers.delete(command.residentId);
          this.roster.delete(command.residentId);
        }
        if (had !== command.active) this.rosterVersion += 1;
        return;
      }
      case "attempt-delivery": {
        const submission = this.submissions.get(command.operationId);
        if (submission === undefined) return;
        const allowed =
          this.roomMembers.has(submission.residentId) || this.options.useStaleRoster === true;
        this.appendDecision({
          operationId: submission.operationId,
          senderId: submission.residentId,
          state: allowed ? "context-committed" : "rejected",
          reasonCode: allowed ? "ROOM_CONTEXT_COMMITTED" : "ROOM_MEMBER_REVOKED",
          permitConsumed: allowed,
          target: submission.target,
        });
        return;
      }
      case "set-delivery-target":
        this.currentTarget = command.target;
        return;
      case "return-member-result": {
        const held = this.held.get(command.operationId);
        if (held === undefined) return;
        // Review probe: the post-continue return of a cutoff old permit washes the dispatchId
        // on both ledger rows while every other fact (returned, reasoned rejected, no commit)
        // stays honest — only an identity-bound judge can catch it.
        const postContinueWash: DispatchIdentity =
          this.options.washPostContinueTarget &&
          (command.operationId === "gc07-old-permit" ||
            command.operationId === "gc12-cutoff-old") &&
          !this.stopped.has(held.residentId)
            ? { ...command.target, dispatchId: "test-dispatch:washed-post-continue" }
            : command.target;
        if (!this.options.skipReturnedResultRecord) {
          // Review probe: wash the six forged returned targets into the same residentId variant,
          // so the judge can only catch it by reading the host ledger, never its own stimulus list.
          const seen = this.results.filter(
            (row) => row.operationId === "gc12-tuple" && row.phase === "returned",
          ).length;
          const recordedTarget =
            this.options.washForgedTupleTargets && command.operationId === "gc12-tuple" && seen < 6
              ? {
                  residentId: fixture.residentIds.b,
                  scopeId: "test-scope:gc12",
                  scopeGeneration: 1,
                  windowId: "test-window:gc12",
                  generation: 1,
                  dispatchId: "test-dispatch:gc12",
                }
              : postContinueWash;
          this.results.push({
            sequence: this.nextSequence(),
            operationId: command.operationId,
            target: recordedTarget,
            phase: "returned",
            reasonCode: null,
          });
        }
        const targetMatchesPermit = this.sameTarget(command.target, held.target);
        const targetCurrent = this.sameTarget(command.target, this.currentTarget);
        const stoppedAfterIssue =
          (this.lastStopSequence.get(held.residentId) ?? 0) > held.issuedControlSequence;
        const accepted =
          (targetMatchesPermit && targetCurrent && !stoppedAfterIssue) ||
          this.options.acceptStaleTarget === true ||
          (this.options.acceptForgedTarget === true && command.operationId === "gc12-tuple") ||
          (this.options.acceptPreCutoffResult === true && stoppedAfterIssue);
        // Review probe: dropping the rejection leaves the cutoff without attributable evidence.
        if (!(this.options.omitStoppedResultRejection && !accepted && stoppedAfterIssue)) {
          this.results.push({
            sequence: this.nextSequence(),
            operationId: command.operationId,
            target: postContinueWash,
            phase: accepted ? "committed" : "rejected",
            reasonCode: accepted
              ? null
              : stoppedAfterIssue
                ? "ROOM_CONTROL_CUTOFF"
                : "ROOM_DISPATCH_IDENTITY_STALE",
          });
        }
        if (accepted) {
          this.addEvent({
            roomId: fixture.roomId,
            authorId: held.residentId,
            body: command.body,
            visibility: "public",
          });
          this.held.delete(command.operationId);
        }
        return;
      }
      case "set-resident":
        return;
    }
  }

  async readRoomEvents(roomId?: string): Promise<readonly RoomEvent[]> {
    return roomId === undefined
      ? this.events
      : this.events.filter((event) => event.roomId === roomId);
  }
  async readDeliveries(eventId: string): Promise<readonly DeliveryRecord[]> {
    return this.deliveries.get(eventId) ?? [];
  }
  async readMemories(): Promise<readonly MemoryRecord[]> {
    return this.memories;
  }
  async readResidentContext(residentId: ResidentId): Promise<string> {
    return (this.privateContexts.get(residentId) ?? []).join(" ");
  }
  async readRoster(): Promise<RosterSnapshot> {
    const residentIds = [...this.roster].filter(
      (id) => !(this.options.rosterSnapshotOmitsNewResident && id === fixture.residentIds.newcomer),
    );
    return { version: this.rosterVersion, residentIds };
  }
  async readRosterPath(path: RosterPath): Promise<RosterProjection> {
    return this.projections.get(path) ?? { residentIds: [], humanIds: [] };
  }
  async readMentionDecisions(): Promise<readonly MentionDecision[]> {
    return this.decisions;
  }
  async readCallLedger(): Promise<readonly CallReceipt[]> {
    return this.callLedger;
  }
  async readSystemReceipts(): Promise<readonly SystemReceipt[]> {
    return this.receipts;
  }
  async readContextCommits(): Promise<readonly ContextCommit[]> {
    return this.commits;
  }
  async readSurface(roomId: string, viewerId: string): Promise<SurfaceSnapshot> {
    const room = this.rooms.get(roomId);
    if (room?.visibility === "hidden" && viewerId !== fixture.humanId) {
      if (this.options.leakHiddenToUnauthorized) {
        return {
          body: room.body,
          visibleEventIds: [],
          candidates: [],
          count: 1,
          errorCode: null,
          receipt: null,
        };
      }
      return {
        body: "",
        visibleEventIds: [],
        candidates: [],
        count: 0,
        errorCode: this.options.revealHiddenExistence ? "forbidden" : "not-found",
        receipt: null,
      };
    }
    // A resident sees room history from its join time; the owner and outsiders keep the
    // all-public view. Residents a and b joined at 0, before anything was recorded.
    const joined = this.options.newResidentGetsHistory
      ? undefined
      : this.joinedAt.get(viewerId as ResidentId);
    const newcomer = joined !== undefined && joined > 0;
    const roomPublic = this.events.filter(
      (event) => event.roomId === roomId && event.visibility === "public",
    );
    const visibleEvents =
      newcomer && this.options.newcomerMissesPostJoin
        ? []
        : roomPublic.filter(
            (event) => joined === undefined || (this.eventTime.get(event.id) ?? 0) >= joined,
          );
    const bodies = visibleEvents.map((event) => event.body);
    // Review probe: the room's seed body glued onto a newcomer's surface outside the event list.
    if (newcomer && room && this.options.newcomerSurfaceIncludesRoomBody) bodies.unshift(room.body);
    const listed = newcomer && this.options.newcomerSeesPreJoinIds ? roomPublic : visibleEvents;
    return {
      body: this.options.publicBodyX && roomId === fixture.roomId ? "x" : bodies.join("\n"),
      visibleEventIds: listed.map(({ id }) => id),
      candidates: visibleEvents.map(({ id }) => id),
      count: visibleEvents.length,
      errorCode: room ? null : "not-found",
      receipt: null,
    };
  }
  async readAccessAudit(): Promise<AccessAudit> {
    return {
      crossResidentPrivateReads: this.crossResidentPrivateReads,
      unauthorizedReadResults: this.unauthorizedReadResults,
    };
  }
  async readReactions(): Promise<readonly ResidentReaction[]> {
    return this.reactions;
  }
  async readRoundRecords(): Promise<readonly RoundRecord[]> {
    return structuredClone(this.roundRecords);
  }
  async readScheduler(): Promise<SchedulerSnapshot> {
    return {
      tick: this.schedulerTick,
      ordinaryQueueDepth: this.ordinaryQueueDepth,
      heldOperationIds: [...this.held.keys()],
      stoppedResidentIds: [...this.stopped],
    };
  }
  async readControlRecords(): Promise<readonly ControlRecord[]> {
    return structuredClone(this.controlRecords);
  }
  async readDeliveryDecisions(): Promise<readonly DeliveryDecisionRecord[]> {
    return structuredClone(this.deliveryDecisions);
  }
  async readSenderFeedback(residentId: ResidentId): Promise<readonly SenderFeedbackRecord[]> {
    if (this.options.crossDeliverFeedback) return structuredClone(this.feedback);
    return structuredClone(this.feedback.filter((row) => row.senderId === residentId));
  }
  async readProjectionReceipts(): Promise<readonly ProjectionReceipt[]> {
    return structuredClone(this.projectionReceipts);
  }
  async readProjectionContext(residentId: ResidentId): Promise<string> {
    return (this.projectionContexts.get(residentId) ?? []).join("\n");
  }
  async readSourceReads(): Promise<readonly SourceReadAudit[]> {
    return structuredClone(this.sourceReads);
  }
  async readMemberAttempts(): Promise<readonly MemberAttemptRecord[]> {
    return structuredClone(this.attempts);
  }
  async readMemberResults(): Promise<readonly MemberResultRecord[]> {
    return structuredClone(this.results);
  }
}

/** No member-id literals found under src/ (the runner supplies the real scan). */
const judge: GroupChatJudgeContext = {
  findSourceLiterals: async () => [],
  restartHost: async (driver) => {
    const previous = await driver.startHost();
    const current = await driver.restartHost();
    return { previous, current };
  },
};

const check = (id: GroupChatCheckId, options: TestOptions = {}) =>
  runGroupChatCheck(id, new SyntheticGroupChatHost(options), judge);

/** Explicit personal-state assertions the system must never make on a member's behalf. */
const unsupportedClaims = [
  "👀",
  "👀 已装入，不代表理解",
  "已发送👀",
  "我看见了",
  "我看见了，不代表理解",
  "seen; does not mean the member understood",
  "the member has read it",
  "typing",
  "对方正在输入…",
  "输入中…",
  "已读",
  "系统已收，成员已读",
  "不代表理解，但已读",
  "不到一秒就已读",
  "不一会儿我看见了",
  "没多久就看到了",
  "我不但看见了",
  "不久前已读",
  "成员已理解",
  "成员已经记住",
  "记住了",
  "已写入记忆",
  "写入了长期记忆",
  // #202 second review: plain synonyms that slipped through, and 👀 under a denial span.
  "成员看见消息了",
  "成员看过这条消息",
  "住户记得这条",
  "成员阅读了消息",
  "对方在打字",
  "系统写入记忆",
  "不代表理解👀",
  "不是未读是已读",
  "member saw the message",
  // Clause and subject edges that must stay red.
  "系统：已读",
  "系统代发已读",
  "已读但不代表理解",
  "成员已经看过并理解了",
  "已装入，不代表成员已读👀",
  // #202 third review: 过 / 正在 affirmatives, reading-class 正在 still red, member subject + config.
  "看见过",
  "看到过",
  "理解过",
  "理解过了",
  "记住过",
  "记住过了",
  "明白过",
  "正在理解",
  "正在记住",
  "正在看见",
  "正在阅读",
  "不代表正在输入",
  "成员已读完配置",
  "住户已读完配置",
  "住户小明已读完配置",
  "他已读完配置",
  "小明已读完配置",
  "Ada已读完配置",
  "系统小明已读完配置",
  // #206 review 1: canonical resident id must not launder a personal claim into a
  // system config reading; arbitrary colon strings stay unprotected (suffix clause judges).
  "test-resident:a 已读完配置",
  "test-resident:novel-d 已读",
  "test-resident:b 👀",
  "test-resident:c 正在输入",
  "test-resident:a 已写入记忆",
  "test-resident:b 已理解",
  "test-human:owner 已读完配置",
];

/**
 * Honest wording must stay green: bare verbs used in denials, the design doc's own sentence,
 * and every example the #202 review showed being misread as an impersonation.
 */
const honestClaims = [
  "系统已收，成员尚未派发",
  "已装入，不代表理解",
  "仍不等于理解或记忆",
  "does not mean the member understood",
  "成员尚未理解",
  "成员未看见",
  "成员不一定看到",
  "成员未必看见",
  "没有看见",
  "尚未看到",
  "已装入，不代表成员已读",
  "不代表已读、理解",
  "ready; already; recorded",
  "not read yet",
  "has not been read",
  "等待用户输入",
  "请在下方输入",
  "输入法",
  "输入中文不受影响",
  "系统不写入记忆",
  "未写入记忆",
  "已装入，尚未形成记忆",
  "装入也不证明住户理解、认同、回复或写入记忆",
  "已装入，不证明写入记忆",
  "没有👀",
  "系统不发送👀",
  "系统已读取配置",
  "以 read-only 方式装入",
  // #202 second review: the system's own reading, misread as a member's.
  "已读完配置",
  "系统已看到投递失败",
  "系统读了配置",
  "查看过程日志",
  "成员没看过",
  "成员不记得",
  "待写入记忆",
  // #202 third review: negation still clears the new forms; 不代表正在阅读; config without a member subject.
  "不代表看见过",
  "没有理解过",
  "不证明记住过了",
  "没有正在理解",
  "不代表正在记住",
  "看见",
  "理解",
  "记住",
  "理解过程",
  "看见过程",
  "不代表正在阅读",
  "没有正在阅读",
  "不证明正在阅读",
  "系统已读完配置",
  "代码已读完配置",
  "其他已读完配置",
  "刚刚已读完配置",
  "代表已读完配置",
  "日志已读完配置",
  "不到一秒就已读完配置",
  // 不泛化成任意冒号字符串：非夹具 id 照旧在冒号处切开，残余子句按无主语配置读取放行。
  "other-id:x 已读完配置",
  "test-resident:x 已读完配置，不代表理解",
];

describe("#191/#192 group-chat acceptance: judge-driven synthetic host checks", () => {
  it("freezes exactly the thirteen stacked red lamps and synthetic fixtures", () => {
    expect(groupChatChecks.map(({ id }) => id)).toEqual(GROUP_CHAT_CHECK_IDS);
    expect(fixture.roomId).toMatch(/^test-room:/);
    expect(Object.values(fixture.residentIds).every((id) => id.startsWith("test-resident:"))).toBe(
      true,
    );
    expect(
      Object.values(fixture.canaries).every((value) => value.startsWith("TEST-PRIVATE-CANARY:")),
    ).toBe(true);
  });

  it("passes positive controls only after judge operations and independent readbacks", async () => {
    for (const id of GROUP_CHAT_CHECK_IDS) {
      const result = await check(id);
      expect(result.passed, `${id}: ${result.detail}`).toBe(true);
    }
  });

  // Each negative must go red for its own reason, not trip an earlier, unrelated gate.
  it.each([
    ["GC-01", { acceptForged: true }, "伪造 envelope"],
    ["GC-01", { dropForgedBodyPost: true }, "正文身份伪造负例"],
    ["GC-01", { trustBodyAuthorHeader: true }, "正文身份伪造负例"],
    ["GC-02", { acceptInvalidPosts: true }, "缺显式边界"],
    // Each boundary on its own: the resident sender dropping only visibility must go red too.
    ["GC-02", { acceptOnlyInvalid: "visibility" }, "缺显式边界"],
    ["GC-02", { acceptOnlyInvalid: "room" }, "缺显式边界"],
    ["GC-02", { acceptOnlyInvalid: "binding" }, "缺显式边界"],
    ["GC-02", { acceptOnlyInvalid: "private-fields" }, "缺显式边界"],
    ["GC-02", { noopSeedPrivate: true }, "发送方私有"],
    ["GC-02", { leakPrivateCanariesIntoRoom: true }, "泄漏"],
    ["GC-03", { wrongMemorySource: true }, "指回原房间事件"],
    ["GC-03", { leakPrivateCanaries: true }, "串入"],
    ["GC-03", { noopSeedPrivate: true }, "读回本人"],
    ["GC-03", { skipDeliveryFor: fixture.residentIds.b }, "三条"],
    ["GC-04", { noRosterVersionBump: true }, "版本没有递增"],
    ["GC-04", { skipRosterPath: "feedback" }, "未贯通"],
    ["GC-04", { rosterSnapshotOmitsNewResident: true }, "未读回完整成员名单"],
    ["GC-04", { projectionsHardcode: fixture.residentIds.newcomer }, "novel-e"],
    ["GC-05", { bypassGate: true }, "绕过"],
    ["GC-05", { routePlainText: true }, "触发了调用"],
    ["GC-05", { routeBareName: true }, "触发了调用"],
    ["GC-05", { resolvePlainTextTarget: true }, "解析成了呼叫目标"],
    ["GC-05", { deadRouter: true }, "恰好路由一次"],
    ["GC-05", { acceptUnknownTargetWithoutCall: true }, "未知或越权目标"],
    ["GC-05", { omitPlainDecisions: true }, "缺 8 条"],
    ["GC-05", { plainCallOffDecision: true }, "不对应任何刺激"],
    ["GC-05", { orphanCalls: true }, "不对应任何刺激"],
    ["GC-05", { gatedCallsWithoutDecision: true }, "缺 2 条"],
    ["GC-05", { heldButCalled: true }, "不对应任何刺激"],
    ["GC-05", { phantomReceipt: true }, "呼叫账里没有的回执"],
    ["GC-05", { wrongTargetReceipt: true }, "未路由到正确住户"],
    ["GC-05", { duplicateDecision: true }, "重复 1 条"],
    ["GC-05", { blankReason: true }, "原因码"],
    ["GC-05", { preexistingCall: true, rewriteLedger: true }, "改写或删减"],
    ["GC-09", { contextCommitRef: "x" }, "提交引用"],
    ["GC-09", { publishFutureReceiptsEarly: true }, "提前出现"],
    ["GC-09", { proxyReaction: true }, "代发"],
    ["GC-09", { commitWritesMemory: true }, "写入记忆"],
    ["GC-09", { extraSystemPhase: "seen" }, "个人状态当成了阶段"],
    ["GC-09", { forgedResidentReceipt: true }, "代签"],
    ["GC-15", { leakHiddenToUnauthorized: true }, "泄漏"],
    ["GC-15", { acceptCrossRoomReplay: true }, "错误房间"],
    ["GC-15", { noHiddenRoom: true }, "对照世界"],
    ["GC-15", { publicBodyX: true }, "授权公开表面"],
    ["GC-15", { revealHiddenExistence: true }, "hidden-existence-difference"],
    ["GC-15", { leakResidentScope: true }, "内部 scope"],
    ["GC-15", { silentScopeRead: true }, "恰好一次拒绝"],
    ["GC-15", { newResidentGetsHistory: true }, "入群前"],
    ["GC-15", { newcomerSurfaceIncludesRoomBody: true }, "入群前"],
    ["GC-15", { newcomerSeesPreJoinIds: true }, "入群前"],
    ["GC-15", { newcomerMissesPostJoin: true }, "入群后看不到新消息"],
    ["GC-15", { duplicatePositions: true }, "位置"],
  ] as const)("%s goes red for its own reason under %j", async (id, options, reason) => {
    const result = await check(id, options);
    expect(result.passed).toBe(false);
    expect(result.detail).toContain(reason);
  });

  it("fails if the forged-envelope negative is silently accepted", async () => {
    expect((await check("GC-01", { acceptForged: true })).passed).toBe(false);
  });

  it("requires the judge to send and read back a body that impersonates another author", async () => {
    expect((await check("GC-01", { dropForgedBodyPost: true })).passed).toBe(false);
    expect((await check("GC-01", { trustBodyAuthorHeader: true })).passed).toBe(false);
  });

  it("counts recorded authors as a multiset, not by inclusion", () => {
    const base = {
      legitimateHuman: { accepted: true, authorId: fixture.humanId },
      legitimate: { accepted: true, authorId: fixture.residentIds.a },
      forgedEnvelopeAccepted: false,
      forgedBodyAccepted: true,
      forgedBodyAuthorId: fixture.residentIds.a,
      unexpectedAuthors: [],
    };
    const { humanId } = fixture;
    const { a } = fixture.residentIds;
    expect(
      evaluateGroupChatEvidence("GC-01", { ...base, recordedAuthorIds: [humanId, a, a] }).passed,
    ).toBe(true);
    const skewed = evaluateGroupChatEvidence("GC-01", {
      ...base,
      recordedAuthorIds: [humanId, humanId, a],
    });
    expect(skewed.passed).toBe(false);
    expect(skewed.detail).toContain("三条");
  });

  it("fails if malformed/private payload negatives are silently accepted", async () => {
    expect((await check("GC-02", { acceptInvalidPosts: true })).passed).toBe(false);
  });

  it("seeds private draft/tool canaries, reads them for the sender, and rejects public leakage", async () => {
    expect((await check("GC-02", { noopSeedPrivate: true })).passed).toBe(false);
    expect((await check("GC-02", { leakPrivateCanariesIntoRoom: true })).passed).toBe(false);
  });

  it("requires a personal-memory pointer to equal the exact judge-seeded room event", async () => {
    expect((await check("GC-03", { wrongMemorySource: true })).passed).toBe(false);
  });

  it("fails GC-03 when judge-seeded private canaries cross resident contexts", async () => {
    expect((await check("GC-03", { leakPrivateCanaries: true })).passed).toBe(false);
  });

  it("requires each resident to read back its own judge-seeded private canary", async () => {
    expect((await check("GC-03", { noopSeedPrivate: true })).passed).toBe(false);
  });

  it("fails GC-03 when a delivery ledger setup/readback is omitted", async () => {
    expect((await check("GC-03", { skipDeliveryFor: fixture.residentIds.b })).passed).toBe(false);
  });

  it("says GC-03 only covers separated ledger readback, not delivery semantics", async () => {
    const result = await check("GC-03");
    expect(result.passed).toBe(true);
    expect(result.detail).toContain("投递语义留待投递账阶段");
  });

  it("checks roster version relatively and detects a non-incrementing add", async () => {
    expect((await check("GC-04", { noRosterVersionBump: true })).passed).toBe(false);
  });

  it("fails if any newly added resident projection path is skipped", async () => {
    expect((await check("GC-04", { skipRosterPath: "feedback" })).passed).toBe(false);
  });

  it("checks the roster membership list before and after addition, not just its version", async () => {
    expect((await check("GC-04", { rosterSnapshotOmitsNewResident: true })).passed).toBe(false);
  });

  it("catches a roster path hard-wired to one newcomer by adding a different one", async () => {
    const result = await check("GC-04", { projectionsHardcode: fixture.residentIds.newcomer });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain(fixture.residentIds.newcomerAlt);
  });

  it("fails GC-04 when src/ spells out a member id, and scans for every fixture member", async () => {
    let scanned: readonly string[] = [];
    const result = await runGroupChatCheck("GC-04", new SyntheticGroupChatHost(), {
      findSourceLiterals: async (terms) => {
        scanned = terms;
        return ["src/group-chat/router.ts"];
      },
      restartHost: judge.restartHost,
    });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("src/group-chat/router.ts");
    expect(scanned).toEqual(
      expect.arrayContaining([
        fixture.humanId,
        fixture.residentIds.a,
        fixture.residentIds.newcomer,
        fixture.residentIds.newcomerAlt,
      ]),
    );
  });

  it("refuses to judge GC-04 without the judge-side static scan", async () => {
    await expect(runGroupChatCheck("GC-04", new SyntheticGroupChatHost())).rejects.toThrow(
      /findSourceLiterals/,
    );
  });

  it("fails if a structured mention bypasses the stop/turn gate", async () => {
    expect((await check("GC-05", { bypassGate: true })).passed).toBe(false);
  });

  it("fails if any plain-text mention variant routes a call", async () => {
    expect((await check("GC-05", { routePlainText: true })).passed).toBe(false);
  });

  it("covers bare member names, not only @name, in the plain-text negatives", async () => {
    expect((await check("GC-05", { routeBareName: true })).passed).toBe(false);
  });

  it("fails if plain text is resolved to a call target even without a call", async () => {
    expect((await check("GC-05", { resolvePlainTextTarget: true })).passed).toBe(false);
  });

  it("requires one real route for a legitimate structured mention while the gate is open", async () => {
    expect((await check("GC-05", { deadRouter: true })).passed).toBe(false);
  });

  it("asks each operation for its own decision instead of reading a missing row as a call", async () => {
    const result = await check("GC-05", { omitPlainDecisions: true });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("路由决定");
    expect(result.detail).not.toContain("触发了调用");
  });

  it("counts only this scenario's window of a call ledger that survives resets", async () => {
    const result = await check("GC-05", { preexistingCall: true });
    expect(result.passed, result.detail).toBe(true);
  });

  it("turns the #202 second review's off-marker and unrecorded calls red", async () => {
    const probes: TestOptions[] = [
      { plainCallOffDecision: true },
      { orphanCalls: true },
      { gatedCallsWithoutDecision: true },
    ];
    for (const probe of probes) {
      expect((await check("GC-05", probe)).passed, JSON.stringify(probe)).toBe(false);
    }
  });

  it("lets a closed gate hold a mention without calling it", async () => {
    const result = await check("GC-05", { holdGatedMentions: true });
    expect(result.passed, result.detail).toBe(true);
  });

  it("fails if an unknown target is accepted even when no call is made", async () => {
    expect((await check("GC-05", { acceptUnknownTargetWithoutCall: true })).passed).toBe(false);
  });

  it.each(unsupportedClaims)("flags system claim %j as an unsupported personal claim", (claim) => {
    expect(isUnsupportedPersonalClaim(claim)).toBe(true);
  });

  it.each(honestClaims)("keeps honest system claim %j green", (claim) => {
    expect(isUnsupportedPersonalClaim(claim)).toBe(false);
  });

  it("treats personal states as invalid system phases but allows extra system phases", () => {
    for (const phase of ["recorded", "dispatched", "context-committed", "queued", "thread-created"])
      expect(isPersonalStatePhase(phase), phase).toBe(false);
    for (const phase of ["seen", "read-receipt", "member_typing", "understood", "已读"])
      expect(isPersonalStatePhase(phase), phase).toBe(true);
  });

  it("rejects a context-committed receipt that points to arbitrary non-empty x", async () => {
    expect((await check("GC-09", { contextCommitRef: "x" })).passed).toBe(false);
  });

  it("fails if later-stage receipts are visible before their host operations", async () => {
    expect((await check("GC-09", { publishFutureReceiptsEarly: true })).passed).toBe(false);
  });

  it("runs claim probes through the judge/readback path", async () => {
    for (const claim of unsupportedClaims) {
      expect((await check("GC-09", { claimOverride: claim })).passed, claim).toBe(false);
    }
    for (const claim of honestClaims) {
      const result = await check("GC-09", { claimOverride: claim });
      expect(result.passed, `${claim}: ${result.detail}`).toBe(true);
    }
  });

  it("fails if the orchestrator adds a reaction before the resident reacts", async () => {
    const result = await check("GC-09", { proxyReaction: true });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("代发");
  });

  it("fails if committing context writes the resident's memory ledger", async () => {
    const result = await check("GC-09", { commitWritesMemory: true });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("记忆");
  });

  it("allows an extra system phase but not a personal state dressed as one", async () => {
    expect((await check("GC-09", { extraSystemPhase: "queued" })).passed).toBe(true);
    expect((await check("GC-09", { extraSystemPhase: "seen" })).passed).toBe(false);
  });

  it("allows a resident-authored receipt only when that resident really reacted", async () => {
    expect((await check("GC-09", { residentReceiptAfterReaction: true })).passed).toBe(true);
    expect((await check("GC-09", { forgedResidentReceipt: true })).passed).toBe(false);
  });

  it("makes hidden-room body and side-channel surfaces invariant across hidden canaries", async () => {
    expect((await check("GC-15")).passed).toBe(true);
  });

  it("fails if a hidden canary leaks or the public event is replayed across rooms", async () => {
    expect((await check("GC-15", { leakHiddenToUnauthorized: true })).passed).toBe(false);
    expect((await check("GC-15", { acceptCrossRoomReplay: true })).passed).toBe(false);
  });

  it("requires the hidden canary world and judge-seeded public readback to exist", async () => {
    expect((await check("GC-15", { noHiddenRoom: true })).passed).toBe(false);
    expect((await check("GC-15", { publicBodyX: true })).passed).toBe(false);
  });

  it("compares against a world without the hidden room, so existence cannot leak", async () => {
    const result = await check("GC-15", { revealHiddenExistence: true });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("hidden-existence-difference");
  });

  it("stimulates a member reading another resident's scope and checks the viewer's context", async () => {
    const leaked = await check("GC-15", { leakResidentScope: true });
    expect(leaked.passed).toBe(false);
    expect(leaked.detail).toContain("内部 scope");
    expect((await check("GC-15", { silentScopeRead: true })).passed).toBe(false);
  });

  it("fails if a newcomer without a history grant sees pre-join public messages", async () => {
    const result = await check("GC-15", { newResidentGetsHistory: true });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("入群前");
  });

  it("copies command arguments and host readbacks at the adapter boundary", async () => {
    const raw = new SyntheticGroupChatHost();
    const driver = cloneGroupChatDriverBoundary(raw);
    // The setup grant crosses the same cloned boundary before any post can be trusted.
    await driver.resetScenario("GC-01", fixture);
    const command: GroupChatCommand = {
      kind: "post",
      roomId: fixture.roomId,
      principalId: fixture.humanId,
      visibility: "public",
      binding: fixture.trustedOwnerBinding,
      body: "TEST-CLONE-BOUNDARY",
    };
    await driver.perform(command);
    const result = await driver.readRoomEvents();
    const returned = result[0];
    expect(returned).toBeDefined();
    (returned as unknown as { body: string }).body = "mutated-return-value";
    expect(command.body).toBe("TEST-CLONE-BOUNDARY");
    expect((await raw.readRoomEvents())[0]?.body).toBe("TEST-CLONE-BOUNDARY");
  });

  // #206 review 2: the binding string is never self-authorizing. Only the judge-owned setup
  // grant delivered through resetScenario(id, fixture) registers it on the host.
  it("trusts the owner binding only as a resetScenario setup grant, never from a command", async () => {
    const post = (binding: string): GroupChatCommand => ({
      kind: "post",
      roomId: fixture.roomId,
      principalId: fixture.humanId,
      visibility: "public",
      binding,
      body: "TEST-TRUSTED-BINDING-SEAM",
    });
    // Without a setup grant, the exact trusted string inside perform() writes nothing.
    const host = new SyntheticGroupChatHost();
    await host.perform(post(fixture.trustedOwnerBinding));
    expect(await host.readRoomEvents()).toHaveLength(0);
    // After resetScenario registers the grant, the same command writes normally.
    await host.resetScenario("GC-01", fixture);
    await host.perform(post(fixture.trustedOwnerBinding));
    expect((await host.readRoomEvents()).map((event) => event.body)).toContain(
      "TEST-TRUSTED-BINDING-SEAM",
    );
    // A wrong or empty binding stays rejected once the grant exists.
    for (const binding of ["test-binding:forged", ""]) {
      const negative = new SyntheticGroupChatHost();
      await negative.resetScenario("GC-01", fixture);
      await negative.perform(post(binding));
      expect(await negative.readRoomEvents()).toHaveLength(0);
    }
  });

  it("reports absent production adapter as thirteen expected red lamps", () => {
    const results = runnerMissingDriverResults();
    expect(results.map(({ id }) => id)).toEqual(GROUP_CHAT_CHECK_IDS);
    expect(
      results.every(({ passed, detail }) => !passed && detail.includes("real-host driver missing")),
    ).toBe(true);
  });

  it("reports a provenance failure as seven red lamps naming the reason, never a baseline", () => {
    const reason = "real-host provenance check failed: host process 7 is not running";
    const results = provenanceFailedResults(reason);
    expect(results.map(({ id }) => id)).toEqual(GROUP_CHAT_CHECK_IDS);
    expect(
      results.every(
        ({ passed, stubbed, detail }) =>
          !passed &&
          !stubbed &&
          detail.includes(reason) &&
          !detail.includes("real-host driver missing"),
      ),
    ).toBe(true);
    expect(scoreGroupChatResults(results)).toEqual({
      trueGreen: 0,
      stubGreen: 0,
      strictPass: false,
    });
  });

  it("counts declared STUBBED methods as yellow lamps, never true green or strict pass", () => {
    const stubbedResults = groupChatChecks.map((item) => ({
      id: item.id,
      title: item.title,
      passed: true,
      stubbed: item.uses.includes("perform"),
      detail: "synthetic positive-control readback",
    }));
    expect(scoreGroupChatResults(stubbedResults)).toEqual({
      trueGreen: 0,
      stubGreen: 13,
      strictPass: false,
    });

    const realResults = stubbedResults.map((result) => ({ ...result, stubbed: false }));
    expect(scoreGroupChatResults(realResults)).toEqual({
      trueGreen: 13,
      stubGreen: 0,
      strictPass: true,
    });
  });
});

describe("#192 stacked red oracle: each A-D behavior has a single-mutation red", () => {
  it.each([
    ["GC-06A", "GC-06", { ignoreTurnBudget: true }, "恰好放行 B 次"],
    ["GC-06B retry", "GC-06", { duplicateRetry: true }, "重试重复"],
    ["GC-06B pass", "GC-06", { omitPassRecord: true }, "pass"],
    ["GC-06B failure", "GC-06", { omitFailureRecord: true }, "失败尝试"],
    ["GC-06B identity", "GC-06", { resetBudgetOnIdentityChange: true }, "换代刺激"],
    ["GC-06B generation", "GC-06", { omitRoundTarget: true }, "换代负例"],
    ["GC-06B root", "GC-06", { acceptSelfDeclaredRoot: true }, "自报新根"],
    ["GC-06C", "GC-06", { resetRoundOnRestart: true }, "高水位"],
    ["GC-06C pid", "GC-06", { reuseRestartPid: true }, "换真实进程"],
    ["GC-06C commit", "GC-06", { changeRestartCommit: true }, "commit"],
    ["GC-06D", "GC-06", { dispatchWithInvalidPolicy: true }, "非法有限配置"],
    ["GC-07A empty", "GC-07", { emptyOrdinaryQueue: true }, "非空普通队列"],
    ["GC-07A shared", "GC-07", { controlSharesOrdinaryQueue: true }, "接收与实际生效"],
    ["GC-07B", "GC-07", { acceptFalseControl: true }, "伪造"],
    ["GC-07C receipts", "GC-07", { mergeControlReceipts: true }, "接收与实际生效"],
    ["GC-07C unreachable", "GC-07", { reportUnreachableEffective: true }, "不可达"],
    ["GC-07C effect", "GC-07", { claimExternalEffectReversed: true }, "副作用"],
    ["GC-07D", "GC-07", { continueDeadlocks: true }, "continue"],
    ["GC-08A", "GC-08", { unstableReasonAfterRestart: true }, "原因码"],
    ["GC-08B offline", "GC-08", { markOfflineFeedbackDelivered: true }, "离线"],
    ["GC-08B note", "GC-08", { feedbackNoteOnly: true }, "delivery receipt"],
    ["GC-08C body", "GC-08", { leakBlockedBody: true }, "被拦原文"],
    ["GC-08C claim", "GC-08", { feedbackClaimsMemberRead: true }, "冒充成员个人状态"],
    ["GC-08C cross", "GC-08", { crossDeliverFeedback: true }, "跨发送方"],
    ["GC-08D consume", "GC-08", { consumeOnDecisionPersistFailure: true }, "仍消费"],
    ["GC-08D duplicate", "GC-08", { duplicateDecisionOnRetry: true }, "恰好留一份"],
    ["GC-10A", "GC-10", { omitProjectionGaps: true }, "省略缺口"],
    ["GC-10B", "GC-10", { truncationMetadataNotModelVisible: true }, "模型可见"],
    ["GC-10C", "GC-10", { leakHiddenProjection: true }, "隐藏内容"],
    ["GC-10D revoke", "GC-10", { allowRevokedSourceRead: true }, "撤权后"],
    ["GC-10D source", "GC-10", { wrongSourceRead: true }, "同一原事件"],
    ["GC-12A", "GC-12", { useStaleRoster: true }, "成员表"],
    ["GC-12B stimulus", "GC-12", { skipReturnedResultRecord: true }, "实际送回"],
    ["GC-12B accept", "GC-12", { acceptStaleTarget: true }, "旧 scope/window"],
    ["GC-12C", "GC-12", { acceptPreCutoffResult: true }, "stop 前许可"],
    ["GC-12D", "GC-12", { acceptForgedTarget: true }, "六字段"],
    ["GC-16A", "GC-16", { starveOtherMembers: true }, "饿死"],
    ["GC-16B sync", "GC-16", { synchronousHoldFailure: true }, "同步快抛错"],
    ["GC-16B deadline", "GC-16", { neverTimeoutHeld: true }, "deadline"],
    ["GC-16C retry", "GC-16", { unboundedMemberRetries: true }, "无界"],
    ["GC-16C restart", "GC-16", { washFailuresOnRestart: true }, "partial restart"],
    ["GC-16C high-water", "GC-16", { resetRoundOnRestart: true }, "高水位"],
    ["GC-16D feedback", "GC-16", { dropFailureFeedback: true }, "失败反馈"],
    ["GC-16D receipt", "GC-16", { falseFailurePresenceReceipt: true }, "冒充"],
    ["GC-16D claim", "GC-16", { failureReceiptClaimsMemberRead: true }, "冒充成员个人状态"],
    // #206 review 3: single-mutation probes for the six corrected false greens.
    ["GC-06B root-omit", "GC-06", { omitSelfRootRecord: true }, "自报新根"],
    ["GC-07B drop", "GC-07", { omitFalseControlRecords: true }, "伪造控制"],
    ["GC-08 swap", "GC-08", { permuteDeliveryStates: true }, "缺恰好一条"],
    ["GC-10 omit-all", "GC-10", { omitAllProjected: true }, "没有纳入任何"],
    ["GC-12C drop-reject", "GC-12", { omitStoppedResultRejection: true }, "明确 rejected"],
    ["GC-16C attempt-999", "GC-16", { forgeAttemptOutOfBound: true }, "无界"],
    // #206 review 4: duplicate-accounting probes for the three remaining false greens.
    ["GC-07B dup", "GC-07", { duplicateFalseControlRecord: true }, "恰好一条"],
    ["GC-10 dup-id", "GC-10", { duplicateProjectedId: true }, "重复"],
    ["GC-12D wash", "GC-12", { washForgedTupleTargets: true }, "各改一个"],
    // #206 review 5: single-mutation probes for the six newly confirmed false greens.
    ["GC-01 dup-forged", "GC-01", { duplicateForgedEnvelope: true }, "伪造 envelope"],
    [
      "GC-06A swap-order",
      "GC-06",
      { swapBoundedTurnRecords: true },
      "没有恰好一条按序的 permitted",
    ],
    ["GC-06B identity-human", "GC-06", { identityChangeAsHumanTrigger: true }, "换代刺激"],
    ["GC-07C unreachable-effective", "GC-07", { unreachableAlsoEffective: true }, "不可达"],
    ["GC-09B proxy-sign", "GC-09", { proxySignedReceiptAtRecord: true }, "代签"],
    ["GC-10B forge-length", "GC-10", { forgeTruncationMetadata: true }, "原长"],
    // #206 review 8: cutoff wiped at continue, truncated source body, sender misattribution.
    ["GC-07C cutoff-clear", "GC-07", { clearCutoffOnContinue: true }, "仍被提交"],
    ["GC-12C cutoff-clear", "GC-12", { clearCutoffOnContinue: true }, "复活"],
    ["GC-10D truncate-body", "GC-10", { truncateSourceReadBody: true }, "精确相等"],
    [
      "GC-08B decision-sender",
      "GC-08",
      { misattributeDecisionSender: true },
      "senderId 不是判卷发送方",
    ],
    [
      "GC-08B feedback-sender",
      "GC-08",
      { misattributeFeedbackSender: true },
      "归属于判卷发送方的反馈",
    ],
    // #206 review 9: post-continue ledger rows with a washed identity tuple.
    ["GC-07C wash-target", "GC-07", { washPostContinueTarget: true }, "六元组"],
    ["GC-12C wash-target", "GC-12", { washPostContinueTarget: true }, "六元组"],
  ] as const)("%s makes %s red for %j", async (_caseId, id, options, reason) => {
    const result = await check(id, options);
    expect(result.passed).toBe(false);
    expect(result.detail).toContain(reason);
  });

  it("keeps synthetic positive controls explicitly outside real-host provenance", async () => {
    for (const id of ["GC-06", "GC-07", "GC-08", "GC-10", "GC-12", "GC-16"] as const) {
      const result = await check(id);
      expect(result.passed, `${id}: ${result.detail}`).toBe(true);
    }
    const run = await new SyntheticGroupChatHost().startHost();
    expect(
      hostProvenanceProblem(run, {
        headCommit: "0123456789abcdef0123456789abcdef01234567",
        judgePid: process.pid,
        judgeExecutable: realpathSync(process.execPath),
        repoRoot: fileURLToPath(new URL("..", import.meta.url)),
        readProcess: () => null,
      }),
    ).not.toBeNull();
  });

  it("deep-copies new orchestration readbacks as well as commands", async () => {
    const raw = new SyntheticGroupChatHost();
    const driver = cloneGroupChatDriverBoundary(raw);
    await driver.resetScenario("GC-06", fixture);
    await driver.perform({
      kind: "configure-orchestration",
      rootId: fixture.roots.first,
      policyVersion: "test-policy:clone",
      turnBudget: 1,
      deadlineTicks: 1,
      maxMemberAttempts: 1,
    });
    await driver.perform({
      kind: "human-trigger",
      operationId: "clone-human",
      rootId: fixture.roots.first,
      body: "TEST-CLONE-ORCHESTRATION",
    });
    const records = await driver.readRoundRecords();
    (records[0] as { reasonCode: string | null }).reasonCode = "mutated";
    expect((await raw.readRoundRecords())[0]?.reasonCode).toBeNull();
  });
});

describe("#206 review 3: evaluator pins identities and sequences, not just counts", () => {
  const a = fixture.residentIds.a;

  const gc06TurnRecord = (
    operationId: string,
    decision: "permitted" | "blocked",
    sequence: number,
    reasonCode: string | null = null,
  ): GroupChatEvidenceById["GC-06"]["boundedWorlds"][number]["records"][number] => ({
    operationId,
    decision,
    reasonCode,
    sequence,
  });
  const gc06WorldRecords = (budget: number) => [
    ...Array.from({ length: budget }, (_, index) =>
      gc06TurnRecord(`gc06-B${budget}-turn-${index + 1}`, "permitted", index + 1),
    ),
    gc06TurnRecord(
      `gc06-B${budget}-turn-${budget + 1}`,
      "blocked",
      budget + 1,
      "ROOM_TURN_BUDGET_EXHAUSTED",
    ),
  ];
  const gc06Base = (): GroupChatEvidenceById["GC-06"] => ({
    boundedWorlds: [
      { budget: 1, records: gc06WorldRecords(1), oneRoot: true, policyVersionStable: true },
      { budget: 3, records: gc06WorldRecords(3), oneRoot: true, policyVersionStable: true },
    ],
    retryAddedDispatch: false,
    passRecorded: true,
    failureRecorded: true,
    identityChangeAttempts: [{ decision: "blocked", reasonCode: "ROOM_TURN_BUDGET_EXHAUSTED" }],
    generationChangeStimulated: true,
    selfRootAttempts: [{ decision: "blocked", reasonCode: "ROOM_ROOT_FORGED" }],
    restartPidChanged: true,
    restartCommitStable: true,
    highWaterBeforeRestart: 1,
    highWaterAfterRestart: 1,
    humanAfterLimitAccepted: true,
    invalidConfigDispatched: false,
    invalidConfigReasoned: true,
  });

  it("GC-06 requires exactly one blocked self-root record with a stable reason", () => {
    expect(evaluateGroupChatEvidence("GC-06", gc06Base()).passed).toBe(true);
    const badAttempts: readonly (readonly Pick<RoundRecord, "decision" | "reasonCode">[])[] = [
      [],
      [
        { decision: "blocked", reasonCode: "ROOM_ROOT_FORGED" },
        { decision: "blocked", reasonCode: "ROOM_ROOT_FORGED" },
      ],
      [{ decision: "permitted", reasonCode: null }],
      [{ decision: "blocked", reasonCode: "" }],
      [{ decision: "blocked", reasonCode: null }],
    ];
    for (const selfRootAttempts of badAttempts) {
      const result = evaluateGroupChatEvidence("GC-06", { ...gc06Base(), selfRootAttempts });
      expect(result.passed, JSON.stringify(selfRootAttempts)).toBe(false);
      expect(result.detail).toContain("自报新根");
    }
  });

  const gc07Forged = (
    controlId: string,
  ): GroupChatEvidenceById["GC-07"]["falseControls"][number] => ({
    controlId,
    records: [
      {
        sequence: 1,
        controlId,
        issuerId: fixture.humanId,
        targetId: fixture.residentIds.a,
        action: "stop",
        phase: "rejected",
        cutoffId: null,
        externalEffectReversed: false,
      },
    ],
  });
  const gc07OldTarget: DispatchIdentity = {
    residentId: a,
    scopeId: "test-scope:gc07",
    scopeGeneration: 1,
    windowId: "test-window:gc07",
    generation: 1,
    dispatchId: "test-dispatch:gc07-old",
  };
  const gc07ResultRow = (
    operationId: string,
    phase: MemberResultRecord["phase"],
    sequence: number,
    reasonCode: string | null = null,
  ): MemberResultRecord => ({
    sequence,
    operationId,
    target: gc07OldTarget,
    phase,
    reasonCode,
  });
  const gc07Base = (): GroupChatEvidenceById["GC-07"] => ({
    ordinaryQueueDepthBeforeControl: 3,
    heldBeforeControl: true,
    stopAcceptedBeforeQueueRelease: true,
    stopEffective: true,
    oldPermitCommitted: false,
    falseControls: [
      gc07Forged("gc07-quoted-stop"),
      gc07Forged("gc07-resident-forgery"),
      gc07Forged("gc07-unauthorized-human"),
    ],
    acceptedAndEffectiveSeparated: true,
    unreachableRecords: [
      {
        sequence: 1,
        controlId: "gc07-unreachable",
        issuerId: fixture.humanId,
        targetId: fixture.residentIds.c,
        action: "stop",
        phase: "incomplete",
        cutoffId: null,
        externalEffectReversed: false,
      },
    ],
    externalEffectClaimedReversed: false,
    continueEffectiveWhileQueueBlocked: true,
    postContinueNewPermitCommitted: true,
    postContinueOldPermitResults: [
      gc07ResultRow("gc07-old-permit", "returned", 20),
      gc07ResultRow("gc07-old-permit", "rejected", 21, "ROOM_CONTROL_CUTOFF"),
    ],
    postContinueOldTarget: gc07OldTarget,
    postContinueOldBodyInRoom: false,
  });

  it("GC-07 requires every forged control explicitly rejected without a cutoff", () => {
    expect(evaluateGroupChatEvidence("GC-07", gc07Base()).passed).toBe(true);
    const mutate = (index: number, records: ControlRecord[]) => ({
      ...gc07Base(),
      falseControls: gc07Base().falseControls.map((entry, at) =>
        at === index ? { ...entry, records } : entry,
      ),
    });
    const forgedRecord = (controlId: string, overrides: Partial<ControlRecord>): ControlRecord => ({
      sequence: 1,
      controlId,
      issuerId: fixture.humanId,
      targetId: fixture.residentIds.a,
      action: "stop",
      phase: "rejected",
      cutoffId: null,
      externalEffectReversed: false,
      ...overrides,
    });
    const acceptedForgery = mutate(1, [
      forgedRecord("gc07-resident-forgery", { phase: "accepted" }),
    ]);
    expect(evaluateGroupChatEvidence("GC-07", acceptedForgery).passed).toBe(false);
    const cutoffForgery = mutate(2, [
      forgedRecord("gc07-unauthorized-human", { cutoffId: "control-cutoff:x" }),
    ]);
    expect(evaluateGroupChatEvidence("GC-07", cutoffForgery).passed).toBe(false);
    expect(evaluateGroupChatEvidence("GC-07", mutate(0, [])).passed).toBe(false);
    // #206 review 4: two identical rejected records must not count as exactly one.
    const duplicated = mutate(0, [
      forgedRecord("gc07-quoted-stop", {}),
      forgedRecord("gc07-quoted-stop", { sequence: 2 }),
    ]);
    expect(evaluateGroupChatEvidence("GC-07", duplicated).passed).toBe(false);
  });

  const gc08Decision = (
    operationId: string,
    state: DeliveryDecisionRecord["state"],
    reasonCode: string,
  ): DeliveryDecisionRecord => ({
    sequence: 1,
    operationId,
    senderId: fixture.residentIds.a,
    state,
    reasonCode,
    count: 1,
    permitConsumed: true,
    rosterVersion: 1,
    target: null,
  });
  const gc08Feedback = (operationId: string, reasonCode: string): SenderFeedbackRecord => ({
    operationId,
    senderId: fixture.residentIds.a,
    roomId: fixture.roomId,
    scopeId: "test-scope:room",
    reasonCode,
    count: 1,
    phase: "delivered",
    deliveryReceipt: `feedback-receipt:${operationId}`,
    body: null,
  });
  const gc08Base = (): GroupChatEvidenceById["GC-08"] => ({
    expectedByOperation: [
      { operationId: "op-batch", senderId: a, state: "batched" },
      { operationId: "op-not-included", senderId: a, state: "not-included" },
      { operationId: "op-stopped", senderId: a, state: "stop-blocked" },
      { operationId: "op-dispatch", senderId: a, state: "dispatch-failed" },
    ],
    decisions: [
      gc08Decision("op-batch", "batched", "ROOM_BATCHED"),
      gc08Decision("op-not-included", "not-included", "ROOM_NOT_INCLUDED"),
      gc08Decision("op-stopped", "stop-blocked", "ROOM_STOPPED"),
      gc08Decision("op-dispatch", "dispatch-failed", "ROOM_DISPATCH_FAILED"),
    ],
    offlineFeedbackMarkedDelivered: false,
    deliveredFeedback: [
      gc08Feedback("op-batch", "ROOM_BATCHED"),
      gc08Feedback("op-not-included", "ROOM_NOT_INCLUDED"),
      gc08Feedback("op-stopped", "ROOM_STOPPED"),
      gc08Feedback("op-dispatch", "ROOM_DISPATCH_FAILED"),
    ],
    crossSenderFeedback: [],
    leakedBlockedBody: false,
    unsupportedClaims: [],
    stableReasonsAcrossRestart: true,
    persistFailureConsumedPermit: false,
    persistedDecisionCountAfterRetry: 1,
  });

  it("GC-08 pins each expected state and its feedback reason to the operationId", () => {
    expect(evaluateGroupChatEvidence("GC-08", gc08Base()).passed).toBe(true);
    const swappedStates = {
      ...gc08Base(),
      decisions: [
        gc08Decision("op-batch", "not-included", "ROOM_BATCHED"),
        gc08Decision("op-not-included", "batched", "ROOM_NOT_INCLUDED"),
        gc08Decision("op-stopped", "stop-blocked", "ROOM_STOPPED"),
        gc08Decision("op-dispatch", "dispatch-failed", "ROOM_DISPATCH_FAILED"),
      ],
    };
    expect(evaluateGroupChatEvidence("GC-08", swappedStates).passed).toBe(false);
    const misalignedFeedback = {
      ...gc08Base(),
      deliveredFeedback: [
        gc08Feedback("op-batch", "ROOM_DISPATCH_FAILED"),
        gc08Feedback("op-not-included", "ROOM_NOT_INCLUDED"),
        gc08Feedback("op-stopped", "ROOM_STOPPED"),
        gc08Feedback("op-dispatch", "ROOM_DISPATCH_FAILED"),
      ],
    };
    expect(evaluateGroupChatEvidence("GC-08", misalignedFeedback).passed).toBe(false);
  });

  const authorizedIds = ["gc10-event-1", "gc10-event-2", "gc10-event-3", "gc10-event-4"];
  const gc10Projection = (
    projectionId: string,
    included: readonly string[],
    omitted: readonly string[],
    truncations: ProjectionReceipt["truncations"] = [],
  ): ProjectionReceipt => ({
    projectionId,
    viewerId: fixture.residentIds.a,
    sourceRange: [included[0] ?? "none", included[included.length - 1] ?? "none"],
    watermark: "watermark:x",
    policyVersion: "test-projection-policy:v1",
    includedEventIds: [...included],
    omittedEventIds: [...omitted],
    complete: false,
    errorCode: null,
    truncations,
  });
  const gc10LongBody = "TEST-GC10-LONG-".repeat(12);
  const gc10Truth = {
    eventId: "gc10-event-3",
    originalLength: 180,
    maxCharacters: 24,
    body: gc10LongBody,
  } as const;
  const gc10Truncation = {
    eventId: "gc10-event-3",
    originalLength: 180,
    unit: "characters" as const,
    keptStart: 0,
    keptEnd: 24,
    sourceRef: "room-source:gc10-event-3",
    modelVisible: true,
  };
  const gc10Base = (): GroupChatEvidenceById["GC-10"] => ({
    authorizedEventIds: authorizedIds,
    batch: gc10Projection(
      "gc10-batch",
      ["gc10-event-1", "gc10-event-4"],
      ["gc10-event-2", "gc10-event-3"],
    ),
    latest: gc10Projection(
      "gc10-latest",
      ["gc10-event-3", "gc10-event-4"],
      ["gc10-event-1", "gc10-event-2"],
    ),
    truncated: gc10Projection(
      "gc10-truncate",
      ["gc10-event-3"],
      ["gc10-event-1", "gc10-event-2", "gc10-event-4"],
      [gc10Truncation],
    ),
    projectionContext: "room-source:gc10-event-3 180 characters 0:24",
    truncationTruth: gc10Truth,
    hiddenWorldFingerprints: ["x", "x", "x"],
    grantedRead: {
      sourceRef: "room-source:gc10-event-3",
      viewerId: fixture.residentIds.a,
      outcome: "granted",
      eventId: "gc10-event-3",
      body: gc10LongBody,
      errorCode: null,
    },
    deniedRead: {
      sourceRef: "room-source:gc10-event-3",
      viewerId: fixture.residentIds.a,
      outcome: "denied",
      eventId: null,
      body: null,
      errorCode: "not-found",
    },
  });

  it("GC-10 reconciles included/omitted identities with the judge-seeded authorized set", () => {
    expect(evaluateGroupChatEvidence("GC-10", gc10Base()).passed).toBe(true);
    const overlap = {
      ...gc10Base(),
      batch: gc10Projection(
        "gc10-batch",
        ["gc10-event-1", "gc10-event-4"],
        ["gc10-event-4", "gc10-event-2", "gc10-event-3"],
      ),
    };
    expect(evaluateGroupChatEvidence("GC-10", overlap).passed).toBe(false);
    const staleLatest = {
      ...gc10Base(),
      latest: gc10Projection(
        "gc10-latest",
        ["gc10-event-2", "gc10-event-3"],
        ["gc10-event-1", "gc10-event-4"],
      ),
    };
    expect(evaluateGroupChatEvidence("GC-10", staleLatest).passed).toBe(false);
    const doubleTruncate = {
      ...gc10Base(),
      truncated: gc10Projection(
        "gc10-truncate",
        ["gc10-event-3", "gc10-event-2"],
        ["gc10-event-1", "gc10-event-4"],
        [gc10Truncation],
      ),
    };
    expect(evaluateGroupChatEvidence("GC-10", doubleTruncate).passed).toBe(false);
    // #206 review 4: repeating one authorized id while dropping another must not reconcile.
    const duplicatedId = {
      ...gc10Base(),
      batch: gc10Projection(
        "gc10-batch",
        ["gc10-event-1", "gc10-event-1"],
        ["gc10-event-2", "gc10-event-3"],
      ),
    };
    expect(evaluateGroupChatEvidence("GC-10", duplicatedId).passed).toBe(false);
  });

  const gc12OldTarget: DispatchIdentity = {
    residentId: a,
    scopeId: "test-scope:gc12",
    scopeGeneration: 2,
    windowId: "test-window:gc12",
    generation: 2,
    dispatchId: "test-dispatch:gc12-generation-2",
  };
  const gc12ResultRow = (
    operationId: string,
    phase: MemberResultRecord["phase"],
    sequence: number,
    reasonCode: string | null = null,
  ): MemberResultRecord => ({
    sequence,
    operationId,
    target: gc12OldTarget,
    phase,
    reasonCode,
  });
  const gc12Base = (): GroupChatEvidenceById["GC-12"] => ({
    revokedDeliveryCommitted: false,
    revokedDeliveryReasoned: true,
    rosterVersionAdvanced: true,
    staleResultActuallyReturned: true,
    staleResultCommitted: false,
    staleResultReasoned: true,
    stoppedResultActuallyReturned: true,
    stoppedResultCommitted: false,
    stoppedResultReasoned: true,
    postContinueResultCommitted: true,
    forgedTupleFields: [
      "residentId",
      "scopeId",
      "scopeGeneration",
      "windowId",
      "generation",
      "dispatchId",
    ],
    forgedTupleAttempts: 6,
    forgedTupleCommits: 0,
    currentTupleCommits: 1,
    postContinueStoppedResults: [
      gc12ResultRow("gc12-cutoff-old", "returned", 30),
      gc12ResultRow("gc12-cutoff-old", "rejected", 31, "ROOM_CONTROL_CUTOFF"),
    ],
    postContinueOldTarget: gc12OldTarget,
    postContinueOldBodyInRoom: false,
  });

  it("GC-12 requires a rejected cutoff record and one distinct field moved per forgery", () => {
    expect(evaluateGroupChatEvidence("GC-12", gc12Base()).passed).toBe(true);
    const noRejection = { ...gc12Base(), stoppedResultReasoned: false };
    expect(evaluateGroupChatEvidence("GC-12", noRejection).passed).toBe(false);
    const duplicatedFields = {
      ...gc12Base(),
      forgedTupleFields: [
        "residentId",
        "residentId",
        "residentId",
        "residentId",
        "residentId",
        "residentId",
      ],
    };
    expect(evaluateGroupChatEvidence("GC-12", duplicatedFields).passed).toBe(false);
  });

  const gc16Attempt = (attempt: number): MemberAttemptRecord => ({
    sequence: attempt,
    operationId: "gc16-failing-member",
    memberId: fixture.residentIds.a,
    attempt,
    outcome: "failed",
    reasonCode: "ROOM_MEMBER_FAILED",
  });
  const gc16Base = (): GroupChatEvidenceById["GC-16"] => ({
    failedMemberAttempts: [gc16Attempt(1), gc16Attempt(2)],
    normalMemberCompleted: true,
    humanContinued: true,
    controlContinued: true,
    heldWasActuallyInFlight: true,
    heldTimedOut: true,
    configuredMaxMemberAttempts: 2,
    failingOperationAttempts: [gc16Attempt(1), gc16Attempt(2)],
    restartPidChanged: true,
    restartCommitStable: true,
    failuresBeforeRestart: 2,
    failuresAfterRestart: 2,
    highWaterBeforeRestart: 2,
    highWaterAfterRestart: 2,
    failureFeedbackRetained: true,
    falsePresenceClaims: [],
    unsupportedClaims: [],
  });

  it("GC-16 bounds retries by attempt numbers, not just row counts", () => {
    expect(evaluateGroupChatEvidence("GC-16", gc16Base()).passed).toBe(true);
    const badSequences: readonly (readonly MemberAttemptRecord[])[] = [
      [gc16Attempt(999)],
      [gc16Attempt(0)],
      [gc16Attempt(1), gc16Attempt(1)],
      [gc16Attempt(2)],
      [gc16Attempt(1), gc16Attempt(2), gc16Attempt(3)],
    ];
    for (const failingOperationAttempts of badSequences) {
      const result = evaluateGroupChatEvidence("GC-16", {
        ...gc16Base(),
        failingOperationAttempts,
      });
      expect(result.passed, JSON.stringify(failingOperationAttempts)).toBe(false);
      expect(result.detail).toContain("无界");
    }
  });

  // #206 review 5: duplicates count as recorded; a unique-match readback may never wash them.
  it("GC-01 counts duplicated forged-body copies in the recorded-author multiset", () => {
    const base = {
      legitimateHuman: { accepted: true, authorId: fixture.humanId },
      legitimate: { accepted: true, authorId: a },
      forgedEnvelopeAccepted: false,
      forgedBodyAccepted: true,
      forgedBodyAuthorId: a,
      unexpectedAuthors: [],
      recordedAuthorIds: [fixture.humanId, a, a],
    };
    expect(evaluateGroupChatEvidence("GC-01", base).passed).toBe(true);
    const duplicated = evaluateGroupChatEvidence("GC-01", {
      ...base,
      forgedBodyAuthorId: null,
      recordedAuthorIds: [fixture.humanId, a, a, a],
    });
    expect(duplicated.passed).toBe(false);
  });

  // #206 review 5: bounded worlds reconcile by operationId in host ledger order.
  it("GC-06 reconciles bounded worlds by operationId in ledger order", () => {
    expect(evaluateGroupChatEvidence("GC-06", gc06Base()).passed).toBe(true);
    const withWorld = (
      records: GroupChatEvidenceById["GC-06"]["boundedWorlds"][number]["records"],
    ): GroupChatEvidenceById["GC-06"] => ({
      ...gc06Base(),
      boundedWorlds: [
        { budget: 1, records, oneRoot: true, policyVersionStable: true },
        gc06Base().boundedWorlds[1] as GroupChatEvidenceById["GC-06"]["boundedWorlds"][number],
      ],
    });
    const turn1 = gc06TurnRecord("gc06-B1-turn-1", "permitted", 1);
    const turn2 = gc06TurnRecord("gc06-B1-turn-2", "blocked", 2, "ROOM_TURN_BUDGET_EXHAUSTED");
    // Operation labels swapped between the two turns.
    expect(
      evaluateGroupChatEvidence(
        "GC-06",
        withWorld([
          gc06TurnRecord("gc06-B1-turn-2", "permitted", 1),
          { ...turn2, operationId: "gc06-B1-turn-1" },
        ]),
      ).passed,
    ).toBe(false);
    // Block-before-permit: the ledger order itself is inverted.
    expect(
      evaluateGroupChatEvidence(
        "GC-06",
        withWorld([
          { ...turn2, sequence: 1 },
          { ...turn1, sequence: 2 },
        ]),
      ).passed,
    ).toBe(false);
    // Missing, duplicated and extra records.
    expect(evaluateGroupChatEvidence("GC-06", withWorld([turn1])).passed).toBe(false);
    expect(
      evaluateGroupChatEvidence("GC-06", withWorld([turn1, turn2, { ...turn2, sequence: 3 }]))
        .passed,
    ).toBe(false);
    // The blocking record must carry a stable reason.
    expect(
      evaluateGroupChatEvidence("GC-06", withWorld([turn1, { ...turn2, reasonCode: "" }])).passed,
    ).toBe(false);
  });

  // #206 review 5: the generation-change stimulus needs exactly one reasoned blocked record.
  it("GC-06 requires exactly one reasoned blocked record for the generation-change stimulus", () => {
    expect(evaluateGroupChatEvidence("GC-06", gc06Base()).passed).toBe(true);
    const badAttempts: readonly (readonly Pick<RoundRecord, "decision" | "reasonCode">[])[] = [
      [],
      [
        { decision: "blocked", reasonCode: "ROOM_TURN_BUDGET_EXHAUSTED" },
        { decision: "blocked", reasonCode: "ROOM_TURN_BUDGET_EXHAUSTED" },
      ],
      [{ decision: "human-trigger", reasonCode: null }],
      [{ decision: "passed", reasonCode: null }],
      [{ decision: "failed", reasonCode: "ROOM_MEMBER_FAILED" }],
      [{ decision: "retry-replayed", reasonCode: null }],
      [{ decision: "blocked", reasonCode: "" }],
      [{ decision: "blocked", reasonCode: null }],
    ];
    for (const identityChangeAttempts of badAttempts) {
      const result = evaluateGroupChatEvidence("GC-06", {
        ...gc06Base(),
        identityChangeAttempts,
      });
      expect(result.passed, JSON.stringify(identityChangeAttempts)).toBe(false);
      expect(result.detail).toContain("换代刺激");
    }
  });

  // #206 review 5: the unreachable control needs exactly one incomplete record, nothing else.
  it("GC-07 requires exactly one incomplete record for the unreachable control", () => {
    expect(evaluateGroupChatEvidence("GC-07", gc07Base()).passed).toBe(true);
    const unreachableRecord = (overrides: Partial<ControlRecord>): ControlRecord => ({
      sequence: 1,
      controlId: "gc07-unreachable",
      issuerId: fixture.humanId,
      targetId: fixture.residentIds.c,
      action: "stop",
      phase: "incomplete",
      cutoffId: null,
      externalEffectReversed: false,
      ...overrides,
    });
    const badRecords: readonly (readonly ControlRecord[])[] = [
      [],
      [unreachableRecord({}), unreachableRecord({ sequence: 2 })],
      [unreachableRecord({}), unreachableRecord({ sequence: 2, phase: "effective" })],
      [unreachableRecord({ sequence: 2, phase: "accepted" }), unreachableRecord({})],
      [unreachableRecord({ phase: "effective" })],
      [unreachableRecord({ cutoffId: "control-cutoff:x" })],
    ];
    for (const unreachableRecords of badRecords) {
      const result = evaluateGroupChatEvidence("GC-07", { ...gc07Base(), unreachableRecords });
      expect(result.passed, JSON.stringify(unreachableRecords)).toBe(false);
      expect(result.detail).toContain("不可达");
    }
  });

  // #206 review 5: proxy-signed resident receipts and personal-state claims by residents.
  const gc09Receipt = (overrides: Partial<SystemReceipt>): SystemReceipt => ({
    actor: "system",
    phase: "recorded",
    ...overrides,
  });
  const gc09Base = (): GroupChatEvidenceById["GC-09"] => ({
    receipts: [
      gc09Receipt({ phase: "recorded", claim: "系统已收" }),
      gc09Receipt({ phase: "dispatched", claim: "已派发" }),
      gc09Receipt({
        phase: "context-committed",
        claim: "已装入",
        contextCommitRef: "context-commit:1",
      }),
      gc09Receipt({ actor: a, phase: "reaction" }),
    ],
    receiptsAfterRecord: [gc09Receipt({ phase: "recorded", claim: "系统已收" })],
    receiptsAfterDispatch: [
      gc09Receipt({ phase: "recorded", claim: "系统已收" }),
      gc09Receipt({ phase: "dispatched", claim: "已派发" }),
    ],
    prematureReceiptPhases: [],
    judgeSeededContextCommitId: "context-commit:1",
    reactionAuthorsBeforeResidentReacted: [],
    reactionAuthorsAfterResidentReacted: [a],
    memoryRecordsAddedByContextCommit: 0,
  });

  it("GC-09 flags any resident-signed receipt in the snapshots before the resident reacts", () => {
    expect(evaluateGroupChatEvidence("GC-09", gc09Base()).passed).toBe(true);
    const proxySigned = {
      ...gc09Base(),
      receiptsAfterRecord: [
        ...gc09Base().receiptsAfterRecord,
        gc09Receipt({ actor: a, phase: "seen", claim: "成员已读并记住了" }),
      ],
    };
    const result = evaluateGroupChatEvidence("GC-09", proxySigned);
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("代签");
  });

  it("GC-09 runs personal-state guards over resident-authored receipts even after a real reaction", () => {
    const claimForgery = evaluateGroupChatEvidence("GC-09", {
      ...gc09Base(),
      receipts: [
        ...gc09Base().receipts,
        gc09Receipt({ actor: a, phase: "reaction", claim: "成员已读并记住了" }),
      ],
    });
    expect(claimForgery.passed).toBe(false);
    const phaseForgery = evaluateGroupChatEvidence("GC-09", {
      ...gc09Base(),
      receipts: [...gc09Base().receipts, gc09Receipt({ actor: a, phase: "seen" })],
    });
    expect(phaseForgery.passed).toBe(false);
  });

  // #206 review 5: truncation metadata is bound to the judge-seeded truth, field-exact.
  it("GC-10 binds truncation metadata to judge truth with field-exact context matching", () => {
    expect(evaluateGroupChatEvidence("GC-10", gc10Base()).passed).toBe(true);
    const wrongEvent = {
      ...gc10Base(),
      truncated: gc10Projection(
        "gc10-truncate",
        ["gc10-event-3"],
        ["gc10-event-1", "gc10-event-2", "gc10-event-4"],
        [{ ...gc10Truncation, eventId: "gc10-event-2" }],
      ),
    };
    expect(evaluateGroupChatEvidence("GC-10", wrongEvent).passed).toBe(false);
    // The review's wash: originalLength forged to kept+1 with the context line synced.
    const forgedLength = {
      ...gc10Base(),
      truncated: gc10Projection(
        "gc10-truncate",
        ["gc10-event-3"],
        ["gc10-event-1", "gc10-event-2", "gc10-event-4"],
        [{ ...gc10Truncation, originalLength: 25 }],
      ),
      projectionContext: "room-source:gc10-event-3 25 characters 0:24",
    };
    const forgedResult = evaluateGroupChatEvidence("GC-10", forgedLength);
    expect(forgedResult.passed).toBe(false);
    expect(forgedResult.detail).toContain("原长");
    // Kept range over the requested cap / degenerate range.
    const overCap = {
      ...gc10Base(),
      truncated: gc10Projection(
        "gc10-truncate",
        ["gc10-event-3"],
        ["gc10-event-1", "gc10-event-2", "gc10-event-4"],
        [{ ...gc10Truncation, keptEnd: 25 }],
      ),
      projectionContext: "room-source:gc10-event-3 180 characters 0:25",
    };
    expect(evaluateGroupChatEvidence("GC-10", overCap).passed).toBe(false);
    const degenerate = {
      ...gc10Base(),
      truncated: gc10Projection(
        "gc10-truncate",
        ["gc10-event-3"],
        ["gc10-event-1", "gc10-event-2", "gc10-event-4"],
        [{ ...gc10Truncation, keptStart: 24, keptEnd: 24 }],
      ),
      projectionContext: "room-source:gc10-event-3 180 characters 24:24",
    };
    expect(evaluateGroupChatEvidence("GC-10", degenerate).passed).toBe(false);
    // Substring washing: "1180" contains "180" but is not the field.
    const substringWash = {
      ...gc10Base(),
      projectionContext: "room-source:gc10-event-3 1180 characters 0:24",
    };
    expect(evaluateGroupChatEvidence("GC-10", substringWash).passed).toBe(false);
  });

  // #206 review 6: exact-match boundaries must accept honest JSON / key=value renderings.
  it("GC-10 accepts JSON and key=value contexts, and rejects extended-token washes", () => {
    const jsonContext =
      '{"sourceRef":"room-source:gc10-event-3","originalLength":180,"unit":"characters","kept":"0:24"}';
    expect(
      evaluateGroupChatEvidence("GC-10", { ...gc10Base(), projectionContext: jsonContext }).passed,
    ).toBe(true);
    const keyValueContext =
      "sourceRef=room-source:gc10-event-3, originalLength=180, unit=characters, range=(0:24)";
    expect(
      evaluateGroupChatEvidence("GC-10", { ...gc10Base(), projectionContext: keyValueContext })
        .passed,
    ).toBe(true);
    // A JSON context whose value differs from the receipt must not wash (125-style).
    const jsonWrongValue =
      '{"sourceRef":"room-source:gc10-event-3","originalLength":125,"unit":"characters","kept":"0:24"}';
    expect(
      evaluateGroupChatEvidence("GC-10", { ...gc10Base(), projectionContext: jsonWrongValue })
        .passed,
    ).toBe(false);
    // Extended tokens: unit, sourceRef and range continuations all stay red.
    const unitExtended = {
      ...gc10Base(),
      projectionContext: "room-source:gc10-event-3 180 charactersX 0:24",
    };
    expect(evaluateGroupChatEvidence("GC-10", unitExtended).passed).toBe(false);
    const sourceRefExtended = {
      ...gc10Base(),
      projectionContext: "room-source:gc10-event-3-ext 180 characters 0:24",
    };
    expect(evaluateGroupChatEvidence("GC-10", sourceRefExtended).passed).toBe(false);
    const sourceRefColonExtended = {
      ...gc10Base(),
      projectionContext: "room-source:gc10-event-3:4 180 characters 0:24",
    };
    expect(evaluateGroupChatEvidence("GC-10", sourceRefColonExtended).passed).toBe(false);
    const rangeExtended = {
      ...gc10Base(),
      projectionContext: "room-source:gc10-event-3 180 characters 10:240",
    };
    expect(evaluateGroupChatEvidence("GC-10", rangeExtended).passed).toBe(false);
    // #206 review 7: same-token `_`/`-` continuations of numeric and range values stay red.
    const numericUnderscore = {
      ...gc10Base(),
      projectionContext: "room-source:gc10-event-3 _180 characters 0:24",
    };
    expect(evaluateGroupChatEvidence("GC-10", numericUnderscore).passed).toBe(false);
    const numericDashed = {
      ...gc10Base(),
      projectionContext: "room-source:gc10-event-3 180-ext characters 0:24",
    };
    expect(evaluateGroupChatEvidence("GC-10", numericDashed).passed).toBe(false);
    const rangeUnderscore = {
      ...gc10Base(),
      projectionContext: "room-source:gc10-event-3 180 characters _0:24",
    };
    expect(evaluateGroupChatEvidence("GC-10", rangeUnderscore).passed).toBe(false);
    const rangeDashed = {
      ...gc10Base(),
      projectionContext: "room-source:gc10-event-3 180 characters 0:24-ext",
    };
    expect(evaluateGroupChatEvidence("GC-10", rangeDashed).passed).toBe(false);
  });

  // #206 review 8: the old permit's first return after continue must still meet the cutoff.
  it("GC-07/GC-12 hold the cutoff for the old permit's first return after continue", () => {
    expect(evaluateGroupChatEvidence("GC-07", gc07Base()).passed).toBe(true);
    expect(evaluateGroupChatEvidence("GC-12", gc12Base()).passed).toBe(true);
    const shapes: readonly (readonly MemberResultRecord[])[] = [
      [],
      [gc07ResultRow("gc07-old-permit", "returned", 20)],
      [
        gc07ResultRow("gc07-old-permit", "returned", 20),
        gc07ResultRow("gc07-old-permit", "committed", 21),
      ],
      [
        gc07ResultRow("gc07-old-permit", "returned", 20),
        gc07ResultRow("gc07-old-permit", "rejected", 21, ""),
      ],
      [
        gc07ResultRow("gc07-old-permit", "returned", 20),
        gc07ResultRow("gc07-old-permit", "rejected", 21, "ROOM_CONTROL_CUTOFF"),
        gc07ResultRow("gc07-old-permit", "committed", 22),
      ],
      [
        gc07ResultRow("gc07-old-permit", "returned", 20),
        gc07ResultRow("gc07-old-permit", "rejected", 21, "ROOM_CONTROL_CUTOFF"),
        gc07ResultRow("gc07-old-permit", "rejected", 22, "ROOM_CONTROL_CUTOFF"),
      ],
    ];
    for (const postContinueOldPermitResults of shapes) {
      const result = evaluateGroupChatEvidence("GC-07", {
        ...gc07Base(),
        postContinueOldPermitResults,
      });
      expect(result.passed, JSON.stringify(postContinueOldPermitResults)).toBe(false);
    }
    const gc07Leak = evaluateGroupChatEvidence("GC-07", {
      ...gc07Base(),
      postContinueOldBodyInRoom: true,
    });
    expect(gc07Leak.passed).toBe(false);
    for (const postContinueStoppedResults of shapes) {
      const result = evaluateGroupChatEvidence("GC-12", {
        ...gc12Base(),
        postContinueStoppedResults: postContinueStoppedResults.map((row) => ({
          ...row,
          operationId: "gc12-cutoff-old",
        })),
      });
      expect(result.passed, JSON.stringify(postContinueStoppedResults)).toBe(false);
    }
    const gc12Leak = evaluateGroupChatEvidence("GC-12", {
      ...gc12Base(),
      postContinueOldBodyInRoom: true,
    });
    expect(gc12Leak.passed).toBe(false);
  });

  // #206 review 8: the granted source read must equal the judge-seeded body, not a prefix.
  it("GC-10 binds the granted source-read body to the full judge-seeded truth", () => {
    expect(evaluateGroupChatEvidence("GC-10", gc10Base()).passed).toBe(true);
    const honestRead = gc10Base().grantedRead as SourceReadAudit;
    const truncatedBody = {
      ...gc10Base(),
      grantedRead: { ...honestRead, body: gc10LongBody.slice(0, 24) },
    };
    const truncatedResult = evaluateGroupChatEvidence("GC-10", truncatedBody);
    expect(truncatedResult.passed).toBe(false);
    expect(truncatedResult.detail).toContain("精确相等");
    const rewrittenBody = {
      ...gc10Base(),
      grantedRead: {
        ...honestRead,
        body: `${gc10LongBody.slice(0, 60)}XXXX${gc10LongBody.slice(64)}`,
      },
    };
    expect(evaluateGroupChatEvidence("GC-10", rewrittenBody).passed).toBe(false);
  });

  // #206 review 8: decisions and feedback must carry the judge-owned senderId.
  it("GC-08 binds each decision and its feedback to the judge-owned senderId", () => {
    expect(evaluateGroupChatEvidence("GC-08", gc08Base()).passed).toBe(true);
    const b = fixture.residentIds.b;
    const wrongDecisionSender = {
      ...gc08Base(),
      decisions: [
        gc08Decision("op-batch", "batched", "ROOM_BATCHED"),
        { ...gc08Decision("op-not-included", "not-included", "ROOM_NOT_INCLUDED"), senderId: b },
        gc08Decision("op-stopped", "stop-blocked", "ROOM_STOPPED"),
        gc08Decision("op-dispatch", "dispatch-failed", "ROOM_DISPATCH_FAILED"),
      ],
    };
    const decisionResult = evaluateGroupChatEvidence("GC-08", wrongDecisionSender);
    expect(decisionResult.passed).toBe(false);
    expect(decisionResult.detail).toContain("senderId");
    const wrongFeedbackSender = {
      ...gc08Base(),
      deliveredFeedback: [
        gc08Feedback("op-batch", "ROOM_BATCHED"),
        { ...gc08Feedback("op-not-included", "ROOM_NOT_INCLUDED"), senderId: b },
        gc08Feedback("op-stopped", "ROOM_STOPPED"),
        gc08Feedback("op-dispatch", "ROOM_DISPATCH_FAILED"),
      ],
    };
    const feedbackResult = evaluateGroupChatEvidence("GC-08", wrongFeedbackSender);
    expect(feedbackResult.passed).toBe(false);
    expect(feedbackResult.detail).toContain("判卷发送方");
  });

  // #206 review 9: post-continue rows must carry the judge-owned target, in ledger order.
  it("GC-07/GC-12 bind post-continue rows to the judge target and ledger order", () => {
    expect(evaluateGroupChatEvidence("GC-07", gc07Base()).passed).toBe(true);
    expect(evaluateGroupChatEvidence("GC-12", gc12Base()).passed).toBe(true);
    // Wrong dispatchId on both rows.
    const gc07WrongDispatch = gc07Base().postContinueOldPermitResults.map((row) => ({
      ...row,
      target: { ...gc07OldTarget, dispatchId: "test-dispatch:other" },
    }));
    const gc07DispatchResult = evaluateGroupChatEvidence("GC-07", {
      ...gc07Base(),
      postContinueOldPermitResults: gc07WrongDispatch,
    });
    expect(gc07DispatchResult.passed).toBe(false);
    expect(gc07DispatchResult.detail).toContain("六元组");
    // Another identity field moved instead.
    const gc07WrongGeneration = gc07Base().postContinueOldPermitResults.map((row) => ({
      ...row,
      target: { ...gc07OldTarget, generation: 99 },
    }));
    expect(
      evaluateGroupChatEvidence("GC-07", {
        ...gc07Base(),
        postContinueOldPermitResults: gc07WrongGeneration,
      }).passed,
    ).toBe(false);
    // Reversed ledger order: rejected before returned.
    const gc07Reversed = {
      ...gc07Base(),
      postContinueOldPermitResults: [
        gc07ResultRow("gc07-old-permit", "rejected", 20, "ROOM_CONTROL_CUTOFF"),
        gc07ResultRow("gc07-old-permit", "returned", 21),
      ],
    };
    const gc07ReversedResult = evaluateGroupChatEvidence("GC-07", gc07Reversed);
    expect(gc07ReversedResult.passed).toBe(false);
    expect(gc07ReversedResult.detail).toContain("没有先于");
    // GC-12: same bindings.
    const gc12WrongDispatch = gc12Base().postContinueStoppedResults.map((row) => ({
      ...row,
      target: { ...gc12OldTarget, dispatchId: "test-dispatch:other" },
    }));
    expect(
      evaluateGroupChatEvidence("GC-12", {
        ...gc12Base(),
        postContinueStoppedResults: gc12WrongDispatch,
      }).passed,
    ).toBe(false);
    const gc12Reversed = {
      ...gc12Base(),
      postContinueStoppedResults: [
        gc12ResultRow("gc12-cutoff-old", "rejected", 30, "ROOM_CONTROL_CUTOFF"),
        gc12ResultRow("gc12-cutoff-old", "returned", 31),
      ],
    };
    expect(evaluateGroupChatEvidence("GC-12", gc12Reversed).passed).toBe(false);
  });
});

describe("#191/#192 runner: real-host provenance and static source scan", () => {
  const head = "0123456789abcdef0123456789abcdef01234567";
  const judgePid = 4242;
  const node = "/opt/test-node/bin/node";
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const entry = join("src", "installer", "cli.ts");
  const hostProcess = (overrides: Partial<HostProcessInfo> = {}): HostProcessInfo => ({
    alive: true,
    ancestors: [judgePid, 1],
    executable: node,
    args: [node, "--import", "tsx", entry],
    ...overrides,
  });
  const facts = (info: HostProcessInfo | null): HostProvenanceFacts => ({
    headCommit: head,
    judgePid,
    judgeExecutable: node,
    repoRoot,
    readProcess: () => info,
  });

  it("rejects the synthetic host's self-report even though it is typed mist-host", async () => {
    const run = await new SyntheticGroupChatHost().startHost();
    expect(hostProvenanceProblem(run, facts(null))).toMatch(/not running/);
    expect(hostProvenanceProblem(run, facts(hostProcess({ ancestors: [1] })))).toMatch(
      /not started by this judge run/,
    );
    expect(hostProvenanceProblem(run, facts(hostProcess()))).toMatch(/not a commit id/);
  });

  it("accepts a live child of the judge running its node on a src/ entry at HEAD", () => {
    const child = facts(hostProcess());
    expect(hostProvenanceProblem({ pid: 5000, commit: head }, child)).toBeNull();
    expect(hostProvenanceProblem({ pid: 5000, commit: head.slice(0, 12) }, child)).toBeNull();
    expect(hostProvenanceProblem({ pid: 5000, commit: "fedcba9876" }, child)).toMatch(
      /not the checked-out HEAD/,
    );
    expect(hostProvenanceProblem({ pid: 5000, commit: "012345" }, child)).toMatch(
      /not a commit id/,
    );
    expect(hostProvenanceProblem({ pid: 0, commit: head }, child)).toMatch(/valid process id/);
  });

  // The #202 second review passed provenance with borrowed live pids and the current HEAD.
  it.each([
    [
      "the judge's own pid",
      judgePid,
      hostProcess({ ancestors: [1] }),
      /not started by this judge run/,
    ],
    ["pid 1", 1, hostProcess({ ancestors: [] }), /not started by this judge run/],
    [
      "a stray sleep",
      7000,
      hostProcess({
        ancestors: [6999, 1],
        executable: "/usr/bin/sleep",
        args: ["sleep", "600"],
      }),
      /not started by this judge run/,
    ],
    [
      "a sleep child",
      7001,
      hostProcess({ executable: "/usr/bin/sleep", args: ["sleep", "600"] }),
      /not this judge's node/,
    ],
    [
      "an idle node -e child",
      7002,
      hostProcess({ args: [node, "-e", "setInterval(() => {}, 1e9)"] }),
      /no entry file/,
    ],
    [
      "a node child running only the judge",
      7003,
      hostProcess({ args: [node, "acceptance/group-chat-run.ts"] }),
      /no entry file/,
    ],
    ["a zombie child", 7004, hostProcess({ alive: false }), /not running/],
  ] as const)("rejects %s even with the current HEAD", (_label, pid, info, reason) => {
    expect(hostProvenanceProblem({ pid, commit: head }, facts(info))).toMatch(reason);
  });

  it("counts only an existing non-test source file under src/ as the host entry", () => {
    expect(isRepoEntryFile(entry, repoRoot)).toBe(true);
    expect(isRepoEntryFile(join(repoRoot, entry), repoRoot)).toBe(true);
    expect(isRepoEntryFile("acceptance/group-chat-run.ts", repoRoot)).toBe(false);
    expect(isRepoEntryFile("src/not-a-real-entry.ts", repoRoot)).toBe(false);
    expect(isRepoEntryFile("src/installer", repoRoot)).toBe(false);
    expect(isRepoEntryFile("--import=tsx", repoRoot)).toBe(false);
    expect(isRepoEntryFile("../outside/src/host.ts", repoRoot)).toBe(false);
  });

  it("finds an entry path containing spaces in a space-joined `ps` command line", async () => {
    const root = await mkdtemp(join(tmpdir(), "gc-provenance-"));
    try {
      await mkdir(join(root, "src", "host dir"), { recursive: true });
      await writeFile(join(root, "src", "host dir", "main.ts"), "export {};\n");
      const words = [node, "--import", "tsx", join(root, "src", "host"), "dir/main.ts"];
      const withRoot = (info: HostProcessInfo): HostProvenanceFacts => ({
        ...facts(info),
        repoRoot: root,
      });
      const run = { pid: 5000, commit: head };
      expect(
        hostProvenanceProblem(run, withRoot(hostProcess({ args: words, argvSplitOnSpaces: true }))),
      ).toBeNull();
      // Exact argv is taken as given: the same words as separate arguments name no entry.
      expect(hostProvenanceProblem(run, withRoot(hostProcess({ args: words })))).toMatch(
        /no entry file/,
      );
      expect(
        hostProvenanceProblem(
          run,
          withRoot(
            hostProcess({
              args: [node, join(root, "src", "host"), "dir/other.ts"],
              argvSplitOnSpaces: true,
            }),
          ),
        ),
      ).toMatch(/no entry file/);
      expect(
        hostProvenanceProblem(
          run,
          withRoot(hostProcess({ executable: null, args: words, argvSplitOnSpaces: true })),
        ),
      ).toMatch(/unreadable binary/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires the host process gone and readbacks refused after stopHost()", async () => {
    const refusing = {
      readRoomEvents: async (): Promise<readonly RoomEvent[]> => {
        throw new Error("host stopped");
      },
    };
    const answering = { readRoomEvents: async (): Promise<readonly RoomEvent[]> => [] };
    expect(await hostStopProblem(refusing, 5000, () => null)).toBeNull();
    expect(await hostStopProblem(refusing, 5000, () => hostProcess({ alive: false }))).toBeNull();
    expect(await hostStopProblem(refusing, 5000, () => hostProcess())).toMatch(/still running/);
    expect(await hostStopProblem(answering, 5000, () => null)).toMatch(/still answered/);
  });

  it.skipIf(process.platform === "win32")(
    "reads a real child's liveness, parents, binary and argv, and forgets it after exit",
    async () => {
      const child = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)", "arg with  spaces"],
        { stdio: "ignore" },
      );
      const pid = child.pid ?? -1;
      try {
        const vias = process.platform === "linux" ? (["proc", "ps"] as const) : (["ps"] as const);
        for (const via of vias) {
          const info = readProcessInfo(pid, via);
          expect(info?.alive, via).toBe(true);
          expect(info?.ancestors, via).toContain(process.pid);
          expect(info?.args?.[1], via).toBe("-e");
        }
        // `ps` only has the space-joined line; its words rejoin to the original argument.
        const viaPs = readProcessInfo(pid, "ps");
        expect(viaPs?.argvSplitOnSpaces).toBe(true);
        expect(viaPs?.args?.join(" ")).toMatch(/ arg with {2}spaces$/u);
        if (process.platform === "linux") {
          const viaProc = readProcessInfo(pid, "proc");
          expect(viaProc?.executable).toBe(realpathSync(process.execPath));
          expect(viaProc?.args?.at(-1)).toBe("arg with  spaces");
          expect(viaProc?.argvSplitOnSpaces).toBeUndefined();
          // procps reports comm as a bare name: unreadable, never matched by name.
          expect(viaPs?.executable).toBeNull();
        }
      } finally {
        const exited = new Promise((done) => child.once("exit", done));
        child.kill();
        await exited;
      }
      expect(readProcessInfo(pid)).toBeNull();
    },
  );

  it("fails restart provenance when the previous host pid is still alive or reused", () => {
    const previous = { pid: 5000, commit: head };
    const current = { pid: 5001, commit: head };
    const factsFor = (alivePids: readonly number[]): HostProvenanceFacts => ({
      headCommit: head,
      judgePid,
      judgeExecutable: node,
      repoRoot,
      readProcess: (pid) =>
        alivePids.includes(pid) ? hostProcess({ ancestors: [judgePid, 1] }) : null,
    });
    expect(restartedHostProvenanceProblem(previous, current, factsFor([5000, 5001]))).toMatch(
      /still alive/,
    );
    expect(restartedHostProvenanceProblem(previous, previous, factsFor([5001]))).toMatch(/reused/);
    expect(restartedHostProvenanceProblem(previous, current, factsFor([5001]))).toBeNull();
  });

  it.todo(
    "writes a durable challenge straight into the host's room ledger and reads it back through the adapter (needs the #191 adapter's data-root contract)",
  );

  it("finds member-id literals only in non-test source files", async () => {
    const root = await mkdtemp(join(tmpdir(), "gc04-scan-"));
    try {
      await mkdir(join(root, "group-chat"), { recursive: true });
      await mkdir(join(root, "tests"), { recursive: true });
      await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
      const literal = `if (target === "${fixture.residentIds.b}") route();\n`;
      await writeFile(join(root, "group-chat", "router.ts"), literal);
      await writeFile(join(root, "group-chat", "router.test.ts"), literal);
      await writeFile(join(root, "tests", "fixture.ts"), literal);
      await writeFile(join(root, "node_modules", "pkg", "index.ts"), literal);
      await writeFile(join(root, "group-chat", "roster.ts"), "export const members = load();\n");
      expect(await findSourceLiterals(root, [fixture.residentIds.b])).toEqual([
        join("group-chat", "router.ts"),
      ]);
      expect(await findSourceLiterals(join(root, "missing"), [fixture.residentIds.b])).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("#206 review 1 runner: restart provenance failure is a whole-run red, never one lamp", () => {
  const head = "0123456789abcdef0123456789abcdef01234567";
  const judgePid = 4242;
  const node = "/opt/test-node/bin/node";
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const entry = join("src", "installer", "cli.ts");

  type HostRun = { readonly pid: number; readonly commit: string };
  type RestartScript = (previous: HostRun, alive: Set<number>) => HostRun;

  /** A synthetic host whose process story is readable by the judge's own facts. */
  class RestartProbeHost extends SyntheticGroupChatHost {
    private readonly alivePids = new Set<number>();
    private stoppedNow = false;
    private currentRun: HostRun = { pid: 5000, commit: head };
    constructor(private readonly restartScript: RestartScript) {
      super();
    }
    override async startHost(): Promise<HostRun> {
      this.alivePids.add(this.currentRun.pid);
      return this.currentRun;
    }
    override async restartHost(): Promise<HostRun> {
      this.currentRun = this.restartScript(this.currentRun, this.alivePids);
      return this.currentRun;
    }
    override async stopHost(): Promise<void> {
      this.stoppedNow = true;
      this.alivePids.clear();
    }
    override async readRoomEvents(roomId?: string): Promise<readonly RoomEvent[]> {
      if (this.stoppedNow) throw new Error("host stopped");
      return super.readRoomEvents(roomId);
    }
    get livePids(): ReadonlySet<number> {
      return this.alivePids;
    }
  }

  const probeFacts = (host: RestartProbeHost): HostProvenanceFacts => ({
    headCommit: head,
    judgePid,
    judgeExecutable: node,
    repoRoot,
    readProcess: (pid) =>
      host.livePids.has(pid)
        ? {
            alive: true,
            ancestors: [judgePid, 1],
            executable: node,
            args: [node, "--import", "tsx", entry],
          }
        : null,
  });

  const runWith = async (restartScript: RestartScript, strict: boolean) => {
    const host = new RestartProbeHost(restartScript);
    return executeGroupChatAcceptance({
      strict,
      loadDriver: async () => ({ driver: host, stubbed: new Set<string>() }),
      facts: probeFacts(host),
      log: () => {},
    });
  };

  const healthyRestart: RestartScript = (previous, alive) => {
    alive.delete(previous.pid);
    const next = { pid: previous.pid + 1, commit: previous.commit };
    alive.add(next.pid);
    return next;
  };

  it("runs all thirteen lamps green with an attributable restart", async () => {
    const outcome = await runWith(healthyRestart, true);
    expect(outcome.provenanceFailed).toBe(false);
    expect(scoreGroupChatResults(outcome.results)).toEqual({
      trueGreen: 13,
      stubGreen: 0,
      strictPass: true,
    });
    expect(outcome.exitCode).toBe(0);
  });

  it.each([
    ["a reused pid", (previous: HostRun, _alive: Set<number>): HostRun => previous],
    [
      "the previous pid still alive",
      (previous: HostRun, alive: Set<number>): HostRun => {
        const next = { pid: previous.pid + 1, commit: previous.commit };
        alive.add(next.pid);
        return next;
      },
    ],
    [
      "a changed commit",
      (previous: HostRun, alive: Set<number>): HostRun => {
        alive.delete(previous.pid);
        const next = {
          pid: previous.pid + 1,
          commit: "fedcba9876543210fedcba9876543210fedcba98",
        };
        alive.add(next.pid);
        return next;
      },
    ],
    [
      "a current process that is not running",
      (previous: HostRun, alive: Set<number>): HostRun => {
        alive.delete(previous.pid);
        return { pid: previous.pid + 2, commit: previous.commit };
      },
    ],
  ] as const)(
    "restart provenance failure (%s) paints every lamp red in both modes",
    async (_label, restartScript) => {
      for (const strict of [false, true]) {
        const outcome = await runWith(restartScript, strict);
        expect(outcome.provenanceFailed, `strict=${strict}`).toBe(true);
        expect(outcome.results.map((result) => result.id)).toEqual(GROUP_CHAT_CHECK_IDS);
        for (const result of outcome.results) {
          expect(result.passed, `strict=${strict}`).toBe(false);
          expect(result.detail, `strict=${strict}`).toContain("provenance");
          expect(result.detail, `strict=${strict}`).not.toContain("scenario threw");
        }
        expect(scoreGroupChatResults(outcome.results)).toEqual({
          trueGreen: 0,
          stubGreen: 0,
          strictPass: false,
        });
        expect(outcome.exitCode, `strict=${strict}`).toBe(1);
      }
    },
  );

  it("keeps a missing driver as the exit-0 report baseline, distinct from provenance red", async () => {
    const report = await executeGroupChatAcceptance({
      strict: false,
      loadDriver: async () => null,
      log: () => {},
    });
    expect(report.driverMissing).toBe(true);
    expect(report.provenanceFailed).toBe(false);
    expect(report.exitCode).toBe(0);
    const strictRun = await executeGroupChatAcceptance({
      strict: true,
      loadDriver: async () => null,
      log: () => {},
    });
    expect(strictRun.driverMissing).toBe(true);
    expect(strictRun.exitCode).toBe(1);
  });
});
