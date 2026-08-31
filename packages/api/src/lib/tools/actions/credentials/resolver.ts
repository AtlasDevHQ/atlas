/**
 * Action-target credential resolution (#3766) — the single place the action
 * credential precedence ladder is decided:
 *
 *     workspace row  →  process.env (SELF-HOSTED ONLY)  →  throw
 *
 * There is no operator rung, deliberately. Per the maintainer decision
 * recorded on #3766 (2026-08-30), an operator-configured shared Jira serving
 * several tenants is exactly the multi-tenant confusion this seam exists to
 * eliminate, so the middle tier the chat-platform seam has
 * (`integrations/operator-credentials/resolver.ts`) is NOT mirrored here.
 * On SaaS the env rung is absent entirely — a workspace with no row throws.
 *
 * ── The all-or-nothing rule ──────────────────────────────────────────────
 *
 * A resolved credential set comes from EXACTLY ONE rung. The rungs are never
 * merged field-by-field, and that asymmetry with the operator resolver (which
 * DOES overlay per field) is the whole safety property:
 *
 *   A tenant fills in their own JIRA_BASE_URL and JIRA_EMAIL but leaves
 *   JIRA_API_TOKEN blank. Under per-field precedence the blank token would
 *   fall through to the operator's env token, and the tenant's ticket would
 *   be created against their Jira site using ATLAS'S credential — or, with
 *   the base URL blank instead, against ATLAS'S Jira. That is the
 *   Direction-1 leak of #2850, one tier down.
 *
 * So a workspace row is used only when it satisfies EVERY required field of
 * the target; a partial row is a misconfiguration that throws, and never
 * silently degrades to env. `resolvedFrom` on the result records which rung
 * won so structured logs can attribute a dispatch to its credential source.
 *
 * Isolation: this resolver never reads the operator-tier store, and the
 * operator resolver never reads this one. Structural (no shared table, no
 * shared module) and pinned by `__tests__/action-credential-isolation.test.ts`.
 *
 * @see ADR-0046 — per-workspace action credentials
 * @see ./targets.ts — the one-entry-per-target registry this iterates
 */

import type { DeployMode } from "@useatlas/types";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import { getConfig } from "@atlas/api/lib/config";
import { resolveDeployMode } from "@atlas/api/lib/effect/deploy-mode";
import { createLogger } from "@atlas/api/lib/logger";
import { readActionCredentials } from "./store";
import type { ActionCredentialBundle } from "./store";
import {
  getActionTarget,
  type ActionCredentialsOf,
  type ActionTargetSpec,
} from "./targets";

const log = createLogger("actions.credentials.resolver");

/** Which rung of the ladder produced a resolved credential set. */
export type ActionCredentialSource = "workspace" | "env";

/**
 * A resolved, complete credential set for one action target.
 *
 * `values` is keyed by env-var name (`JIRA_BASE_URL`, …) so a target's field
 * spec reads both rungs with no per-target mapping. Every REQUIRED field of
 * the target is guaranteed present and non-empty; optional fields may be
 * absent.
 */
export interface ResolvedActionCredentials {
  readonly target: string;
  readonly values: Readonly<Record<string, string>>;
  /** The single rung these values came from. Never a mix — see the module doc. */
  readonly resolvedFrom: ActionCredentialSource;
}

/**
 * Actionable failure — the message names the workspace Admin surface (and, on
 * self-hosted, the env vars) so the fix is one step. Never carries a
 * credential value.
 *
 * `reason` lets callers distinguish the cases without string-matching:
 *   - `"unmanaged-target"` — no {@link ActionTargetSpec} claims this target.
 *   - `"no-workspace"` — the action carries no owning workspace, so no
 *     per-workspace row can be looked up.
 *   - `"unconfigured"` — no rung satisfied every required field.
 *   - `"partial-workspace-row"` — a row exists but is missing required
 *     fields. Called out separately because it is the case that MUST NOT
 *     degrade to env, and a distinct reason keeps that visible in logs.
 */
export type ActionCredentialErrorReason =
  | "unmanaged-target"
  | "no-workspace"
  | "unconfigured"
  | "partial-workspace-row";

export class ActionCredentialError extends Error {
  override readonly name = "ActionCredentialError";
  readonly target: string;
  readonly reason: ActionCredentialErrorReason;
  constructor(
    message: string,
    details: { target: string; reason: ActionCredentialErrorReason },
  ) {
    super(message);
    this.target = details.target;
    this.reason = details.reason;
  }
}

