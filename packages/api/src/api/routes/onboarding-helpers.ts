/**
 * Helpers shared between `/api/v1/onboarding/*` and the admin recovery
 * surface in `admin.ts`. Anything that needs to know how to resolve the
 * bundled canonical demo seed lives here so the two routes can't drift.
 */

import path from "path";
import { existsSync } from "fs";
import { getSemanticRoot } from "@atlas/api/lib/semantic/files";

/** Reserved connection ID for the canonical demo workspace. */
export const DEMO_CONNECTION_ID = "__demo__";

/** Display label for the canonical NovaMart demo. */
export const DEMO_LABEL = "NovaMart (E-commerce)";

/** Canonical industry slug for the demo. */
export const DEMO_INDUSTRY = "ecommerce";

/**
 * Resolve the canonical demo semantic-layer directory.
 *
 * Prefers the configured semantic root from `getSemanticRoot()` (the path the
 * runtime mounts as `semantic/` — Docker images bundle the ecommerce layer
 * here at build time; dev workspaces have the repo-root `semantic/` dir).
 * Falls back to the bundled ecommerce seed under
 * `packages/cli/data/seeds/ecommerce/semantic` for dev workspaces that
 * haven't run `atlas init` yet.
 *
 * Throws if neither location exists — this is a deploy-time misconfiguration
 * that should fail loudly rather than silently install a half-workspace.
 */
export function getDemoSemanticDir(): { dir: string; source: "semantic-root" | "bundled-seed" } {
  const root = getSemanticRoot();
  if (existsSync(path.join(root, "entities"))) {
    return { dir: root, source: "semantic-root" };
  }

  // Dev fallback when the working directory hasn't been initialized yet
  const seedsPath = path.resolve(
    process.cwd(),
    "packages",
    "cli",
    "data",
    "seeds",
    "ecommerce",
    "semantic",
  );
  if (existsSync(path.join(seedsPath, "entities"))) {
    return { dir: seedsPath, source: "bundled-seed" };
  }

  throw new Error(
    `Canonical demo semantic layer not found. ` +
      `Expected entities/ in ${root} or ${seedsPath}.`,
  );
}
