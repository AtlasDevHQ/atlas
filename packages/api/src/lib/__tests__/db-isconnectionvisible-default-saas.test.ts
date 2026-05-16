/**
 * #2505 resolver-layer pair — when the agent (or any caller using the
 * `connectionId ?? "default"` fallback in `runUserQueryPipeline`) reaches
 * `isConnectionVisibleInMode("default", …)`, the result must follow the
 * deploy mode: self-hosted keeps the operator connection, SaaS refuses
 * the shared demo. Companion to `agent-saas-default-gate.test.ts`.
 */
import { describe, test, expect, mock } from "bun:test";

let mockConfigOverride: { deployMode?: "saas" | "self-hosted" } | null = null;

mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => mockConfigOverride,
  defineConfig: (c: unknown) => c,
}));

// `default` short-circuits BEFORE `hasInternalDB()` runs — no need to
// stub internal.ts. Tests that exercise non-default branches must mock
// every export of `@atlas/api/lib/db/internal` because partial module
// mocks throw SyntaxError when other consumers re-export symbols.
const { isConnectionVisibleInMode } = await import("@atlas/api/lib/db/connection");

describe("#2505 isConnectionVisibleInMode — default gating by deployMode", () => {
  test.each([
    ["saas", false],
    ["self-hosted", true],
  ] as const)(
    "deployMode=%s: `default` resolver gate returns %p",
    async (deployMode, expected) => {
      mockConfigOverride = { deployMode };
      const visible = await isConnectionVisibleInMode("org_abc", "default", "published");
      expect(visible).toBe(expected);
    },
  );

  test("null config (test default): `default` remains visible (self-hosted-like)", async () => {
    mockConfigOverride = null;
    const visible = await isConnectionVisibleInMode("org_abc", "default", "published");
    expect(visible).toBe(true);
  });

  test("SaaS gate is independent of mode (published or developer)", async () => {
    mockConfigOverride = { deployMode: "saas" };
    expect(await isConnectionVisibleInMode("org_abc", "default", "published")).toBe(false);
    expect(await isConnectionVisibleInMode("org_abc", "default", "developer")).toBe(false);
  });
});