/**
 * The deploy mode the action-credential ladder runs under.
 *
 * Prefers the RESOLVED mode off the loaded config, because that is where a
 * hosted region declares it: `deploy/api/atlas.config.ts` sets
 * `deployMode: "saas"` and sets no `ATLAS_DEPLOY_MODE` env var at all (#3702).
 * Reading raw env would therefore not read the operator's declaration on prod —
 * it would re-derive the mode from the `auto` heuristic
 * (`isEnterpriseEnabled() && hasInternalDB()`), and any drift in that heuristic
 * resolves a SaaS region to `self-hosted`, which is precisely the rung that
 * opens `process.env.JIRA_*`. `startup.ts` reads the resolved mode for the same
 * reason.
 *
 * The `resolveDeployMode()` arm covers only the case where config is not loaded
 * — unreachable on a live request path, since the app cannot serve one before
 * boot. It is there so an unloaded config falls through to env-based resolution
 * rather than silently assuming `self-hosted` and opening the env rung.
 *
 * Shared by the action exec path and the Admin route so the two can never
 * disagree about which rungs exist for a given deployment.
 */
export function resolveActionDeployMode(): DeployMode {
  const configured = getConfig()?.deployMode;
  if (configured === "saas") return "saas";
  if (configured === "self-hosted") return "self-hosted";
  return resolveDeployMode();
}

export interface ResolveActionCredentialsOptions {
  /**
   * The workspace the ACTION belongs to — `action_log.org_id`, stamped at
   * request time. Not the approver's active workspace: an action is approved
   * in a separate request, and resolving against the approver's context would
   * let approval decide whose credentials fire. `null` when the action carries
   * no workspace (self-host with auth off, or a legacy row).
   */
  readonly workspaceId: string | null | undefined;
  /**
   * Resolved deploy mode. Gates the env rung: `"self-hosted"` may fall back to
   * `process.env`, `"saas"` may not. Passed in rather than resolved here so
   * callers that already know it don't re-derive it, and so tests can pin both
   * modes without touching global state.
   */
  readonly deployMode: DeployMode;
  /** Process env to read the self-host rung from. Tests pass a fresh object. */
  readonly env?: NodeJS.ProcessEnv;
}

/** Non-empty string values from `bundle` for the spec's declared fields only. */
function projectDeclaredFields(
  spec: ActionTargetSpec,
  read: (key: string) => string | undefined,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of spec.fields) {
    const value = read(field.envVar);
    if (typeof value === "string" && value.length > 0) values[field.envVar] = value;
  }
  return values;
}

/** Required field names of `spec` absent from `values`. */
function missingRequired(
  spec: ActionTargetSpec,
  values: Record<string, string>,
): string[] {
  return spec.fields
    .filter((f) => f.required && !values[f.envVar])
    .map((f) => f.envVar);
}

/**
 * Required field names of `spec` that `read` does not answer with a non-empty
 * value — the completeness question, asked once, for every caller.
 *
 * Composes {@link projectDeclaredFields} with {@link missingRequired} rather
 * than exporting the predicate alone, because a caller outside this module
 * that asked only the predicate would be asking half the question: the
 * projection is what drops empty strings and keys the spec does not declare.
 * A `""` skipped there reads as "present" to the predicate while the resolver
 * counts it missing at execution time — the two disagreeing is exactly the
 * drift this seam exists to make impossible.
 *
 * The WRITE path is the caller this exists for (#5564). Until then nothing on
 * the write path asked the question at all, so a half-filled save persisted a
 * row that shadows the env rung and makes the target throw — the
 * all-or-nothing rule's own failure mode, reachable straight through the Admin
 * form. `admin-action-credentials.ts` now asks it of the exact merged bundle
 * it is about to persist.
 */
export function unsatisfiedRequiredFields(
  spec: ActionTargetSpec,
  read: (key: string) => string | undefined,
): string[] {
  return missingRequired(spec, projectDeclaredFields(spec, read));
}

