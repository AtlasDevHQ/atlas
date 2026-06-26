/**
 * Transient signup draft carried across the email → region → account steps.
 *
 * Under ADR-0024 §4 the signup order is **email → region → create-account**.
 * Selecting a region repoints the browser at that region's API and forces a
 * hard reload (so the Better-Auth client singleton rebuilds against the
 * regional base — see `@/lib/api-url` + `@/lib/auth/client`). A hard reload
 * wipes React state, so the email collected on `/signup` can't survive to
 * `/signup/account` in memory — it rides in `sessionStorage` instead.
 *
 * Email is deliberately NOT threaded as a URL query param: it's PII and would
 * leak into history, server logs, and the Referer header. `invitationId` (an
 * opaque token already present in the inbound `/signup?invitationId=…` URL)
 * rides along so the account step can route a verified invitee to
 * `/accept-invitation/<id>` instead of the workspace step.
 *
 * Scoped to `sessionStorage` (per-tab, cleared on tab close) and wiped by
 * `clearSignupDraft()` once the account is created.
 */

const DRAFT_KEY = "atlas:signup:draft";

export interface SignupDraft {
  /** The email the user entered on the first signup step. */
  email: string;
  /**
   * Org-invitation token from `/signup?invitationId=…`, when the user is
   * creating an account to accept an invitation rather than starting fresh.
   */
  invitationId?: string;
}

export function saveSignupDraft(draft: SignupDraft): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch (err) {
    // A full/blocked sessionStorage is non-fatal — the account step falls back
    // to redirecting to /signup. Surface it rather than swallow (CLAUDE.md).
    console.warn(
      "signup-draft: failed to persist signup draft:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

export function readSignupDraft(): SignupDraft | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { email, invitationId } = parsed as Record<string, unknown>;
    if (typeof email !== "string" || !email) return null;
    return {
      email,
      invitationId: typeof invitationId === "string" && invitationId ? invitationId : undefined,
    };
  } catch (err) {
    console.warn(
      "signup-draft: ignoring an unreadable signup draft:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

export function clearSignupDraft(): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(DRAFT_KEY);
  } catch (err) {
    console.warn(
      "signup-draft: failed to clear signup draft:",
      err instanceof Error ? err.message : String(err),
    );
  }
}
