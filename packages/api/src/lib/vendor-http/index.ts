/**
 * `lib/vendor-http` — the narrow spine under this repo's hand-rolled vendor
 * HTTP clients.
 *
 * ── Standing, in one paragraph ───────────────────────────────────────────
 *
 * [ADR-0045](../../../../../docs/adr/0045-hand-rolled-vendor-http-clients.md)
 * ratified hand-rolling vendor clients against `fetch` and DEFERRED this
 * extraction — "declined *for now*, not refuted … can be revisited without
 * reopening this decision" — naming a cross-connector bug as the trigger. The
 * 2026-08-31 architecture survey found the trigger fired: timeout/abort was
 * present in the Linear action and absent in three siblings written the same
 * week, and the egress guard on a tenant-typed base URL was present in
 * Salesforce and absent in Jira on the same class of value. PR #5567 fixed
 * both live instances directly; this module is where the fixes stop being
 * per-file discipline. **ADR-0045's ratification is intact** — this changes
 * where shared code lives, not whether SDKs enter the tree. See its
 * "Amendment (#5569)" section.
 *
 * ── The four concerns this owns, and nothing else ────────────────────────
 *
 * 1. **The discriminated result shape** — `./result.ts`. ADR-0045's
 *    non-throwing `{ ok: true, … } | failure` contract, with one author.
 * 2. **Bounded failure-detail narrowing** — `./failure-detail.ts`. One
 *    definition of the 200-character truncation and, more to the point, one
 *    place stating what that bound is for (keeping an agent-visible error
 *    small) and what it is not (a redaction).
 * 3. **Timeout/abort** — `./deadline.ts`. One `isAbortError`, one deadline
 *    wrapper.
 * 4. **Host pinning** — `./host-pinning.ts`. The call shape around
 *    `openapi/egress-guard`, which is CONSUMED here and did not move.
 *
 * ── What this deliberately does NOT own ──────────────────────────────────
 *
 * Each of these is a live ADR-0045 position, not an oversight or a to-do. A
 * later editor extending this module into one of them is reopening a ratified
 * decision, and should say so in an ADR first:
 *
 * - **Retries and backoff.** They stay in the connector engine —
 *   `withRateLimitBackoff` (`lib/knowledge/connector-sync.ts`) fed by the one
 *   shared `ConnectorRateLimitError` (`lib/knowledge/connectors.ts`), per
 *   ADR-0030. Backoff belongs to the engine precisely so no vendor owns a
 *   retry policy; a retry helper here would be a second one.
 * - **Token caching.** A per-module security decision, not a utility.
 *   ADR-0045's fourth property: ingest clients deliberately do NOT cache
 *   tokens across passes, because a process-wide cache is a cross-tenant
 *   object holding decrypted-credential derivatives on a shared region
 *   process. (`lib/github/installation-token.ts` caches per credential set,
 *   on its own reasoning — that is a decision that module owns.)
 * - **Vendor SDK adoption.** Still declined by default, runtime and
 *   types-only alike, on all five of ADR-0045's grounds.
 * - **Fetch itself.** There is no `vendorFetch` here and should not be. Each
 *   client composes its own request; what it no longer composes is the
 *   classification of what came back.
 *
 * ── Who consumes it ──────────────────────────────────────────────────────
 *
 * The five ACTION clients (`lib/tools/actions/{jira,github,linear,salesforce}.ts`
 * and the email delivery chain). The ~10 `lib/brain/ingest` connectors adopt
 * **opportunistically, when next touched** — they are not migrated in this
 * arc, because proving a seam by rewriting ten working files at once is the
 * cost ADR-0045 declined in the first place.
 */

export type {
  VendorFailure,
  VendorHttpFailure,
  VendorHttpResult,
  VendorTimeoutFailure,
} from "./result";

export {
  FAILURE_DETAIL_MAX_CHARS,
  describeFailureText,
  describeHttpFailure,
  readFailureText,
  truncateFailureDetail,
} from "./failure-detail";

export { isAbortError, withVendorDeadline } from "./deadline";

export { pinVendorHost, type VendorHostPinOptions } from "./host-pinning";
