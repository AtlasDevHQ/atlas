export const WIZARD_STEPS = [
  { id: "datasource", label: "Datasource", num: 1 },
  { id: "tables", label: "Tables", num: 2 },
  { id: "review", label: "Review", num: 3 },
  { id: "done", label: "Done", num: 4 },
] as const satisfies ReadonlyArray<{ id: string; label: string; num: number }>;

export type WizardStepId = (typeof WIZARD_STEPS)[number]["id"];

export function wizardStepIdForNum(num: number): WizardStepId {
  const step = WIZARD_STEPS.find((s) => s.num === num);
  return step ? step.id : "datasource";
}
