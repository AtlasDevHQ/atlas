/**
 * Symlink-stub surface for `@atlas/ee/onboarding/provision-trial`. Mirrors the
 * exports `packages/mcp/src/onboarding.ts` (and its test) import from this path
 * — `provisionTrialWorkspace`, the typed `TrialProvisioningError`, and the
 * `ProvisionTrial{Input,Result}` / `TrialProvisioningCode` / `TrialWorkspaceState`
 * shapes. Self-serve trial provisioning is enterprise-gated (SaaS-only), so the
 * stub keeps the type surface in lockstep with `ee/src/onboarding/provision-trial.ts`
 * without any behaviour — the symlink-stub CI job is the only consumer and never
 * runs it.
 *
 * Keep these names + types in lockstep with the real module; the exhaustive
 * switch over `TrialProvisioningCode` in `onboarding.ts` depends on the literal
 * union, not a widened `string`.
 *
 * Drift is type-enforced across two builds, so no separate mirror-assertion is
 * needed (unlike the cross-package CRM lead union, which has `check-lead-union-
 * mirror.sh`): normal CI type-checks `packages/mcp` against the REAL union (a
 * new code → onboarding.ts's exhaustive switch fails to compile), and the
 * `ee-stub-build` job type-checks it against THIS stub (a switch case for a code
 * the stub lacks → `tsgo` rejects the comparison). A divergence fails one build
 * or the other.
 *
 * Not used at runtime.
 */

export type TrialWorkspaceState = "grace" | "locked";

export interface ProvisionTrialInput {
  readonly email: string;
  readonly orgName: string;
}

export interface ProvisionTrialResult {
  readonly workspaceId: string;
  readonly connectUrl: string;
  readonly state: TrialWorkspaceState;
}

export type TrialProvisioningCode =
  | "not_saas"
  | "invalid_input"
  | "signup_failed"
  | "org_failed"
  | "trial_not_assigned";

export class TrialProvisioningError extends Error {
  override readonly name = "TrialProvisioningError";
  readonly code: TrialProvisioningCode;
  constructor(code: TrialProvisioningCode, message: string) {
    super(message);
    this.code = code;
  }
}

export async function provisionTrialWorkspace(
  _input: ProvisionTrialInput,
  _overrides?: unknown,
): Promise<ProvisionTrialResult> {
  throw new TrialProvisioningError(
    "not_saas",
    "Self-serve trial provisioning is enterprise-only (stub).",
  );
}
