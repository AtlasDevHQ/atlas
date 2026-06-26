import type { LucideIcon } from "lucide-react";
import { Building2, CheckCircle2, Database, Mail, MapPin, UserPlus } from "lucide-react";

export interface SignupStepDef {
  readonly id: string;
  readonly label: string;
  readonly icon: LucideIcon;
}

// `as const` makes the array a tuple of exact literal types so `SignupStepId`
// is derived from a single source of truth. Adding, removing, or renaming an
// entry here is the only thing needed — every consumer picks it up at compile
// time.
//
// Order encodes ADR-0024 §4's signup reorder: **email → region → account** →
// workspace → connect. Region is chosen *before* the first identity write
// (account creation), so the workspace is provisioned in the selected region's
// DB rather than US. "Email" (identifier entry, not a write) leads so the
// region picker can repoint the browser at the regional API before account
// creation. The order is strictly forward — each page maps to exactly one step.
export const FULL_STEPS = [
  { id: "email", label: "Email", icon: Mail },
  { id: "region", label: "Region", icon: MapPin },
  { id: "account", label: "Account", icon: UserPlus },
  { id: "workspace", label: "Workspace", icon: Building2 },
  { id: "connect", label: "Connect", icon: Database },
  { id: "done", label: "Done", icon: CheckCircle2 },
] as const satisfies readonly SignupStepDef[];

export type SignupStepId = (typeof FULL_STEPS)[number]["id"];

export const STEPS_WITHOUT_REGION = FULL_STEPS.filter(
  (s) => s.id !== "region",
) as readonly SignupStepDef[];

export function stepsFor(showRegion: boolean): readonly SignupStepDef[] {
  return showRegion ? FULL_STEPS : STEPS_WITHOUT_REGION;
}

/**
 * Returns the index of `current` in `steps`. Throws if the step is missing —
 * callers must ensure the step they pass is present (e.g. the SignupShell
 * forces `region` into the indicator list when the user is on /signup/region,
 * so `STEPS_WITHOUT_REGION` is never paired with `current="region"`).
 */
export function stepIndex(steps: readonly SignupStepDef[], current: SignupStepId): number {
  const idx = steps.findIndex((s) => s.id === current);
  if (idx === -1) {
    throw new Error(`Step "${current}" not found in signup step list`);
  }
  return idx;
}
