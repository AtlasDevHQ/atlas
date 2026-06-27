/**
 * Enforcement-leg parity for the pricing-parity drift guard (WS1/WS4 of
 * #3984 / #3997).
 *
 * #3996 shipped the SSOT ↔ marketing-artifact leg: it proves the pricing
 * page's per-tier columns mirror {@link FEATURE_ENTITLEMENTS} exactly. This
 * module adds the third leg the parent PRD asks for — **enforcement** — so the
 * full triangle (page claims ↔ entitlement SSOT ↔ actual enforced gates) can't
 * silently disagree:
 *
 *   - The page sells a feature as tier-gated (mirror leg, #3996).
 *   - The SSOT maps that feature → its minimum tier ({@link FEATURE_ENTITLEMENTS}).
 *   - **This leg:** the request-time guard `requireFeatureEntitlement(orgId,
 *     "<feature>")` is actually wired into that feature's route handlers, so a
 *     below-tier workspace is denied at the API boundary — not merely hidden in
 *     the UI (PRD WS1 user story 29).
 *
 * The danger this catches is the *silently-ungated ladder*: a capability the
 * SSOT/page advertises as a paid-tier feature, but which no route consults the
 * SSOT for — so every workspace, regardless of tier, can reach it by calling
 * the endpoint directly. That was the pre-#3984 status quo for all ten
 * "Business-only" features, and it's exactly the drift the guard must make
 * impossible to reintroduce.
 *
 * ## Why a pending allowlist
 *
 * Wiring the per-feature gates is itself incremental WS1 work (#3986 wired
 * `sso`; #3987 and siblings wire SCIM, roles, IP allowlist, approvals, …). So
 * at any given moment some SSOT features legitimately have no enforcement gate
 * *yet*. {@link ENFORCEMENT_PENDING} is the explicit, reviewed record of those:
 * a feature in the SSOT is acceptable-without-a-gate only while it's listed
 * here with its tracking issue. The guard then fails on three distinct drifts:
 *
 *   1. **Ungated & unacknowledged** — a SSOT feature that is neither enforced
 *      nor in {@link ENFORCEMENT_PENDING}. This is the real regression: someone
 *      added/advertised a gated capability and forgot to gate it (or forgot to
 *      record it as pending). Fails closed.
 *   2. **Stale pending** — a feature that IS now enforced but is still listed
 *      pending. Forces the allowlist to shrink as gates land, so it can't rot
 *      into a permanent escape hatch.
 *   3. **Phantom pending** — a {@link ENFORCEMENT_PENDING} entry that names a
 *      feature not in the SSOT (typo, or a feature since removed). Keeps the
 *      allowlist honest.
 *
 * The actual call-site scan over the route layer is done by the caller (the
 * `scripts/check-enforcement-parity.sh` runner) and passed in as
 * `enforcedFeatures`, so this module stays a pure, trivially table-testable
 * function with no filesystem dependency — mirroring how
 * `pricing-entitlement-artifact.ts` keeps the SSOT→mirror mapping pure and the
 * generator script does the I/O.
 *
 * @module
 */

import {
  FEATURE_ENTITLEMENTS,
  type GatedFeature,
} from "@atlas/api/lib/billing/feature-entitlement";

/**
 * A GitHub issue reference (`#1234`). Used as the {@link ENFORCEMENT_PENDING}
 * value type so the "every pending entry names a tracking issue" invariant is
 * compile-enforced — `scim: ""` or `scim: "soon"` is a type error.
 */
export type IssueRef = `#${number}`;

/**
 * Features in the SSOT that intentionally have **no** request-time
 * `requireFeatureEntitlement` gate wired yet, each justified by the WS1 issue
 * that will wire it. The guard treats a SSOT feature as acceptable-without-a-
 * gate *only* while it appears here — so a newly-added gated capability with no
 * gate and no pending entry fails the build.
 *
 * Remove an entry the moment its gate lands: {@link checkEnforcementParity}
 * flags a still-pending feature that is already enforced (rule 2), so this set
 * is forced to shrink to empty as WS1 completes. When it's empty, every SSOT
 * feature is enforced — the ladder is fully real.
 *
 * Keyed by {@link GatedFeature}; the `Partial<Record<...>>` shape makes a typo'd
 * key a compile error while {@link checkEnforcementParity} catches an entry for
 * a feature no longer in the SSOT at runtime. The value is typed
 * {@link IssueRef} (`#<number>`) so the documented "every pending entry carries
 * a tracking issue" invariant is a compile-time guarantee, not a comment — an
 * empty or prose value won't typecheck.
 */
export const ENFORCEMENT_PENDING: Partial<Record<GatedFeature, IssueRef>> = {
  // #3987 gated SCIM, custom roles, IP allowlist, and approval workflows — those
  // four now have route-layer requireFeatureEntitlement gates and were removed
  // from this allowlist when that slice landed (rule 2 forces the shrink).
  // Remaining WS1 surfaces (audit-retention, masking, residency, backups,
  // white-label, proactive) — gated in their own follow-up slices under #3984.
  audit_retention: "#3984",
  masking: "#3984",
  residency: "#3984",
  backups: "#3984",
  white_label: "#3984",
  proactive: "#3984",
};

