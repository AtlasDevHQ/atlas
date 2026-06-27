/**
 * Pricing-page entitlement mirror — the pure mapping from the
 * `FeatureEntitlement` SSOT to the per-tier comparison rows the marketing
 * site renders (WS4 of #3984 / #3996).
 *
 * The marketing site (`@atlas/www`) is a standalone Next.js app with **no**
 * dependency on `@atlas/api` (the frontend must not import the API package —
 * CLAUDE.md), so the pricing comparison table cannot read
 * {@link FEATURE_ENTITLEMENTS} directly. Instead `scripts/generate-pricing-
 * entitlements.ts` mirrors this module's output into a plain data-only TS
 * artifact (`apps/www/src/app/pricing/entitlements.generated.ts`) that the
 * page imports, and `scripts/check-pricing-parity.sh` fails CI when the
 * artifact drifts from the SSOT.
 *
 * The mapping lives here — beside the SSOT, inside the test-runnable api
 * package — rather than in the root generator script so it is unit-testable
 * (the generator script merely renders + writes the file). Each cell is
 * computed with {@link isPlanEligible} against the feature's required tier:
 * the identical ordering the enforcement guard uses, so the page can never
 * claim a tier unlocks a feature the code gates above it.
 *
 * @module
 */

import {
  FEATURE_ENTITLEMENTS,
  type GatedFeature,
} from "@atlas/api/lib/billing/feature-entitlement";
import { isPlanEligible } from "@atlas/api/lib/integrations/install/plan-rank";
import type { PlanTier } from "@useatlas/types";

/**
 * The four columns the marketing comparison table renders, in display
 * order, each mapped to the {@link PlanTier} whose entitlement decides the
 * cell. `selfHosted` maps to `free`: the public page's "Self-Hosted" column
 * is the free OSS tier on the *hosted* ladder, which never satisfies a
 * Business-min gate (`isPlanEligible("free", "business") === false`) — the
 * self-hosted-enterprise license story is separate and not what this column
 * sells. starter/pro/business map to their like-named tiers.
 */
export const COLUMN_TIERS = {
  selfHosted: "free",
  starter: "starter",
  pro: "pro",
  business: "business",
} as const satisfies Record<string, PlanTier>;

export type PricingColumn = keyof typeof COLUMN_TIERS;

/** Comparison-table section a gated feature renders under. */
export type EntitlementSection = "hosting" | "security & compliance";

interface FeatureDisplay {
  /** Row label shown verbatim in the comparison table. */
  readonly label: string;
  /** Section the row renders under. */
  readonly section: EntitlementSection;
}

/**
 * Per-feature display metadata, keyed by {@link GatedFeature} so adding a
 * capability to the SSOT without a label + section here is a compile error
 * (the `Record<GatedFeature, …>` annotation), and {@link assertDisplayExhaustive}
 * catches a stale entry for a removed feature at generate/test time.
 *
 * Labels and section assignment mirror the hand-written copy the page shipped
 * before this mirror existed, with one intentional addition: `proactive`
 * (Proactive monitoring) was gated by the SSOT but never listed on the page.
 * Surfacing it here is deliberate — WS4 of #3984 advertises proactive
 * monitoring as the premium line the SSOT now gates per-tier — so the mirror
 * adds a "Proactive monitoring" row the prior copy did not have.
 */
export const FEATURE_DISPLAY: Record<GatedFeature, FeatureDisplay> = {
  // hosting
  white_label: { label: "White-label branding", section: "hosting" },
  residency: { label: "Data residency", section: "hosting" },
  backups: { label: "Automated backups", section: "hosting" },
  custom_domain: { label: "Custom domain", section: "hosting" },
  // security & compliance
  sso: { label: "SSO (SAML + OIDC)", section: "security & compliance" },
  scim: { label: "SCIM directory sync", section: "security & compliance" },
  custom_roles: {
    label: "Custom roles & permissions",
    section: "security & compliance",
  },
  ip_allowlist: { label: "IP allowlisting", section: "security & compliance" },
  approvals: { label: "Approval workflows", section: "security & compliance" },
  audit_retention: {
    label: "Audit log retention policies",
    section: "security & compliance",
  },
  masking: {
    label: "PII detection & masking",
    section: "security & compliance",
  },
  proactive: {
    label: "Proactive monitoring",
    section: "security & compliance",
  },
};

