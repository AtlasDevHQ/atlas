/**
 * The Atlas OpenAPI source registry (#4410) — the safety valve the agent-auth
 * adapter's "zero capabilities is safe when the spec is unavailable" argument
 * rests on. These pin the fail-soft branches: no source registered → `null`,
 * a source that throws → `null` (never a re-throw that would crash the
 * auth-instance build), plus memoization and re-registration cache-clear.
 *
 * Self-contained: each test resets the module registry via the test-only reset.
 */

import { describe, it, expect, afterEach } from "bun:test";
import {
  registerAtlasOpenApiSource,
  getAtlasOpenApiSpec,
  __resetAtlasOpenApiSourceForTest,
  type AtlasOpenApiSpec,
} from "@atlas/api/lib/auth/atlas-openapi-source";

const SPEC = { info: { title: "Atlas API" }, paths: {} } satisfies AtlasOpenApiSpec;

describe("atlas-openapi-source registry (#4410)", () => {
  afterEach(() => __resetAtlasOpenApiSourceForTest());

  it("returns null (fail-soft) when no source is registered", () => {
    __resetAtlasOpenApiSourceForTest();
    expect(getAtlasOpenApiSpec()).toBeNull();
  });

  it("returns the registered document and generates it at most once (memoized)", () => {
    let calls = 0;
    registerAtlasOpenApiSource(() => {
      calls += 1;
      return SPEC;
    });
    expect(getAtlasOpenApiSpec()).toBe(SPEC);
    expect(getAtlasOpenApiSpec()).toBe(SPEC);
    expect(calls).toBe(1); // memoized — the ~2.5MB build runs once
  });

  it("fails SOFT to null (never re-throws) when the source throws", () => {
    registerAtlasOpenApiSource(() => {
      throw new Error("boom: spec generation failed");
    });
    // Must not throw — a spec-generation failure degrades to zero capabilities,
    // it does not crash the auth-instance build.
    expect(getAtlasOpenApiSpec()).toBeNull();
  });

  it("re-registration clears the memoized document", () => {
    const first = { info: { title: "first" }, paths: {} } satisfies AtlasOpenApiSpec;
    const second = { info: { title: "second" }, paths: {} } satisfies AtlasOpenApiSpec;
    registerAtlasOpenApiSource(() => first);
    expect(getAtlasOpenApiSpec()).toBe(first);
    registerAtlasOpenApiSource(() => second);
    expect(getAtlasOpenApiSpec()).toBe(second);
  });
});