/** A single enforcement-parity finding (one drift). */
export interface EnforcementParityFinding {
  readonly kind: "ungated" | "stale-pending" | "phantom-pending";
  readonly feature: string;
  readonly message: string;
}

/**
 * Compare the SSOT's gated features against the set actually enforced at the
 * route layer (call sites of `requireFeatureEntitlement(..., "<feature>")`)
 * and the {@link ENFORCEMENT_PENDING} allowlist. Returns one finding per drift;
 * an empty array means the three legs agree.
 *
 * Pure: the caller supplies the scanned `enforcedFeatures` set, so this is
 * directly table-testable with synthetic inputs (the unit test feeds it an
 * injected mismatch to prove the guard fires, and the aligned set to prove it
 * passes — so the gate can never silently no-op). The live wiring of the scan
 * is the script's job.
 *
 * @param enforcedFeatures feature ids found gated by a route-layer
 *   `requireFeatureEntitlement` call. Strings (not narrowed to
 *   {@link GatedFeature}) so a stray id from the scan is reported, not dropped.
 * @param ssot the entitlement SSOT keys; defaults to the live
 *   {@link FEATURE_ENTITLEMENTS}. Overridable for tests.
 * @param pending the pending allowlist; defaults to the live
 *   {@link ENFORCEMENT_PENDING}. Overridable for tests.
 */
export function checkEnforcementParity(
  enforcedFeatures: Iterable<string>,
  ssot: Readonly<Record<string, unknown>> = FEATURE_ENTITLEMENTS,
  pending: Readonly<Record<string, string>> = ENFORCEMENT_PENDING,
): EnforcementParityFinding[] {
  const enforced = new Set(enforcedFeatures);
  const ssotKeys = new Set(Object.keys(ssot));
  const pendingKeys = new Set(Object.keys(pending));
  const findings: EnforcementParityFinding[] = [];

  // Rule 1 — every SSOT feature must be either enforced or explicitly pending.
  // An ungated, unacknowledged feature is the silently-open ladder we guard
  // against: the page sells it tier-gated but no route consults the SSOT.
  for (const feature of [...ssotKeys].sort()) {
    if (enforced.has(feature) || pendingKeys.has(feature)) continue;
    findings.push({
      kind: "ungated",
      feature,
      message:
        `"${feature}" is in the entitlement SSOT but no route consults ` +
        `requireFeatureEntitlement(orgId, "${feature}"). The pricing page ` +
        `sells it as tier-gated while the API leaves it open to every tier. ` +
        `Wire the guard into its route handlers, or — if it's not yet wired — ` +
        `record it in ENFORCEMENT_PENDING with its tracking issue.`,
    });
  }

  // Rule 2 — a feature that IS enforced must not still be listed pending, so
  // the allowlist shrinks to empty as gates land and can't rot into a
  // permanent escape hatch.
  for (const feature of [...pendingKeys].sort()) {
    if (!ssotKeys.has(feature)) continue; // handled by rule 3
    if (enforced.has(feature)) {
      findings.push({
        kind: "stale-pending",
        feature,
        message:
          `"${feature}" is now enforced by a route-layer ` +
          `requireFeatureEntitlement call but is still listed in ` +
          `ENFORCEMENT_PENDING. Remove it — the allowlist must only hold ` +
          `features that are genuinely not yet gated.`,
      });
    }
  }

  // Rule 3 — a pending entry for a feature the SSOT no longer has (typo or a
  // removed feature) is stale and must be cleaned up.
  for (const feature of [...pendingKeys].sort()) {
    if (ssotKeys.has(feature)) continue;
    findings.push({
      kind: "phantom-pending",
      feature,
      message:
        `ENFORCEMENT_PENDING lists "${feature}", which is not a feature in ` +
        `FEATURE_ENTITLEMENTS. Remove the stale entry.`,
    });
  }

  return findings;
}

/**
 * Regex that extracts the feature id from a route-layer enforcement call:
 * `requireFeatureEntitlement(<anything>, "<feature>")`. The first argument is
 * the orgId expression (ignored); the second is the stable feature id. Used by
 * the script to scan the route layer. Exported so the unit test pins the exact
 * shape the scan recognizes.
 *
 * Recognizes only a **string-literal** second argument (`"sso"`, `'scim'`) — a
 * dynamic feature id (`requireFeatureEntitlement(orgId, feature)`) is not
 * counted as enforced. That's the safe direction: an unrecognized call makes
 * its feature look *un*-enforced, so the guard fails *closed* (demands a gate
 * or a pending entry) rather than silently treating it as covered. If a route
 * ever gates via a non-literal, add the feature to {@link ENFORCEMENT_PENDING}
 * or switch the call to a literal.
 */
export const ENFORCEMENT_CALL_RE =
  /requireFeatureEntitlement\s*\(\s*[^,]+,\s*["']([a-z_]+)["']\s*\)/g;

/**
 * Extract the set of enforced feature ids from a blob of TypeScript source
 * (one or more concatenated route files), using {@link ENFORCEMENT_CALL_RE}.
 * Pure string operation so the script and the test share one parser.
 */
export function extractEnforcedFeatures(source: string): Set<string> {
  const found = new Set<string>();
  for (const match of source.matchAll(ENFORCEMENT_CALL_RE)) {
    found.add(match[1]);
  }
  return found;
}