function unconfiguredMessage(spec: ActionTargetSpec, deployMode: DeployMode): string {
  if (deployMode === "saas") {
    return (
      `${spec.label} is not configured for this workspace. ` +
      `A workspace admin can set it via the workspace action-credential settings ` +
      `(PUT /api/v1/admin/action-credentials/${spec.target}). ` +
      `Action targets are per-workspace only — Atlas has no shared ${spec.label} to fall back to.`
    );
  }
  const envVars = spec.fields.filter((f) => f.required).map((f) => f.envVar).join(", ");
  return (
    `${spec.label} is not configured. ` +
    `Set this workspace's credentials via PUT /api/v1/admin/action-credentials/${spec.target}, ` +
    `or set ${envVars} in the environment.`
  );
}

/**
 * Resolve the credentials an action target should execute with.
 *
 * Precedence, all-or-nothing per rung (see the module doc):
 *   1. Workspace row satisfying every required field → `source: "workspace"`.
 *   2. A workspace row that exists but is INCOMPLETE → throw. Never degrades
 *      to env: that would fire a tenant's action on operator credentials.
 *   3. No row, `deployMode === "self-hosted"`, env satisfies every required
 *      field → `source: "env"`.
 *   4. Otherwise → throw {@link ActionCredentialError}.
 *
 * A store read failure (transport, decrypt) PROPAGATES rather than being
 * swallowed into the env rung — a decrypt failure that degraded to env would
 * silently re-route a tenant's action at the operator's target.
 *
 * @throws {@link ActionCredentialError} when no rung yields a complete set.
 */
export async function resolveActionCredentials(
  target: string,
  options: ResolveActionCredentialsOptions,
): Promise<ResolvedActionCredentials> {
  const spec = getActionTarget(target);
  if (!spec) {
    throw new ActionCredentialError(
      `No credential spec is registered for action target "${target}".`,
      { target, reason: "unmanaged-target" },
    );
  }

  const { workspaceId, deployMode } = options;
  const env = options.env ?? process.env;

  // ── Rung 1: the workspace's own row ──────────────────────────────────
  if (workspaceId && hasInternalDB()) {
    const bundle: ActionCredentialBundle | null = await readActionCredentials(
      workspaceId,
      spec.target,
    );
    if (bundle) {
      const values = projectDeclaredFields(spec, (key) => bundle[key]);
      const missing = missingRequired(spec, values);
      if (missing.length === 0) {
        return { target: spec.target, values, resolvedFrom: "workspace" };
      }
      // A row exists but is incomplete. This is the case that must NOT fall
      // through to env — see the all-or-nothing rule in the module doc.
      log.warn(
        { workspaceId, target: spec.target, missing },
        "Workspace action credentials are incomplete — refusing to fall back to operator env",
      );
      throw new ActionCredentialError(
        `${spec.label} credentials for this workspace are incomplete — missing ${missing.join(", ")}. ` +
          `Complete them via PUT /api/v1/admin/action-credentials/${spec.target}. ` +
          `Atlas will not fill the gap from the deployment's environment.`,
        { target: spec.target, reason: "partial-workspace-row" },
      );
    }
  }

  // ── Rung 2: process.env, self-hosted only ────────────────────────────
  if (deployMode === "self-hosted") {
    const values = projectDeclaredFields(spec, (key) => env[key]);
    if (missingRequired(spec, values).length === 0) {
      return { target: spec.target, values, resolvedFrom: "env" };
    }
  }

  // ── Rung 3: nothing configured ───────────────────────────────────────
  if (!workspaceId && deployMode === "saas") {
    throw new ActionCredentialError(
      `${spec.label} credentials are per-workspace, but this action carries no workspace. ` +
        `Re-run it from an authenticated session with an active workspace.`,
      { target: spec.target, reason: "no-workspace" },
    );
  }
  throw new ActionCredentialError(unconfiguredMessage(spec, deployMode), {
    target: spec.target,
    reason: "unconfigured",
  });
}

/**
 * Resolve a target's credentials for an action execution context, typed by
 * the target's own spec. THE one place an action module crosses into the
 * credential seam — each used to carry its own copy of this function plus a
 * hand-written interface and a narrowing step whose failure arm the
 * all-or-nothing rule makes unreachable.
 *
 * The `as` below is that rule, stated once: {@link resolveActionCredentials}
 * returns only when every `required: true` field of `spec` is present and
 * non-empty (`missingRequired` reads the same spec this type derives from),
 * so the record IS an {@link ActionCredentialsOf} of `spec`. TypeScript
 * cannot carry a runtime guarantee across a `Record<string, string>`, which
 * is exactly why this assertion lives here, beside the guarantee, and
 * nowhere else.
 */
