/**
 * Plan intent carried from the marketing pricing page into the app (#3418).
 *
 * /pricing CTAs link to `/signup?plan=starter|pro|business`. The signup
 * flow spans five hard-navigated steps (account → workspace → region →
 * connect → success) plus optional OAuth round-trips, so threading the
 * query param through every hop is brittle — instead the signup page
 * stashes the intent here and the billing plan picker consumes it to
 * preselect the card. localStorage (not zustand) because the value must
 * survive `window.location.assign` hard navs and OAuth redirects.
 *
 * Best-effort by design: a user who lands on a different device simply
 * sees no preselection. Intent expires after 7 days so a stale choice
 * from an abandoned signup doesn't resurface weeks later.
 */

const STORAGE_KEY = "atlas.plan-intent";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const PAID_TIERS = ["starter", "pro", "business"] as const;
export type PlanIntent = (typeof PAID_TIERS)[number];

export function isPlanIntent(value: string | null | undefined): value is PlanIntent {
  return value != null && (PAID_TIERS as readonly string[]).includes(value);
}

export function savePlanIntent(plan: string | null | undefined): void {
  if (typeof window === "undefined" || !isPlanIntent(plan)) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ plan, savedAt: Date.now() }));
  } catch (err) {
    // Private-mode / quota failures only cost the preselection nicety.
    console.debug("plan-intent: save skipped", err instanceof Error ? err.message : String(err));
  }
}

/** Read AND clear the stored intent (one-shot consumption). */
export function consumePlanIntent(): PlanIntent | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    window.localStorage.removeItem(STORAGE_KEY);
    const parsed = JSON.parse(raw) as { plan?: unknown; savedAt?: unknown };
    if (!isPlanIntent(typeof parsed.plan === "string" ? parsed.plan : null)) return null;
    if (typeof parsed.savedAt !== "number" || Date.now() - parsed.savedAt > MAX_AGE_MS) return null;
    return parsed.plan as PlanIntent;
  } catch (err) {
    console.debug("plan-intent: read skipped", err instanceof Error ? err.message : String(err));
    return null;
  }
}
