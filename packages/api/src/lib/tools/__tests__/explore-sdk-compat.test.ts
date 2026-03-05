/**
 * Compile-time drift guard: Plugin SDK <-> API explore types.
 *
 * Verifies that PluginExecResult is structurally identical to ExecResult and
 * PluginExploreBackend is structurally identical to ExploreBackend. If either
 * side adds a new required field without updating the other, the type-level
 * assertions will fail at compile time.
 *
 * Both types are defined in this file to avoid a cross-package import
 * (@atlas/api does not depend on @useatlas/plugin-sdk by design).
 */
import { describe, test, expect } from "bun:test";
import type { ExecResult, ExploreBackend } from "../explore";

// Structural mirrors of the plugin SDK types — kept in sync manually.
// If the SDK types change, update these mirrors AND the type assertions below.
interface SDKExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface SDKExploreBackend {
  exec(command: string): Promise<SDKExecResult>;
  close?(): Promise<void>;
}

describe("explore SDK compatibility — structural drift guard", () => {
  test("ExecResult and SDK mirror have identical shape", () => {
    // Forward: SDK -> API
    const sdk: SDKExecResult = { stdout: "out", stderr: "", exitCode: 0 };
    const _api: ExecResult = sdk;
    expect(_api.stdout).toBe("out");

    // Backward: API -> SDK
    const api: ExecResult = { stdout: "data", stderr: "warn", exitCode: 1 };
    const _sdk: SDKExecResult = api;
    expect(_sdk.exitCode).toBe(1);
  });

  test("ExploreBackend and SDK mirror have identical shape", () => {
    // Forward: SDK -> API
    const sdk: SDKExploreBackend = {
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    };
    const _api: ExploreBackend = sdk;
    expect(typeof _api.exec).toBe("function");

    // Backward: API -> SDK
    const api: ExploreBackend = {
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      close: async () => {},
    };
    const _sdk: SDKExploreBackend = api;
    expect(typeof _sdk.close).toBe("function");
  });

  // Type-level assertions — fail at compile time if shapes diverge
  test("type-level: SDKExecResult extends ExecResult", () => {
    type Check = SDKExecResult extends ExecResult ? true : false;
    const _: Check = true;
    expect(_).toBe(true);
  });

  test("type-level: ExecResult extends SDKExecResult", () => {
    type Check = ExecResult extends SDKExecResult ? true : false;
    const _: Check = true;
    expect(_).toBe(true);
  });

  test("type-level: SDKExploreBackend extends ExploreBackend", () => {
    type Check = SDKExploreBackend extends ExploreBackend ? true : false;
    const _: Check = true;
    expect(_).toBe(true);
  });

  test("type-level: ExploreBackend extends SDKExploreBackend", () => {
    type Check = ExploreBackend extends SDKExploreBackend ? true : false;
    const _: Check = true;
    expect(_).toBe(true);
  });
});
