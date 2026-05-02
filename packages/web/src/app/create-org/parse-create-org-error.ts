/**
 * Categorizes a Better Auth `organization.create` failure into a user-facing
 * alert state. Mirrors the shape of `parse-sign-in-error.ts` so the alert
 * renderer can stay tiny and predictable across `/login` and `/create-org`.
 *
 * Branch order is load-bearing: status/code checks run before fuzzy message
 * regex so a 403 that mentions "slug" still routes to `permission_denied`,
 * not `slug_taken`.
 */

export type CreateOrgErrorKind =
  | "slug_taken"
  | "permission_denied"
  | "billing_required"
  | "network"
  | "partial_activation"
  | "unknown";

/**
 * Discriminated by `kind`. The `partial_activation` branch carries a different
 * meaning (the org was created but `setActive` failed) so the renderer can
 * suggest a reload rather than implying the create itself failed.
 */
export type CreateOrgErrorState = {
  kind: CreateOrgErrorKind;
  title: string;
  body: string;
};

/** Better Auth's standard error envelope, with optional status/code fields. */
export interface CreateOrgResponseError {
  message?: string | null;
  code?: string | null;
  status?: number | null;
}

export interface CreateOrgErrorInput {
  /** Server-returned error envelope from authClient.organization.create(). */
  error?: CreateOrgResponseError;
  /** A thrown JS exception (e.g. fetch TypeError). */
  thrown?: unknown;
  /** True when create succeeded but the follow-up setActive call failed. */
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

  // Specific HTTP status codes are unambiguous — bucket on those first so a
  // 402 doesn't get hijacked by a "forbidden plan" string in the message
  // body and a 403 doesn't get hijacked by a slug-named field.
  if (status === 402) return billing();
  if (status === 403) return permission();
  if (status === 409) return slug();

  // Server-supplied codes are next — also unambiguous when present.
  if (code === "BILLING_REQUIRED" || code === "PLAN_LIMIT_REACHED") return billing();
  if (code === "FORBIDDEN") return permission();
  if (code === "SLUG_ALREADY_EXISTS" || code === "ORGANIZATION_ALREADY_EXISTS") return slug();

  // Fuzzy message regex is the last resort — used when neither status nor
  // code is set (older Better Auth shapes, custom policy plugins).
  if (/upgrade your plan|plan limit|workspace limit reached|billing required/i.test(message)) return billing();
  if (/not (allowed|permitted)|forbidden|insufficient (permissions|role)/i.test(message)) return permission();
  if (/slug (already|is) (taken|in use|exists)|already exists/i.test(message)) return slug();

  return {
    kind: "unknown",
    title: UNKNOWN_FALLBACK.title,
    body: message || UNKNOWN_FALLBACK.body,
  };
}
