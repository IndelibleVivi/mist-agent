import type { ResidentRuntime } from "../../src/resident-runtime/runtime.ts";

/** 合成测试显式走 candidate 本人自认，不能以配通道代替身份激活。 */
export function activateSyntheticResident(
  runtime: ResidentRuntime,
  residentId: string,
  persona = `persona:${residentId}`,
): void {
  if (runtime.requireActiveResident(residentId).ok) return;
  const candidate = runtime.createCandidate({
    persona,
    proposedBy: { kind: "installer", id: "preflight-test" },
    residentId,
  });
  const activated = runtime.attestCandidate(
    candidate.candidateId,
    { kind: "candidate", candidateId: candidate.candidateId },
    "accepted",
  );
  if (!activated.ok || activated.value.residentId !== residentId) {
    throw new Error(`failed to activate synthetic resident ${residentId}`);
  }
}
