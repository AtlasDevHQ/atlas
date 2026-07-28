/**
 * Legacy model-id canonicalization (#4869 review).
 *
 * `canonicalizeModel` had ZERO tests in either direction — before or after
 * #4870 changed what it does. That matters because the behavior change is
 * deliberate and easy to "fix" back by accident:
 *
 *   BEFORE: the map did two jobs — hyphen→slash+dot FORMAT canonicalization,
 *           AND a version ROLL-FORWARD (`claude-opus-4-6` → opus-4.8) that
 *           existed only because the picker had three hardcoded rows and a
 *           deprecated version had nowhere to land (#3076).
 *   AFTER:  format only. The picker lists the live catalog, so every version
 *           has its own real row, and relabelling a workspace's configured 4.6
 *           as "4.8" would misreport what the agent actually runs.
 *
 * The roll-forward removal is the whole point of the change, so it gets a test
 * that fails if someone reinstates it.
 */

import { describe, expect, test } from "bun:test";
import type { GatewayCatalogModel } from "@/ui/lib/types";
import { canonicalizeModel, modelLabel } from "../page";

function model(overrides: Partial<GatewayCatalogModel> = {}): GatewayCatalogModel {
  return {
    id: "anthropic/claude-opus-4.6",
    name: "Claude Opus 4.6",
    provider: "anthropic",
    type: "language",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputPrice: null,
    outputPrice: null,
    recommended: false,
    supportsTools: true,
    ...overrides,
  };
}

describe("canonicalizeModel", () => {
  test("rewrites the legacy hyphen format onto the gateway's slash+dot id", () => {
    expect(canonicalizeModel("claude-haiku-4-5")).toBe("anthropic/claude-haiku-4.5");
    expect(canonicalizeModel("claude-sonnet-4-6")).toBe("anthropic/claude-sonnet-4.6");
    expect(canonicalizeModel("claude-opus-4-6")).toBe("anthropic/claude-opus-4.6");
    expect(canonicalizeModel("claude-opus-4-7")).toBe("anthropic/claude-opus-4.7");
  });

  test("does NOT roll a deprecated version forward to the current flagship", () => {
    // The regression guard. Each legacy id maps to its OWN version — a
    // workspace configured for Opus 4.6 must not be told it is running 4.8.
    expect(canonicalizeModel("claude-opus-4-6")).not.toBe("anthropic/claude-opus-4.8");
    expect(canonicalizeModel("claude-opus-4-7")).not.toBe("anthropic/claude-opus-4.8");
    expect(canonicalizeModel("claude-sonnet-4-6")).not.toBe("anthropic/claude-sonnet-5");
  });

  test("passes an already-canonical gateway id through untouched", () => {
    expect(canonicalizeModel("anthropic/claude-opus-5")).toBe("anthropic/claude-opus-5");
    expect(canonicalizeModel("zai/glm-5.2")).toBe("zai/glm-5.2");
  });

  test("passes an unrecognized id through rather than guessing", () => {
    expect(canonicalizeModel("some-model-we-have-never-seen")).toBe(
      "some-model-we-have-never-seen",
    );
    expect(canonicalizeModel("")).toBe("");
  });
});

describe("modelLabel", () => {
  test("resolves a display name through the alias map", () => {
    expect(modelLabel("claude-opus-4-6", [model()])).toBe("Claude Opus 4.6");
  });

  test("falls back to the canonical ID rather than inventing a name", () => {
    // A retired version a workspace is still pinned to. Showing the raw ID is
    // the honest answer; the picker separately flags it as missing.
    expect(modelLabel("anthropic/claude-opus-4.1", [model()])).toBe("anthropic/claude-opus-4.1");
  });

  test("falls back to the canonicalized form, not the raw legacy input", () => {
    // Even with an empty catalog the hyphen form is normalized, so the operator
    // sees the id the gateway would actually accept.
    expect(modelLabel("claude-opus-4-6", [])).toBe("anthropic/claude-opus-4.6");
  });
});
