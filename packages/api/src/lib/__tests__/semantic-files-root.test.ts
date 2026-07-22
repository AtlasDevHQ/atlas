/**
 * Tests for getSemanticRoot() in semantic-files.ts.
 *
 * Verifies the canonical semantic root resolution function respects
 * ATLAS_SEMANTIC_ROOT, rejects empty values, and resolves relative paths.
 */

import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getSemanticRoot } from "../semantic/files";

/**
 * The test preload points `ATLAS_SEMANTIC_ROOT` at a per-process sandbox
 * (#4655). Restore that value rather than deleting the var, or every suite
 * that runs after this one writes org YAML into the checkout again.
 */
const SANDBOX_ROOT = process.env.ATLAS_SEMANTIC_ROOT;

function restoreSandboxRoot(): void {
  if (SANDBOX_ROOT === undefined) delete process.env.ATLAS_SEMANTIC_ROOT;
  else process.env.ATLAS_SEMANTIC_ROOT = SANDBOX_ROOT;
}

afterEach(restoreSandboxRoot);

describe("getSemanticRoot", () => {
  it("defaults to cwd/semantic when env var is not set", () => {
    delete process.env.ATLAS_SEMANTIC_ROOT;
    expect(getSemanticRoot()).toBe(path.resolve(process.cwd(), "semantic"));
  });

  it("respects ATLAS_SEMANTIC_ROOT when set to an absolute path", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-root-"));
    try {
      process.env.ATLAS_SEMANTIC_ROOT = tmpDir;
      expect(getSemanticRoot()).toBe(tmpDir);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("resolves a relative ATLAS_SEMANTIC_ROOT against cwd", () => {
    process.env.ATLAS_SEMANTIC_ROOT = "custom/semantic";
    expect(getSemanticRoot()).toBe(path.resolve(process.cwd(), "custom/semantic"));
  });

  it("throws when ATLAS_SEMANTIC_ROOT is set to an empty string", () => {
    process.env.ATLAS_SEMANTIC_ROOT = "";
    expect(() => getSemanticRoot()).toThrow("ATLAS_SEMANTIC_ROOT is set but empty");
  });
});