export async function resolveCredentialsFor<T extends ActionTargetSpec>(
  spec: T,
  ctx: { readonly workspaceId: string | null },
  overrides?: Partial<Omit<ResolveActionCredentialsOptions, "workspaceId">>,
): Promise<ActionCredentialsOf<T>> {
  const resolved = await resolveActionCredentials(spec.target, {
    workspaceId: ctx.workspaceId,
    deployMode: overrides?.deployMode ?? resolveActionDeployMode(),
    ...(overrides?.env ? { env: overrides.env } : {}),
  });
  log.info(
    { workspaceId: ctx.workspaceId, target: spec.target, resolvedFrom: resolved.resolvedFrom },
    "Resolved action credentials",
  );
  return resolved.values as ActionCredentialsOf<T>;
}

/**
 * Per-field configuration status for one target in one workspace. Presence +
 * source only — never a secret value. Backs the workspace Admin GET.
 */
export interface ActionTargetFieldStatus {
  readonly envVar: string;
  readonly label: string;
  readonly hint: string;
  readonly secret: boolean;
  readonly required: boolean;
  /** Mirrors the spec — the Admin form renders a textarea (#5555). */
  readonly multiline: boolean;
  readonly present: boolean;
  /** `"unset"` when neither the workspace row nor the (self-host) env has it. */
  readonly source: ActionCredentialSource | "unset";
  /**
   * True when THIS WORKSPACE'S ROW carries a non-empty value for this field —
   * independently of which rung wins.
   *
   * `present` / `source` answer "what would execute". In either partial state
   * nothing executes, so every field there reads `unset` even when the row
   * holds it. That is right for `present` and useless for the one question the
   * Admin form must answer before a save: which required fields does the admin
   * still have to type? Without this the form could only assume "all of them",
   * and would block a save that completes a partial row (#5564).
   *
   * Presence only, never a value — the same contract `present` carries, and it
   * discloses nothing that `source: "workspace"` does not already disclose on
   * the winning path.
   *
   * Yes, this is a third boolean-ish member beside `present` and `source`, and
   * no, the field triple is not a discriminant the way {@link ActionTargetState}
   * is. Worth being precise about what is and is not representable here:
   * `present` is already exactly `source !== "unset"` — a redundancy that
   * predates this field — and `stored` cannot contradict them, because when the
   * workspace rung wins the winning values ARE the row's, so `present` implies
   * `stored`. Collapsing the triple would reshape the per-field read-back
   * contract, which #5564 puts out of scope; it is a fair follow-up, not a
   * thing to smuggle into this change.
   */
  readonly stored: boolean;
}

/**
 * What a target's credentials are, for one workspace — ONE discriminant over
 * the five situations that are actually reachable (#5564).
 *
 * This replaced a `configured: boolean` + `resolvedFrom: rung | null` pair.
 * Two fields span four combinations for what were three describable states,
 * and neither could name the two that matter most: a workspace row that EXISTS
 * but misses a required field reported `configured: false, resolvedFrom: null`,
 * byte-identical to having no row at all. Under the all-or-nothing rung rule
 * those are opposite situations — the second is fine, the first shadows the env
 * rung and makes the target throw — and no consumer could tell them apart.
 *
 * One discriminant makes the illegal combinations unrepresentable rather than
 * merely undocumented, which is the same call PR #5561 made when it declined a
 * `kind` discriminant alongside `secret` on the field spec.
 *
 * - `unconfigured` — no workspace row; the env rung is absent or incomplete.
 * - `workspace` — a complete workspace row resolves.
 * - `env` — no workspace row, and a complete env rung resolves. Self-hosted
 *   only; on SaaS the rung does not exist (ADR-0046).
 * - `partial-row` — a workspace row exists and misses a required field.
 *   Nothing is being shadowed, so the target was not working before either.
 * - `partial-row-shadowing-env` — the same incomplete row, but the env rung IS
 *   complete. This is the damaging one: execution throws, and a target that
 *   was working from the deployment's environment is now broken by the row.
 *   Self-hosted only, for the same reason `env` is.
 *
 * With the write path rejecting incomplete saves (#5564), an admin can no
 * longer CREATE either partial state through the Admin form. They stay
 * reachable by exactly one path — a target's field spec gaining a required
 * field after rows are stored, which turns every stored row for that target
 * partial at once. `ACTION_TARGETS` is live code that gained three entries in
 * a week, so that path is real, and it is the one the tests pin.
 */