/** Section render order in the artifact. */
export const SECTION_ORDER: readonly EntitlementSection[] = [
  "hosting",
  "security & compliance",
];

/**
 * One generated comparison row: the feature's stable wire id, its display
 * label, the section it belongs to, and the per-column entitlement booleans.
 */
export interface GeneratedEntitlementRow {
  readonly feature: GatedFeature;
  readonly label: string;
  readonly section: EntitlementSection;
  readonly cells: Readonly<Record<PricingColumn, boolean>>;
}

/**
 * Throw if {@link FEATURE_DISPLAY} does not cover exactly the SSOT's
 * {@link GatedFeature} set. The `Record<GatedFeature, …>` annotation already
 * makes a *missing* feature a compile error; this runtime guard additionally
 * catches a *stale* entry left behind for a feature removed from the SSOT
 * (which the type annotation alone permits), so the mirror can't invent a
 * tier row for a capability that no longer exists.
 */
export function assertDisplayExhaustive(): void {
  const ssotKeys = Object.keys(FEATURE_ENTITLEMENTS).sort();
  const displayKeys = Object.keys(FEATURE_DISPLAY).sort();
  const missing = ssotKeys.filter((k) => !displayKeys.includes(k));
  const extra = displayKeys.filter((k) => !ssotKeys.includes(k));
  if (missing.length > 0 || extra.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) {
      parts.push(`missing display metadata for: ${missing.join(", ")}`);
    }
    if (extra.length > 0) {
      parts.push(
        `stale display metadata for non-features: ${extra.join(", ")}`,
      );
    }
    throw new Error(
      `FEATURE_DISPLAY is out of sync with FEATURE_ENTITLEMENTS (${parts.join("; ")}). ` +
        `Every GatedFeature needs exactly one label + section in FEATURE_DISPLAY.`,
    );
  }
}

/**
 * Pure builder: map the SSOT into the ordered comparison rows the artifact
 * renders. Each cell is computed with {@link isPlanEligible} against the
 * feature's required tier — the identical ordering the enforcement guard
 * uses — so the page can never claim a tier unlocks a feature the code
 * gates above it. Rows are ordered by {@link SECTION_ORDER}, then by the
 * SSOT key order within a section, for a stable artifact.
 */
export function buildEntitlementRows(): GeneratedEntitlementRow[] {
  assertDisplayExhaustive();
  const columns = Object.entries(COLUMN_TIERS) as [PricingColumn, PlanTier][];
  const features = Object.keys(FEATURE_ENTITLEMENTS) as GatedFeature[];

  const rows: GeneratedEntitlementRow[] = features.map((feature) => {
    const required = FEATURE_ENTITLEMENTS[feature];
    const cells = Object.fromEntries(
      columns.map(([column, tier]) => [column, isPlanEligible(tier, required)]),
    ) as Record<PricingColumn, boolean>;
    return {
      feature,
      label: FEATURE_DISPLAY[feature].label,
      section: FEATURE_DISPLAY[feature].section,
      cells,
    };
  });

  return rows.toSorted((a, b) => {
    const sa = SECTION_ORDER.indexOf(a.section);
    const sb = SECTION_ORDER.indexOf(b.section);
    if (sa !== sb) return sa - sb;
    return features.indexOf(a.feature) - features.indexOf(b.feature);
  });
}

/**
 * Render the full artifact source. The whole file is machine-written, so the
 * drift guard compares the rendered string against the on-disk file verbatim
 * (no marker splice needed). The shape is a flat list of rows, each with
 * per-column booleans — a pure data module with zero `@atlas/api` import, so
 * the marketing bundle never pulls in the API package.
 */
