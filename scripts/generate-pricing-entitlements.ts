#!/usr/bin/env bun
/**
 * Generate the pricing-page feature-entitlement artifact
 * (`apps/www/src/app/pricing/entitlements.generated.ts`) from the
 * `FeatureEntitlement` SSOT (WS4 of #3984 / #3996).
 *
 * `FEATURE_ENTITLEMENTS` in
 * `packages/api/src/lib/billing/feature-entitlement.ts` is the single source
 * of truth mapping every gated capability to the minimum plan tier that
 * unlocks it — the same map the request-time enforcement guard reads.
 *
 * The marketing site (`@atlas/www`) is a standalone Next.js app with **no**
 * dependency on `@atlas/api` (the frontend must not import the API package —
 * CLAUDE.md), so the pricing comparison table cannot read the SSOT directly.
 * This script mirrors the SSOT — via the pure mapping in
 * `packages/api/src/lib/billing/pricing-entitlement-artifact.ts` — into a
 * plain data-only TS artifact the page imports. The artifact is fully
 * machine-written; never hand-edit it.
 *
 * `scripts/check-pricing-parity.sh` runs this in `--check` mode, which
 * regenerates the artifact in memory and fails (non-zero) if the on-disk
 * file is stale — without writing and without consulting git. That catches a
 * feature added/removed/re-tiered in the SSOT (or a label added to
 * `FEATURE_DISPLAY`) that wasn't regenerated, while never spuriously failing
 * on unrelated working-tree edits.
 *
 * Run locally: bun scripts/generate-pricing-entitlements.ts
 *
 * @module
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Relative import: this script lives in the repo-root scripts/ dir, where
// the @atlas/api workspace alias is not resolvable (root has no dependency
// on it). Same constraint as scripts/generate-saas-env-doc.ts. The imported
// module pulls in @atlas/api, so it runs only at generate/check time inside
// CI or a dev machine — it never enters the @atlas/www bundle, which imports
// the generated artifact.
import {
  renderArtifact,
  buildEntitlementRows,
} from "../packages/api/src/lib/billing/pricing-entitlement-artifact";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPT_DIR, "..");
const ARTIFACT_PATH = join(
  ROOT,
  "apps/www/src/app/pricing/entitlements.generated.ts",
);

function main(): void {
  // `--check` verifies the artifact is current without writing and without
  // consulting git — so it ignores unrelated working-tree edits while still
  // catching a feature added/removed/re-tiered in the SSOT that wasn't
  // regenerated here.
  const checkOnly = process.argv.includes("--check");

  const next = renderArtifact();
  const current = (() => {
    try {
      return readFileSync(ARTIFACT_PATH, "utf8");
    } catch (err) {
      // First-ever generation (or a deleted artifact): treat as "no current"
      // so a write proceeds and --check reports drift. The absence is the
      // signal — surfaced via the drift error below, not swallowed. Narrow
      // rather than assert the error shape: only a genuine ENOENT (missing
      // file) returns null; every other I/O error (EACCES, EISDIR, …) re-throws
      // to the top-level handler and fails loud.
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return null;
      }
      throw err;
    }
  })();

  const featureCount = buildEntitlementRows().length;

  if (current === next) {
    process.stdout.write(
      `generate-pricing-entitlements: artifact already up to date (${featureCount} features).\n`,
    );
    return;
  }

  if (checkOnly) {
    throw new Error(
      `Pricing entitlement artifact is out of date — ${ARTIFACT_PATH} does not ` +
        `match FEATURE_ENTITLEMENTS/FEATURE_DISPLAY. ` +
        `Run \`bun scripts/generate-pricing-entitlements.ts\` and commit.`,
    );
  }

  writeFileSync(ARTIFACT_PATH, next);
  process.stdout.write(
    `generate-pricing-entitlements: regenerated artifact (${featureCount} features).\n`,
  );
}

try {
  main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`generate-pricing-entitlements: ${message}\n`);
  process.exit(1);
}