export type ActionTargetState =
  | "unconfigured"
  | "workspace"
  | "env"
  | "partial-row"
  | "partial-row-shadowing-env";

export interface ActionTargetStatus {
  readonly target: string;
  readonly label: string;
  /** The one discriminant — see {@link ActionTargetState}. */
  readonly state: ActionTargetState;
  readonly fields: readonly ActionTargetFieldStatus[];
}

/**
 * Masked status of one action target for one workspace, for the Admin surface
 * and diagnostics. Never returns secret values.
 *
 * Takes the same `(target, options)` shape as {@link resolveActionCredentials}
 * deliberately — the two answer the same question (which rung wins for this
 * workspace) and differ only in whether they return the values or just their
 * presence, so a caller can swap one for the other without re-ordering args.
 *
 * Field `source` reflects the SAME all-or-nothing rule the resolver applies:
 * when the workspace row wins, env-only fields read `"unset"` rather than
 * `"env"`, because at execution time they would not be consulted. Reporting
 * them as `"env"` would tell a workspace admin their target is configured out
 * of a rung the resolver will never reach.
 *
 * {@link ActionTargetState} is the one thing this returns that the resolver
 * does not: it separates "no row" from "an incomplete row", and separates an
 * incomplete row that is shadowing a working env rung from one that is not.
 * Per-field `stored` carries the same separation one level down.
 */
export async function getActionTargetStatus(
  target: string,
  options: ResolveActionCredentialsOptions,
): Promise<ActionTargetStatus | null> {
  const { workspaceId, deployMode } = options;
  const env = options.env ?? process.env;
  const spec = getActionTarget(target);
  if (!spec) return null;

  const bundle =
    workspaceId && hasInternalDB()
      ? await readActionCredentials(workspaceId, spec.target)
      : null;

  const workspaceValues = bundle
    ? projectDeclaredFields(spec, (key) => bundle[key])
    : {};
  const workspaceComplete =
    bundle !== null && missingRequired(spec, workspaceValues).length === 0;

  const envValues =
    deployMode === "self-hosted" ? projectDeclaredFields(spec, (key) => env[key]) : {};
  const envComplete =
    deployMode === "self-hosted" && missingRequired(spec, envValues).length === 0;

  // Mirror the resolver: a complete workspace row wins outright; otherwise the
  // env rung is consulted only when no row exists at all AND it is itself
  // complete. An INCOMPLETE workspace row shadows env (the resolver throws
  // rather than degrading), so it never reports as env-configured here either.
  //
  // The one thing this ladder says that the resolver's cannot: whether the
  // shadowed env rung was COMPLETE. The resolver throws either way, so the
  // distinction is invisible to it — but to an admin it is the difference
  // between "this target never worked" and "my half-finished entry broke a
  // target that was working", which is the whole reason the status API exists.
  const state: ActionTargetState = workspaceComplete
    ? "workspace"
    : bundle !== null
      ? envComplete
        ? "partial-row-shadowing-env"
        : "partial-row"
      : envComplete
        ? "env"
        : "unconfigured";

  const winner: ActionCredentialSource | null =
    state === "workspace" ? "workspace" : state === "env" ? "env" : null;

  const winningValues =
    winner === "workspace" ? workspaceValues : winner === "env" ? envValues : {};

  const fields = spec.fields.map<ActionTargetFieldStatus>((field) => {
    const present = Boolean(winningValues[field.envVar]);
    return {
      envVar: field.envVar,
      label: field.label,
      hint: field.hint,
      secret: field.secret,
      required: field.required,
      // Normalized to a boolean here so every consumer reads one shape; the
      // spec leaves it optional so an ordinary single-line field says nothing.
      multiline: field.multiline === true,
      present,
      source: present && winner ? winner : "unset",
      // Read off the ROW, not the winner — see the field's docblock. In the
      // `workspace` state this equals `present`; in the two partial states it
      // is the only thing that still tells the truth about the row.
      stored: Boolean(workspaceValues[field.envVar]),
    };
  });

  return {
    target: spec.target,
    label: spec.label,
    state,
    fields,
  };
}
