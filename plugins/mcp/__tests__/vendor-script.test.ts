/**
 * Pin the vendor pipeline's failure surface — a missing canonical
 * source must surface a clear, actionable error rather than producing
 * a partially-populated `_oauth-helper/` directory.
 *
 * The script runs against an isolated tree (canonical source under a
 * different path the script doesn't know about) so the assertion is
 * about the script's own diagnostics, not about disturbing the real
 * `packages/oauth-helper/src/` (which other tests depend on being
 * present).
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(
  new URL("../scripts/vendor-oauth-helper.sh", import.meta.url),
);

describe("vendor-oauth-helper.sh", () => {
  it("exits 1 with an actionable message when the canonical source is missing", () => {
    // Build a minimal monorepo shape (`<root>/plugins/mcp/scripts/...`)
    // that points at a NON-EXISTENT `<root>/packages/oauth-helper/src`.
    // Copy the real script into the fake tree and run it from there so
    // its `REPO_ROOT="$PLUGIN_ROOT/../.."` resolution lands inside the
    // tmp tree, not inside the real monorepo.
    const root = mkdtempSync(join(tmpdir(), "atlas-vendor-test-"));
    try {
      const fakeScriptDir = join(root, "plugins", "mcp", "scripts");
      mkdirSync(fakeScriptDir, { recursive: true });
      const fakeScript = join(fakeScriptDir, "vendor-oauth-helper.sh");
      // Read + write rather than `cp` so we don't rely on Bun.cp shape.
      const content = require("node:fs").readFileSync(SCRIPT, "utf8");
      writeFileSync(fakeScript, content, { mode: 0o755 });
      // Note: NO `packages/oauth-helper/src` in the fake tree.

      const result = spawnSync("bash", [fakeScript], {
        encoding: "utf8",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("source missing at");
      expect(result.stderr).toContain("bun install");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
