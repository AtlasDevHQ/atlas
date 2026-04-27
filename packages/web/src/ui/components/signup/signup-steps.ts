import type { LucideIcon } from "lucide-react";
import { Building2, CheckCircle2, Database, MapPin, UserPlus } from "lucide-react";

export type SignupStepId = "account" | "workspace" | "region" | "connect" | "done";

export interface SignupStepDef {
  id: SignupStepId;
  label: string;
  icon: LucideIcon;
}

export const FULL_STEPS: readonly SignupStepDef[] = [
  { id: "account", label: "Account", icon: UserPlus },
  { id: "workspace", label: "Workspace", icon: Building2 },
  { id: "region", label: "Region", icon: MapPin },
  { id: "connect", label: "Connect", icon: Database },
  { id: "done", label: "Done", icon: CheckCircle2 },
];

export const STEPS_WITHOUT_REGION: readonly SignupStepDef[] = FULL_STEPS.filter(
  (s) => s.id !== "region",
);

export function stepsFor(showRegion: boolean): readonly SignupStepDef[] {
  return showRegion ? FULL_STEPS : STEPS_WITHOUT_REGION;
}

export function stepIndex(steps: readonly SignupStepDef[], current: SignupStepId): number {
  const idx = steps.findIndex((s) => s.id === current);
  return idx === -1 ? 0 : idx;
}
