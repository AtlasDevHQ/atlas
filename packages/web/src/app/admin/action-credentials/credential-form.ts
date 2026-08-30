/**
 * Wire shapes and pure form logic for `/admin/action-credentials` (#5553).
 *
 * Everything here is a pure function over the status the API returns, so the
 * page component stays a renderer. That split is what lets the payload rules
 * — the ones the PUT contract cares about — be tested without a DOM.
 *
 * THE GENERICITY RULE. `ACTION_TARGETS` is the seam (#3766): the resolver,
 * the store and the route all iterate the registry with no per-target
 * branches, and this page must not be the one place that breaks it. So there
 * is no target slug anywhere in this module or in `page.tsx` — a new target
 * (Linear, GitHub App, Salesforce) renders because the server sends its field
 * specs, not because the UI learned its name. `__tests__/credential-form.test.ts`
 * and `__tests__/generic-rendering.test.tsx` pin that with a synthetic target
 * the code has never seen.
 *
 * @see ADR-0046 — per-workspace action credentials
 * @see packages/api/src/api/routes/admin-action-credentials.ts — the API consumed
 */

import { z } from "zod";

// ── Wire shapes ───────────────────────────────────────────────────
// Mirrors the response schemas in `admin-action-credentials.ts`. Enums that
// the API may extend independently of the web bundle stay `z.string()` per
// the admin-schemas convention; `source` and `resolvedFrom` are closed sets
// the UI branches on, so they stay `z.enum` and a new member fails loudly
// here rather than rendering as a blank chip.

export const FIELD_SOURCES = ["workspace", "env", "unset"] as const;
export type FieldSource = (typeof FIELD_SOURCES)[number];

export const FieldStatusSchema = z.object({
  envVar: z.string(),
  label: z.string(),
  hint: z.string(),
  secret: z.boolean(),
  required: z.boolean(),
  present: z.boolean(),
  source: z.enum(FIELD_SOURCES),
});

export const TargetStatusSchema = z.object({
  target: z.string(),
  label: z.string(),
  configured: z.boolean(),
  resolvedFrom: z.enum(["workspace", "env"]).nullable(),
  fields: z.array(FieldStatusSchema),
});

export const ActionCredentialsResponseSchema = z.object({
  deployMode: z.enum(["saas", "self-hosted"]),
  targets: z.array(TargetStatusSchema),
});

export type FieldStatus = z.infer<typeof FieldStatusSchema>;
export type TargetStatus = z.infer<typeof TargetStatusSchema>;
export type ActionCredentialsResponse = z.infer<typeof ActionCredentialsResponseSchema>;
export type DeployMode = ActionCredentialsResponse["deployMode"];

// ── Draft state ───────────────────────────────────────────────────

/**
 * The admin's in-progress edits for one target: typed values keyed by env-var
 * name, plus the set of fields marked for removal.
 *
 * Values always start EMPTY and re-baseline to empty after every save. That is
 * not a shortcut — it is the write-only contract made visible. The server never
 * echoes a stored value back (secret or not), so there is nothing to prefill
 * with, and "dirty" here means "the admin typed something new since the last
 * load" rather than "differs from the stored value", which the client cannot
 * know.
 */
export interface TargetDraft {
  readonly values: Readonly<Record<string, string>>;
  readonly cleared: readonly string[];
}

export const EMPTY_DRAFT: TargetDraft = { values: {}, cleared: [] };

/** The PUT body shape — `fields` always, `clearFields` only when non-empty. */
export interface UpdatePayload {
  fields: Record<string, string>;
  clearFields?: string[];
}

/**
 * Build the PUT body from a draft.
 *
 * Two rules, both mirroring the route:
 *
 *  - **Blank is not "clear".** A field the admin left empty is omitted, so the
 *    stored value survives. This is what makes a four-field form safe to
 *    re-submit after changing only the base URL: the API token the admin
 *    cannot see is preserved rather than blanked.
 *  - **A cleared field never also carries a value.** The route applies removals
 *    after the merge, so sending both would silently discard what was typed.
 *    Excluding it here keeps the payload's intent unambiguous rather than
 *    relying on that ordering; the UI disables the input to match.
 */