export function renderArtifact(): string {
  const rows = buildEntitlementRows();
  const columnNames = Object.keys(COLUMN_TIERS) as PricingColumn[];

  // Derive every emitted union from its source so there is exactly one
  // spelling per union, not a hand-written literal that can drift from the
  // data it describes. The column union comes from COLUMN_TIERS, the section
  // union from SECTION_ORDER, and the feature-id union from the rows — so a
  // new column/section/feature is reflected in the artifact's types on the
  // next regeneration, and a typo'd CELL_LABEL_OVERRIDES key on the page side
  // is a compile error rather than a silent no-op.
  const toUnion = (values: readonly string[]): string =>
    values.map((v) => JSON.stringify(v)).join(" | ");
  const columnUnion = toUnion(columnNames);
  const sectionUnion = toUnion(SECTION_ORDER);
  const featureUnion = toUnion(rows.map((row) => row.feature));
  const sectionOrderLiteral = SECTION_ORDER.map((s) => JSON.stringify(s)).join(
    ", ",
  );

  const rowLiterals = rows
    .map((row) => {
      const cells = columnNames
        .map((c) => `${c}: ${row.cells[c]}`)
        .join(", ");
      return (
        `  {\n` +
        `    feature: ${JSON.stringify(row.feature)},\n` +
        `    label: ${JSON.stringify(row.label)},\n` +
        `    section: ${JSON.stringify(row.section)},\n` +
        `    cells: { ${cells} },\n` +
        `  },`
      );
    })
    .join("\n");

  return `// @generated by scripts/generate-pricing-entitlements.ts — DO NOT EDIT.
//
// Mirror of the FeatureEntitlement SSOT
// (packages/api/src/lib/billing/feature-entitlement.ts) for the pricing
// comparison table. Regenerate with:
//
//   bun scripts/generate-pricing-entitlements.ts
//
// The drift guard scripts/check-pricing-parity.sh fails CI when this file
// is stale relative to FEATURE_ENTITLEMENTS, so the page's per-tier feature
// columns can never silently diverge from what the code actually enforces.
// The frontend (@atlas/www) imports only this plain data module and never
// @atlas/api — CLAUDE.md: the frontend is a pure HTTP client.

/** Marketing comparison-table columns, in display order. */
export type PricingColumn = ${columnUnion};

/** Comparison-table section a gated feature renders under. */
export type EntitlementSection = ${sectionUnion};

/**
 * The entitlement sections in render order. Iterate this (rather than
 * hand-listing the section labels) so a new section added to the SSOT can't be
 * silently dropped from the page — every member is rendered or it's a visible
 * gap, not a quiet omission.
 */
export const ENTITLEMENT_SECTION_ORDER: readonly EntitlementSection[] = [
  ${sectionOrderLiteral},
];

/** Stable wire id of a gated feature (matches the SSOT key). */
export type FeatureId = ${featureUnion};

/** One per-tier entitlement row mirrored from the SSOT. */
export interface EntitlementRow {
  /** Stable wire id of the gated feature (matches the SSOT key). */
  readonly feature: FeatureId;
  /** Row label shown verbatim in the comparison table. */
  readonly label: string;
  /** Section the row renders under. */
  readonly section: EntitlementSection;
  /** Whether each marketing tier unlocks the feature (true) or not (false). */
  readonly cells: Readonly<Record<PricingColumn, boolean>>;
}

/**
 * Per-tier feature entitlements, generated from FEATURE_ENTITLEMENTS. Each
 * cell is \`isPlanEligible(columnTier, requiredTier)\` — the same predicate
 * enforcement reads — so a cell is true iff that tier actually unlocks the
 * feature in code.
 */
export const ENTITLEMENT_ROWS: readonly EntitlementRow[] = [
${rowLiterals}
];
`;
}
