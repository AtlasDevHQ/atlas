/**
 * Categorizes a Better Auth `organization.create` failure into a user-facing
 * alert state.
 *
 * Branch precedence is load-bearing — three tiers, in order:
 *
 *   1. `partialActivation` short-circuits everything (the org *was* created;
 *      that's the user-actionable truth).
 *   2. A thrown exception is bucketed (TypeError → network, anything else →
 *      unknown carrying its message).
 *   3. The structured response is matched in tiers: HTTP `status` first
 *      (unambiguous server signal), then `code` (server-supplied string),
 *      then a fuzzy regex against `message` (last resort, for older Better
 *      Auth shapes and custom policy plugins). Each tier wins over the next
 *      so a 402 with "forbidden" in the body still routes to billing_required,
 *      and a 403 with `code: "SLUG_ALREADY_EXISTS"` still routes to
 *      permission_denied.
 */

export type CreateOrgErrorKind =
  | "slug_taken"
  | "permission_denied"
  | "billing_required"
  | "network"
  | "partial_activation"
  | "unknown";

/**
 * Discriminated by `kind` — payload-bearing variants get their own arm so
 * adding a kind-specific affordance (e.g. a `billing_required.upgradeUrl` or
 * a future `slug_taken.suggested`) doesn't widen the shape for other kinds.
 * The renderer narrows with `error.kind === "..."`; an exhaustive switch
 * gives a compile-time error when a new kind is added without a render path.
 */
export type CreateOrgErrorState =
  | {
      kind: "billing_required";
      title: string;
      body: string;
      /** Override for the upgrade CTA. Defaults to `/admin/billing`. */
      upgradeUrl?: string;
    }
  | {
      kind: "slug_taken";
      title: string;
      body: string;
      /** Server-suggested alternative slug, when available. */
      suggested?: string;
    }
  | {
      kind: "partial_activation" | "permission_denied" | "network" | "unknown";
      title: string;
      body: string;
    };

export interface CreateOrgResponseError {
  message?: string | null;
  code?: string | null;
  status?: number | null;
}

export interface CreateOrgErrorInput {
  error?: CreateOrgResponseError;
  thrown?: unknown;
  /**
   * True when create succeeded but the follow-up setActive call failed.
   * The boolean name doesn't carry that semantic, so it's worth spelling out.
   */
  partialActivation?: boolean;
}

const UNKNOWN_FALLBACK = {
  title: "Couldn't create workspace",
  body: "Something went wrong. Try again, or contact support if it keeps happening.",
} as const;

export function parseCreateOrgError(input: CreateOrgErrorInput): CreateOrgErrorState {
  if (input.partialActivation) {
    return {
      kind: "partial_activation",
      title: "Workspace created — please reload",
      body: "We created the workspace but couldn't switch you into it. Reload the page and pick it from the workspace switcher.",
    };
  }

  if (input.thrown !== undefined) {
    if (input.thrown instanceof TypeError) {
      return {
        kind: "network",
        title: "Can't reach the server",
        body: "Check your connection and try again. If this keeps happening, your workspace may be offline.",
      };
    }
    const message =
      input.thrown instanceof Error ? input.thrown.message : String(input.thrown);
    return {
      kind: "unknown",
      title: UNKNOWN_FALLBACK.title,
      body: message || UNKNOWN_FALLBACK.body,
    };
  }

  const err = input.error ?? {};
  const code = (err.code ?? "").toUpperCase();
  const message = err.message ?? "";
  const status = err.status ?? 0;

  const billing = (): CreateOrgErrorState => ({
    kind: "billing_required",
    title: "Workspace limit reached on your plan",
    body: "Your current plan doesn't include another workspace. Upgrade in Billing to add one.",
  });
  const permission = (): CreateOrgErrorState => ({
    kind: "permission_denied",
    title: "You don't have permission to create workspaces",
    body: "Your current account isn't allowed to create new workspaces. Ask a workspace owner or platform admin for access.",
  });
  const slug = (): CreateOrgErrorState => ({
    kind: "slug_taken",
    title: "That URL is already in use",
    body: "Pick a different slug — workspace URLs have to be unique across Atlas.",
  });

  // Tier 1 — HTTP status codes are unambiguous.
  if (status === 402) return billing();
  if (status === 403) return permission();
  if (status === 409) return slug();

  // Tier 2 — server-supplied codes.
  if (code === "BILLING_REQUIRED" || code === "PLAN_LIMIT_REACHED") return billing();
  if (code === "FORBIDDEN") return permission();
  if (code === "SLUG_ALREADY_EXISTS" || code === "ORGANIZATION_ALREADY_EXISTS") return slug();

  // Tier 3 — fuzzy message regex (legacy shapes, custom policy plugins).
  if (/upgrade your plan|plan limit|workspace limit reached|billing required/i.test(message)) return billing();
  if (/not (allowed|permitted)|forbidden|insufficient (permissions|role)/i.test(message)) return permission();
  // "slug" within ~20 chars of taken/in use/exists catches "slug is already
  // taken" and "slug already in use" without matching unrelated "already exists"
  // strings on neighboring fields.
  if (/slug[^.]{0,20}(taken|in use|exists)|already exists/i.test(message)) return slug();

  return {
    kind: "unknown",
    title: UNKNOWN_FALLBACK.title,
    body: message || UNKNOWN_FALLBACK.body,
  };
}
