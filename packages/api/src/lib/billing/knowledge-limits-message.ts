/**
 * The one Knowledge Base fail-closed message (#4235).
 *
 * Both producers of the KB `billing_check_failed` 503 need it —
 * `enforcement.ts` (the collections count could not be determined) and
 * `knowledge-limits.ts` (the workspace's tier could not be resolved) — and
 * `knowledge-limits.ts` already imports `enforcement.ts`, so a constant owned
 * by either would close an import cycle. It lives in this leaf module instead,
 * so the two 503s cannot drift into saying different things about the same
 * subsystem.
 *
 * @module
 */

/** Surfaced when a KB cap could not be verified — "try again", never "upgrade". */
export const KNOWLEDGE_CAP_CHECK_FAILED_MSG =
  "Unable to verify your plan's Knowledge Base limits. Please try again.";
