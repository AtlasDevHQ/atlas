#!/usr/bin/env bun
/**
 * Enforcement-leg of the pricing-parity drift guard (WS1/WS4 of #3984 / #3997).
 *
 * #3996 shipped the SSOT ↔ marketing-artifact leg (`check-pricing-parity.sh`).
 * This runner adds the third leg: it scans the API **route layer** for
 * `requireFeatureEntitlement(orgId, "<feature>")` call sites — the request-time
 * gate that denies a below-tier workspace at the API boundary — and verifies,
 * via the pure `checkEnforcementParity`, that the set of enforced features plus
 * the reviewed `ENFORCEMENT_PENDING` allowlist exactly covers the entitlement
 * SSOT. It fails (non-zero, actionable message) on any of:
 *
 *   - a SSOT feature that is neither enforced nor pending (a silently-open
 *     ladder: the page sells it tier-gated but no route consults the SSOT),
 *   - a feature that is enforced yet still listed pending (stale allowlist),
 *   - a pending entry for a feature no longer in the SSOT (phantom).
 *
 * The route-layer scan is the one impure piece, so it lives here in the script
 * rather than in the unit-tested pure module — mirroring how
 * `generate-pricing-entitlements.ts` does the file I/O while
 * `pricing-entitlement-artifact.ts` stays pure. The pure parser
 * (`extractEnforcedFeatures`) is shared so the script and the
 * `enforcement-parity.test.ts` unit test recognize call sites identically.
 *
 * Run locally: bun scripts/check-enforcement-parity.ts
 *
 * @module
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

// Relative import: this script lives in repo-root scripts/, where the
// @atlas/api workspace alias is not resolvable (root has no dep on it). Same
// constraint as generate-pricing-entitlements.ts. The imported module pulls in
// @atlas/api, so it runs only at check time in CI / a dev machine.
import {
  checkEnforcementParity,
  extractEnforcedFeatures,
} from "../packages/api/src/lib/billing/enforcement-parity";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPT_DIR, "..");

// The route layer is where request-time gates are wired. The guard definition
// and its unit test contain the literal `requireFeatureEntitlement(..., "sso")`
// too, but those are the definition/test — not an enforced route — so the scan
// is scoped to the routes dir and excludes test files.
const SCAN_DIR = join(ROOT, "packages/api/src/api/routes");

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      // Skip test/fixture dirs — a literal in a test is not an enforced gate.
      if (entry === "__tests__" || entry === "__fixtures__") continue;
      out.push(...tsFilesUnder(full));
      continue;
    }
    if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
    if (entry.endsWith(".test.ts") || entry.endsWith(".test.tsx")) continue;
    out.push(full);
  }
  return out;
}

function main(): void {
  const files = tsFilesUnder(SCAN_DIR);
  if (files.length === 0) {
    throw new Error(
      `No route source files found under ${relative(ROOT, SCAN_DIR)} — the ` +
        `enforcement scan would vacuously "pass". Check the SCAN_DIR path.`,
    );
  }

  const blob = files.map((f) => readFileSync(f, "utf8")).join("\n");
  const enforced = extractEnforcedFeatures(blob);

  const findings = checkEnforcementParity(enforced);

  process.stdout.write(
    `check-enforcement-parity: scanned ${files.length} route file(s); ` +
      `${enforced.size} feature(s) enforced at the route layer ` +
      `(${[...enforced].sort().join(", ") || "none"}).\n`,
  );

  if (findings.length > 0) {
    const lines = findings.map((f) => `  - [${f.kind}] ${f.message}`);
    throw new Error(
      `pricing-parity enforcement leg failed — the entitlement SSOT, the ` +
        `pending allowlist, and the enforced route gates disagree:\n` +
        lines.join("\n") +
        `\n\nSSOT: packages/api/src/lib/billing/feature-entitlement.ts\n` +
        `Pending allowlist: packages/api/src/lib/billing/enforcement-parity.ts ` +
        `(ENFORCEMENT_PENDING)\n` +
        `Route gates: packages/api/src/api/routes/** ` +
        `(requireFeatureEntitlement call sites)`,
    );
  }

  process.stdout.write(
    `Pricing-parity enforcement leg passed — every SSOT feature is either ` +
      `gated at the route layer or recorded as not-yet-wired in ` +
      `ENFORCEMENT_PENDING.\n`,
  );
}

try {
  main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`check-enforcement-parity: ${message}\n`);
  process.exit(1);
}
