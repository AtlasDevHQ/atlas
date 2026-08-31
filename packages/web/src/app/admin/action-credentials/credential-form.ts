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
// the admin-schemas convention; `source` and `state` are closed sets the UI
// branches on, so they stay `z.enum` and a new member fails loudly here rather
// than rendering as a blank chip.

export const FIELD_SOURCES = ["workspace", "env", "unset"] as const;
export type FieldSource = (typeof FIELD_SOURCES)[number];

/**
 * The target's single configuration state (#5564) — see `ActionTargetState`
 * in `credentials/resolver.ts` for what each one means and why there is one
 * discriminant rather than the `configured` + `resolvedFrom` pair this
 * replaced.
 *
 * The two partial states are the reason it exists: under ADR-0046's
 * all-or-nothing rung rule a stored row that misses a required field shadows
 * the environment rung instead of being topped up by it, and the old shape
 * reported that byte-identically to having no row at all.
 */
export const TARGET_STATES = [
  "unconfigured",
  "workspace",
  "env",
  "partial-row",
  "partial-row-shadowing-env",
] as const;
export type TargetState = (typeof TARGET_STATES)[number];

export const FieldStatusSchema = z.object({
  envVar: z.string(),
  label: z.string(),
  hint: z.string(),
  secret: z.boolean(),
  required: z.boolean(),
  multiline: z.boolean(),
  present: z.boolean(),
  source: z.enum(FIELD_SOURCES),
  /**
   * True ⇒ the workspace's stored row holds this field, whichever rung wins.
   * In either partial state nothing resolves, so `source` reads `unset` for
   * every field — this is what still says which of them the row actually has,
   * and it is why the form can tell an admin to type one missing field rather
   * than all four.
   */
  stored: z.boolean(),
});

