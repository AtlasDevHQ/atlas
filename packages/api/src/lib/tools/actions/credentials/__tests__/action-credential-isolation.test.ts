/**
 * Tier-isolation seam test (#3766) — the counterpart of
 * `integrations/operator-credentials/__tests__/operator-credential-isolation.test.ts`,
 * one tier down.
 *
 * The WORKSPACE action-credential tier (this directory) and the OPERATOR tier
 * (`lib/integrations/operator-credentials/`) must never read from each other's
 * store:
 *
 *   - A workspace action-credential read must NEVER surface an operator
 *     secret, and
 *   - the operator store must never learn about action-target credentials.
 *
 * The stakes are higher here than for the chat platforms, because the
 * precedence ladders differ: the operator resolver deliberately overlays DB
 * over env PER FIELD, while this tier is all-or-nothing per rung (ADR-0046).
 * A shared module between them would make the wrong policy one import away.
 *
 * Two layers of enforcement, both pinned here:
 *   1. STRUCTURAL — the workspace action-credential modules only ever touch
 *      the `workspace_action_credentials` table, and the two module graphs
 *      don't import each other.
 *   2. BEHAVIORAL — a resolved credential set only ever carries the target's
 *      declared field keys; it can't smuggle an operator secret out. (That
 *      half is pinned in `resolver.test.ts`, which can mock the store.)
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dir;
const WS_DIR = join(HERE, "..");
const OP_DIR = join(HERE, "..", "..", "..", "..", "integrations", "operator-credentials");

/** Strip block + line comments so checks match real code, not prose. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function readCode(dir: string, rel: string): string {
  return stripComments(readFileSync(join(dir, rel), "utf8"));
}

/** All module specifiers actually imported by `code` (after comment strip). */
function importSpecifiers(code: string): string[] {
  const out: string[] = [];
  const re = /from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) out.push(m[1] ?? m[2]);
  return out;
}

describe("structural isolation", () => {
  const wsStore = readCode(WS_DIR, "store.ts");
  const wsResolver = readCode(WS_DIR, "resolver.ts");
  const wsTargets = readCode(WS_DIR, "targets.ts");

  it("the workspace action store touches only workspace_action_credentials", () => {
    expect(wsStore).toMatch(/workspace_action_credentials/);
    expect(wsStore).not.toMatch(/operator_integration_credentials/);
    // `\b` after `_` is not a boundary, so this does NOT match inside
    // `workspace_action_credentials` — it only catches the other
    // workspace-tier table standing alone.
    expect(wsStore).not.toMatch(/\bintegration_credentials\b/);
    expect(wsStore).not.toMatch(/\btwenty_integrations\b/);
    expect(wsStore).not.toMatch(/\bworkspace_plugins\b/);
    expect(wsStore).not.toMatch(/\bchat_cache\b/);
  });

  it("the action-credential modules do not import the operator tier", () => {
    for (const code of [wsStore, wsResolver, wsTargets]) {
      for (const spec of importSpecifiers(code)) {
        expect(spec).not.toContain("operator-credentials");
        expect(spec).not.toContain("integrations/credentials/");
        expect(spec).not.toContain("@useatlas/twenty");
      }
      expect(code).not.toContain("readOperatorCredentials");
      expect(code).not.toContain("resolveOperatorFieldValue");
      expect(code).not.toContain("OPERATOR_PLATFORMS");
    }
  });

  it("the operator tier does not import the action-credential modules", () => {
    for (const rel of ["store.ts", "resolver.ts", "platforms.ts"]) {
      const code = readCode(OP_DIR, rel);
      for (const spec of importSpecifiers(code)) {
        expect(spec).not.toContain("actions/credentials");
      }
      expect(code).not.toMatch(/workspace_action_credentials/);
      expect(code).not.toContain("resolveActionCredentials");
      expect(code).not.toContain("ACTION_TARGETS");
    }
  });

  it("the action target registry declares no operator-tier platform slug", () => {
    // A target that reused an operator platform slug would invite a future
    // "just read the operator row as a default" shortcut — exactly the
    // middle tier ADR-0046 refuses.
    const opPlatforms = readCode(OP_DIR, "platforms.ts");
    const opSlugs = [...opPlatforms.matchAll(/platform:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(opSlugs.length).toBeGreaterThan(0);
    const targetSlugs = [...wsTargets.matchAll(/target:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(targetSlugs.length).toBeGreaterThan(0);
    for (const slug of targetSlugs) {
      expect(opSlugs).not.toContain(slug);
    }
  });

  it("the resolver names no operator env var outside the target field specs", () => {
    // The only env keys this tier may read are the ones its targets declare.
    // A hard-coded `SLACK_*` / `TWENTY_*` read here would be a cross-tier leak.
    expect(wsResolver).not.toMatch(/\bSLACK_[A-Z_]+\b/);
    expect(wsResolver).not.toMatch(/\bTWENTY_[A-Z_]+\b/);
    expect(wsResolver).not.toMatch(/\bDATABASE_URL\b/);
  });
});
