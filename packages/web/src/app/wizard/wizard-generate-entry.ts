/**
 * Shared entry-point helpers for the semantic-layer generate flow (issue #3237,
 * docs/design/semantic-onboarding.md § E).
 *
 * There is exactly **one** generate flow — the wizard's table-pick → two-phase
 * review → save (#3236). The onboarding wizard, the inline-on-add prompt in
 * `/admin/connections`, and the empty state in `/admin/semantic` are all just
 * *doors* into it. Centralizing the deep-link here is what makes "one flow,
 * many doors" true by construction: every door builds its href the same way,
 * so they can't drift into separate flows.
 *
 * Deliberately UI- and fetch-free so the routing/selection logic is unit-
 * testable without a React render.
 */

import type { ConnectionInfo } from "@/ui/lib/types";
import { DEMO_CONNECTION_ID } from "../admin/connections/columns";
import { WIZARD_STEPS } from "./wizard-steps";

/** Wizard step number (1-based) for the table picker. Deep-linking past the
 * datasource picker (step 1) skips a redundant "which connection?" prompt when
 * the caller already knows the connection. Derived from `WIZARD_STEPS` rather
 * than hardcoded so inserting/reordering a step can't silently point the
 * deep-link at the wrong screen. */
const WIZARD_TABLES_STEP = WIZARD_STEPS.findIndex((s) => s.id === "tables") + 1;

/**
 * Build the deep-link into the shared generate flow.
 *
 * With a `connectionId` we jump straight to the table picker (step 2) for that
 * connection — the `/wizard/generate` + `/wizard/save` routes resolve the
 * connection's Connection group server-side (#3234), so the generated entities
 * land in the right group regardless of which door launched the flow.
 *
 * With no connection we route to the wizard's datasource picker (step 1) and
 * let the user choose.
 */
export function wizardGenerateHref(connectionId?: string | null): string {
  if (connectionId) {
    return `/wizard?connectionId=${encodeURIComponent(connectionId)}&step=${WIZARD_TABLES_STEP}`;
  }
  return "/wizard";
}

/**
 * Pick a connection to pre-select when launching the generate flow from the
 * `/admin/semantic` empty state (door 2). With exactly one real connection we
 * deep-link straight to its table picker; with zero or many we return `null`
 * so the caller routes to the datasource picker and lets the user choose.
 *
 * The demo connection is excluded — generating against the shared demo dataset
 * isn't the onboarding intent, and on a demo-only workspace there's nothing of
 * the user's own to scope to.
 */
export function generateLaunchConnectionId(
  connections: readonly ConnectionInfo[],
): string | null {
  const real = connections.filter((c) => c.id !== DEMO_CONNECTION_ID);
  return real.length === 1 ? real[0].id : null;
}
