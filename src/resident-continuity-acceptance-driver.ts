/** Production acceptance wiring for the first #182 implementation slice. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResidentContinuityDriver } from "../acceptance/resident-continuity-driver.ts";
import { ResidentIdentityStore } from "./resident-continuity/identity-store.ts";

export const STUBBED: readonly (keyof ResidentContinuityDriver)[] = [
  "openViewport",
  "switchViewportScope",
  "recordRelationshipAssertion",
  "confirmRelationshipAssertion",
  "readRelationshipAssertion",
  "attachScope",
  "detachScope",
  "readScopeContext",
  "runScopedTurn",
  "tryOperation",
  "introduceEvidenceGap",
  "project",
  "readProjectionReceipt",
  "revisePersona",
  "createMigrationCase",
  "recordMachineConformance",
  "submitBlindEvidence",
  "submitResidentContinuity",
  "submitRelationshipContinuity",
  "activateMigration",
  "readMigrationCase",
  "changeMigrationTarget",
  "runSyntheticEvaluation",
  "createPrivateSource",
  "grantPrivateProjection",
  "projectPrivateSource",
  "inspectEvaluationStorage",
  "revokePrivateSource",
  "readPrivateSource",
  "readEvaluationReceipt",
];

export function createResidentContinuityDriver(): ResidentContinuityDriver {
  const dataDir = mkdtempSync(join(tmpdir(), "mist-resident-continuity-"));
  let identities = new ResidentIdentityStore({ dataDir });
  const unsupported = async (): Promise<never> => {
    throw new Error("not implemented in the OI-01..OI-03 identity-core slice");
  };

  return {
    async reset() {
      rmSync(dataDir, { recursive: true, force: true });
      identities = new ResidentIdentityStore({ dataDir });
    },
    async createCandidate(input) {
      return identities.createCandidate(input);
    },
    async attestCandidate(candidateId, actor, decision) {
      return identities.attestCandidate(candidateId, actor, decision);
    },
    async readCandidate(candidateId) {
      return identities.readCandidate(candidateId);
    },
    async readResident(residentId) {
      return identities.readResident(residentId);
    },
    async restartHost() {
      identities = new ResidentIdentityStore({ dataDir });
    },
    openViewport: unsupported,
    switchViewportScope: unsupported,
    recordRelationshipAssertion: unsupported,
    confirmRelationshipAssertion: unsupported,
    readRelationshipAssertion: unsupported,
    attachScope: unsupported,
    detachScope: unsupported,
    readScopeContext: unsupported,
    runScopedTurn: unsupported,
    tryOperation: unsupported,
    introduceEvidenceGap: unsupported,
    project: unsupported,
    readProjectionReceipt: unsupported,
    revisePersona: unsupported,
    createMigrationCase: unsupported,
    recordMachineConformance: unsupported,
    submitBlindEvidence: unsupported,
    submitResidentContinuity: unsupported,
    submitRelationshipContinuity: unsupported,
    activateMigration: unsupported,
    readMigrationCase: unsupported,
    changeMigrationTarget: unsupported,
    runSyntheticEvaluation: unsupported,
    createPrivateSource: unsupported,
    grantPrivateProjection: unsupported,
    projectPrivateSource: unsupported,
    inspectEvaluationStorage: unsupported,
    revokePrivateSource: unsupported,
    readPrivateSource: unsupported,
    readEvaluationReceipt: unsupported,
  } satisfies ResidentContinuityDriver;
}