export function buildUpdatePayload(draft: TargetDraft): UpdatePayload {
  const cleared = new Set(draft.cleared);
  const fields: Record<string, string> = {};
  for (const [envVar, raw] of Object.entries(draft.values)) {
    if (cleared.has(envVar)) continue;
    const value = raw.trim();
    if (value.length > 0) fields[envVar] = value;
  }
  const clearFields = [...cleared];
  return clearFields.length > 0 ? { fields, clearFields } : { fields };
}

/**
 * Whether a draft carries anything worth sending. Gates the Save button so an
 * untouched form cannot fire a PUT that would rewrite the stored bundle to
 * itself and log a no-op admin-audit row.
 */
export function isDraftDirty(draft: TargetDraft): boolean {
  if (draft.cleared.length > 0) return true;
  return Object.values(draft.values).some((v) => v.trim().length > 0);
}

/** Toggle a field's "clear stored value" mark, returning a new draft. */
export function toggleCleared(draft: TargetDraft, envVar: string, clear: boolean): TargetDraft {
  const cleared = draft.cleared.filter((k) => k !== envVar);
  return {
    values: draft.values,
    cleared: clear ? [...cleared, envVar] : cleared,
  };
}

/** Set one field's typed value, returning a new draft. */
export function setValue(draft: TargetDraft, envVar: string, value: string): TargetDraft {
  return { values: { ...draft.values, [envVar]: value }, cleared: draft.cleared };
}

// ── Status copy ───────────────────────────────────────────────────

/** Human label for where a resolved field came from. */
export const SOURCE_LABEL: Record<FieldSource, string> = {
  workspace: "Workspace",
  env: "Environment",
  unset: "Not set",
};

/** Required fields that do not currently resolve — what blocks `configured`. */
export function missingRequiredFields(target: TargetStatus): FieldStatus[] {
  return target.fields.filter((f) => f.required && !f.present);
}

export type StatusTone = "configured" | "environment" | "unconfigured";

export interface TargetSummary {
  tone: StatusTone;
  /** Badge text. */
  label: string;
  /** One sentence under the badge explaining what happens at execution time. */
  detail: string;
}

/**
 * Summarize a target's status for the card header.
 *
 * The `environment` tone is deliberately distinct from `configured` rather than
 * folded into it. Acceptance criterion 3: on a self-hosted deploy an operator
 * who has set `JIRA_*` in the environment sees a target that works with no row
 * in this page's table, and without naming that rung the page reads as a bug.
 * On SaaS the rung does not exist at all (ADR-0046 — no operator tier), so the
 * unconfigured copy there never mentions environment variables.
 */
export function summarizeTarget(target: TargetStatus, deployMode: DeployMode): TargetSummary {
  if (target.resolvedFrom === "workspace") {
    return {
      tone: "configured",
      label: "Configured",
      detail: `${target.label} actions run with the credentials saved here for this workspace.`,
    };
  }
  if (target.resolvedFrom === "env") {
    return {
      tone: "environment",
      label: "From environment",
      detail: `No credentials are saved for this workspace, so ${target.label} actions fall back to this deployment's environment variables. Saving credentials here overrides that for this workspace.`,
    };
  }
  const missing = missingRequiredFields(target)
    .map((f) => f.label)
    .join(", ");
  const blocked = missing.length > 0 ? ` Still needed: ${missing}.` : "";
  return {
    tone: "unconfigured",
    label: "Not configured",
    detail:
      deployMode === "self-hosted"
        ? `${target.label} actions will fail until every required field resolves — either saved here, or set as environment variables on this deployment. Credentials saved here are all-or-nothing: a partly-filled entry stops the environment fallback rather than topping it up.${blocked}`
        : `${target.label} actions will fail until every required field is saved here.${blocked}`,
  };
}

/**
 * Placeholder text for a field's input.
 *
 * A field that currently resolves gets "leave blank to keep" rather than its
 * hint: it is the one moment the write-only contract is load-bearing, and the
 * hint is still shown below the input either way.
 */
export function fieldPlaceholder(field: FieldStatus): string {
  if (field.source === "workspace") return "Saved — leave blank to keep";
  if (field.source === "env") return "Set in the environment — leave blank to keep using it";
  return field.required ? "Required" : "Optional";
}
