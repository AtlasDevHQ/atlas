/**
 * Secret-isolation seam test (#3704).
 *
 * The OPERATOR tier (Atlas's own app registrations, this directory) and the
 * WORKSPACE tier (a tenant's per-install secrets, `lib/integrations/credentials/`
 * + the Twenty per-workspace resolver) must never read from each other's store:
 *
 *   - An operator-credential read must NEVER surface a workspace secret, and
 *   - A workspace-credential read must NEVER fall back to an operator env var
 *     (the inverse of the CLAUDE.md "per-tenant plugin creds never fall back to
 *     operator env vars" rule — kept honest in both directions).
 *
 * Two layers of enforcement, both pinned here:
 *   1. STRUCTURAL — the operator modules only ever touch the
 *      `operator_integration_credentials` table, and the operator/workspace
 *      module graphs don't import each other.
 *   2. BEHAVIORAL — the operator adapter-env overlay only ever carries
 *      operator-managed env-var keys; it can't smuggle a workspace secret out.
 */

import { afterEach, beforeEach, describe, expect, it, mock, type Mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dir;
const OP_DIR = join(HERE, "..");

/** Strip block + line comments so checks match real code, not prose (mirrors check-twenty-resolver-imports.sh). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function readCode(rel: string): string {
  return stripComments(readFileSync(join(OP_DIR, rel), "utf8"));
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
  const opStore = readCode("store.ts");
  const opResolver = readCode("resolver.ts");
  const opPlatforms = readCode("platforms.ts");

  it("the operator store touches only the operator_integration_credentials table", () => {
    // \b after `_` is not a boundary, so `\bintegration_credentials\b` does
    // NOT match inside `operator_integration_credentials` — it only catches
    // the workspace-tier table name standing alone.
    expect(opStore).toMatch(/operator_integration_credentials/);
    expect(opStore).not.toMatch(/\bintegration_credentials\b/);
    expect(opStore).not.toMatch(/\bworkspace_plugins\b/);
    expect(opStore).not.toMatch(/\btwenty_integrations\b/);
    expect(opStore).not.toMatch(/\bchat_cache\b/);
  });

  it("operator modules do not import any workspace-tier credential module", () => {
    for (const code of [opStore, opResolver, opPlatforms]) {
      const specs = importSpecifiers(code);
      for (const spec of specs) {
        expect(spec).not.toContain("integrations/credentials/");
        expect(spec).not.toContain("@useatlas/twenty");
      }
    }
    // And no reference to the workspace/operator-env resolver symbols anywhere
    // in real code (these live in distinct seams).
    for (const code of [opStore, opResolver, opPlatforms]) {
      expect(code).not.toContain("resolveWorkspaceCredentials");
      expect(code).not.toContain("resolveOperatorCredentials"); // the Twenty env path — distinct seam
    }
  });

  it("the workspace credential store does not import the operator store", () => {
    const wsStore = stripComments(
      readFileSync(join(HERE, "..", "..", "credentials", "store.ts"), "utf8"),
    );
    for (const spec of importSpecifiers(wsStore)) {
      expect(spec).not.toContain("operator-credentials");
    }
    expect(wsStore).not.toMatch(/operator_integration_credentials/);
  });
});

describe("behavioral isolation", () => {
  const mockRead: Mock<(platform: string) => Promise<Record<string, string> | null>> = mock(() =>
    Promise.resolve(null),
  );
  const mockHasInternalDB: Mock<() => boolean> = mock(() => true);

  mock.module("../store", () => ({ readOperatorCredentials: mockRead }));
  mock.module("@atlas/api/lib/db/internal", () => ({ hasInternalDB: mockHasInternalDB }));

  beforeEach(() => {
    mockRead.mockReset();
    mockHasInternalDB.mockReset();
    mockHasInternalDB.mockReturnValue(true);
  });
  afterEach(() => mockRead.mockReset());

  it("the operator overlay only carries operator-managed env keys, never a workspace secret", async () => {
    const { resolveOperatorAdapterEnv } = await import("../resolver");
    const { OPERATOR_PLATFORMS } = await import("../platforms");

    // Simulate a corrupt/over-broad DB row that ALSO contains a workspace
    // secret key. The resolver must only project the platform's declared
    // managed fields, dropping anything it doesn't own.
    mockRead.mockResolvedValue({
      SLACK_SIGNING_SECRET: "db-sign",
      WORKSPACE_TENANT_SECRET: "leaked-tenant-secret",
      DATABASE_URL: "postgres://should-not-leak",
    });

    const managedKeys = new Set(
      OPERATOR_PLATFORMS.flatMap((p) => p.fields.map((f) => f.envVar)),
    );
    const overlay = await resolveOperatorAdapterEnv(OPERATOR_PLATFORMS, {});

    for (const key of Object.keys(overlay)) {
      expect(managedKeys.has(key)).toBe(true);
    }
    expect(overlay).not.toHaveProperty("WORKSPACE_TENANT_SECRET");
    expect(overlay).not.toHaveProperty("DATABASE_URL");
    expect(overlay.SLACK_SIGNING_SECRET).toBe("db-sign");
  });
});
