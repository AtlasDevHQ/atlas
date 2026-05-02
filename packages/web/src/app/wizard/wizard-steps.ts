export const WIZARD_STEPS = [
  { id: "datasource", label: "Datasource" },
  { id: "tables", label: "Tables" },
  { id: "review", label: "Review" },
  { id: "done", label: "Done" },
] as const satisfies readonly { readonly id: string; readonly label: string }[];

export type WizardStepId = (typeof WIZARD_STEPS)[number]["id"];

/**
 * Resolve a 1-based step number from the URL into a typed step id. Throws on
 * out-of-range so a caller that forgot to clamp surfaces the bug fast.
 */
export function wizardStepIdForNum(num: number): WizardStepId {
  const step = WIZARD_STEPS[num - 1];
  if (!step) {
    throw new Error(
      `wizardStepIdForNum: step ${num} out of range (1..${WIZARD_STEPS.length})`,
    );
  }
  return step.id;
}
