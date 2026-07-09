import { describe, it, expect } from "bun:test";
import { isCrossOriginApi } from "./cross-origin-api";

const env = (v: string | undefined) =>
  ({ NEXT_PUBLIC_ATLAS_API_URL: v, NODE_ENV: "test" }) as NodeJS.ProcessEnv;

describe("isCrossOriginApi", () => {
  it("is true when NEXT_PUBLIC_ATLAS_API_URL is a non-empty origin (SaaS app↔api split)", () => {
    expect(isCrossOriginApi(env("https://api-eu.useatlas.dev"))).toBe(true);
  });

  it("is false when the var is unset (self-hosted same-origin via Next rewrites)", () => {
    expect(isCrossOriginApi(env(undefined))).toBe(false);
  });

  it("treats a blank / whitespace value as same-origin (not cross-origin)", () => {
    expect(isCrossOriginApi(env(""))).toBe(false);
    expect(isCrossOriginApi(env("   "))).toBe(false);
  });
});