export const TargetStatusSchema = z.object({
  target: z.string(),
  label: z.string(),
  state: z.enum(TARGET_STATES),
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

/**
 * The PUT body shape — `fields` always, `clearFields` only when non-empty.
 * A `type` rather than an `interface` so it satisfies the mutation hook's
 * `Record<string, unknown>` body parameter directly, with no widening spread
 * at the call site.
 */
export type UpdatePayload = {
  fields: Record<string, string>;
  clearFields?: string[];
};

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

/**
 * The badge text for one field.
 *
 * `SOURCE_LABEL[field.source]` alone is wrong in the two partial states: the
 * row is not resolving, so a field it holds reports `unset` and would read
 * "Not set" — flatly untrue to the admin who typed it, and the reading that
 * would send them hunting for a value that is already there. "Saved (not in
 * use)" says both halves: it is stored, and it is not what executes (#5564).
 */
export function fieldSourceLabel(field: FieldStatus): string {
  if (field.source === "unset" && field.stored) return "Saved (not in use)";
  return SOURCE_LABEL[field.source];
}

/**
 * Required fields the target has neither resolved nor stored — what the admin
 * still has to type.
 *
 * `stored` is in the test, not just `present`, because of the partial states:
 * there nothing resolves, so `present` is false for every field including the
 * ones the row holds. Listing those as "still needed" would tell an admin to
 * re-enter a secret they cannot read back (#5564).
 */
export function missingRequiredFields(target: TargetStatus): FieldStatus[] {
  return target.fields.filter((f) => f.required && !f.present && !f.stored);
}

export type StatusTone = "configured" | "environment" | "partial" | "unconfigured";

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
 * One branch per {@link TargetState}, which is the reason the API sends a
 * discriminant rather than a `configured` flag: the three failing states read
 * identically under the old shape and need three different sentences.
 *
 * The `environment` tone is deliberately distinct from `configured` rather than
 * folded into it. Acceptance criterion 3 of #5553: on a self-hosted deploy an
 * operator who has set `JIRA_*` in the environment sees a target that works
 * with no row in this page's table, and without naming that rung the page reads
 * as a bug. On SaaS the rung does not exist at all (ADR-0046 — no operator
 * tier), so neither the environment nor the shadowing copy can be reached
 * there, and the unconfigured copy never mentions environment variables.
 */
export function summarizeTarget(target: TargetStatus, deployMode: DeployMode): TargetSummary {
  const missing = missingRequiredFields(target)
    .map((f) => f.label)
    .join(", ");
  const blocked = missing.length > 0 ? ` Still needed: ${missing}.` : "";

  switch (target.state) {
    case "workspace":
      return {
        tone: "configured",
        label: "Configured",
        detail: `${target.label} actions run with the credentials saved here for this workspace.`,
      };
    case "env":
      return {
        tone: "environment",
        label: "From environment",
        detail: `No credentials are saved for this workspace, so ${target.label} actions fall back to this deployment's environment variables. Saving credentials here overrides that for this workspace.`,
      };
    // The state this page exists to make visible. An admin looking at it has a
    // stored entry that is actively suppressing a working environment rung —
    // the target USED to run and now throws — and under the old response shape
    // it was indistinguishable from having configured nothing at all.
    case "partial-row-shadowing-env":
      return {
        tone: "partial",
        label: "Incomplete — blocking environment",
        detail: `The credentials saved here for ${target.label} are incomplete, and an incomplete entry stops the environment fallback rather than topping it up — so ${target.label} actions are failing even though this deployment's environment variables would answer for them. Complete the entry, or remove it to fall back to the environment.${blocked}`,
      };
    case "partial-row":
      return {
        tone: "partial",
        label: "Incomplete",
        detail: `The credentials saved here for ${target.label} are incomplete, so ${target.label} actions fail. Credentials saved here are all-or-nothing — complete every required field, or remove the entry.${blocked}`,
      };
    case "unconfigured":
      return {
        tone: "unconfigured",
        label: "Not configured",
        detail:
          deployMode === "self-hosted"
            ? `${target.label} actions will fail until every required field resolves — either saved here, or set as environment variables on this deployment. Credentials saved here are all-or-nothing: a partly-filled entry stops the environment fallback rather than topping it up.${blocked}`
            : `${target.label} actions will fail until every required field is saved here.${blocked}`,
      };
  }
}

/**
 * Placeholder text for a field's input.
 *
 * A field saved for the workspace gets "leave blank to keep" — the one moment
 * the write-only contract is load-bearing, since the admin cannot read the
 * value back to retype it.
 *
 * An env-sourced field deliberately does NOT say that. Under the all-or-nothing
 * rung rule (ADR-0046) leaving it blank keeps using the environment only while
 * NOTHING is saved for this workspace; the moment a sibling field is saved, the
 * new workspace row shadows the environment entirely and this field reads as
 * missing. Telling the admin "leave blank to keep using it" would be an
 * instruction to create exactly the partial row that makes the target throw.
 */
export function fieldPlaceholder(field: FieldStatus): string {
  // `stored`, not `source === "workspace"`: in a partial state the row is not
  // resolving, but a field it holds is still there and still unreadable, so
  // "leave blank to keep" is exactly the right instruction (#5564).
  if (field.stored) return "Saved — leave blank to keep";
  if (field.source === "env") return "Currently from the environment — enter a value to save it here";
  return field.required ? "Required" : "Optional";
}

/**
 * Whether this workspace HAS a stored row for the target — i.e. whether there
 * is anything a "remove" could act on.
 *
 * Three of the five states are exactly the ones a row produces, so this is a
 * projection of the discriminant, not an inference over an absence. It
 * replaced `mayHaveStoredRow`, which could only ask the question backwards:
 * the old response said `resolvedFrom: "env"` solely when no row existed, so
 * that one value proved a row was absent and every other value merely allowed
 * one. Removal was offered on the "might" — sound, but it meant the page
 * offered a destructive action without being able to say whether it would do
 * anything, and could not distinguish the state ADR-0046 warns about (#5564).
 *
 * A partial row still keeps removal offered, and that is the case that matters:
 * it is the only escape hatch from an entry that shadows the environment rung.
 */
export function hasStoredRow(target: TargetStatus): boolean {
  return (
    target.state === "workspace" ||
    target.state === "partial-row" ||
    target.state === "partial-row-shadowing-env"
  );
}

/**
 * Required fields that would NOT resolve if this draft were saved as-is.
 *
 * The all-or-nothing rung rule makes a partial save actively harmful rather
 * than merely incomplete: the workspace row it creates stops the environment
 * fallback instead of topping it up, so an admin who saves one field of a
 * target that was working from `process.env` breaks it. The API now REJECTS
 * such a save with a 400 (#5564); this is the same predicate one step earlier,
 * so the form can gate its own Save button rather than teaching the admin the
 * rule through a failed request.
 *
 * A field survives the save if the admin typed a value, or if it is already
 * stored for the workspace and not being removed. An env-sourced value does
 * NOT count: it lives in the environment, not in the row being written.
 *
 * ⚠️ The membership test is `stored`, NOT `source === "workspace"`. Those agree
 * everywhere except the two partial states, and disagreeing there was the bug:
 * a partial row reports every field `unset`, so the old test called a stored
 * field unsatisfied. That was tolerable when it only over-warned, and is not
 * now that it gates Save — the one way a partial row is still reachable is a
 * target's field spec gaining a required field after rows are stored, and in
 * exactly that case the admin needs to save the ONE new field over the row
 * they already have. Testing `source` would disable the button that fixes it.
 */
export function requiredFieldsUnsatisfied(
  target: TargetStatus,
  draft: TargetDraft,
): FieldStatus[] {
  const cleared = new Set(draft.cleared);
  return target.fields.filter((field) => {
    if (!field.required) return false;
    if (cleared.has(field.envVar)) return true;
    if ((draft.values[field.envVar] ?? "").trim().length > 0) return false;
    return !field.stored;
  });
}
