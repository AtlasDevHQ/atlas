/**
 * `signOutForgettingRegion` — every sign-out must forget the `atlas_region`
 * routing hint so a stale region can't pin the next sign-in on this browser
 * (ADR-0024 §3, #4090).
 *
 * Real cookie effects against happy-dom's `document.cookie` (the same surface
 * `clearRegionSignal` writes), so the test pins the actual observable: the
 * cookie is gone, cleared BEFORE the sign-out round-trip and regardless of
 * whether it succeeds.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { signOutForgettingRegion } from "../sign-out";
import { REGION_COOKIE } from "@/lib/api-url";

/** True iff a non-empty `atlas_region` cookie is present. */
function hasRegionCookie(): boolean {
  return document.cookie
    .split("; ")
    .some((c) => c.startsWith(`${REGION_COOKIE}=`) && c !== `${REGION_COOKIE}=`);
}

/** Seed the cookie a previous (now signed-out) regional session would leave. */
function seedRegionCookie(): void {
  const value = encodeURIComponent(JSON.stringify({ region: "eu", apiUrl: "https://api-eu.useatlas.dev" }));
  document.cookie = `${REGION_COOKIE}=${value}; path=/`;
}

describe("signOutForgettingRegion", () => {
  beforeEach(() => {
    document.cookie = `${REGION_COOKIE}=; path=/; max-age=0`;
  });

  it("clears the atlas_region cookie BEFORE delegating to signOut", async () => {
    seedRegionCookie();
    expect(hasRegionCookie()).toBe(true);

    let presentDuringSignOut: boolean | null = null;
    await signOutForgettingRegion(async () => {
      presentDuringSignOut = hasRegionCookie();
      return { data: { success: true }, error: null };
    });

    // Forgotten before the request ran — not after, so the hint can't survive a
    // signOut that hangs or the page navigating away mid-flight.
    expect(presentDuringSignOut).toBe(false);
    expect(hasRegionCookie()).toBe(false);
  });

  it("returns the wrapped signOut's result untouched", async () => {
    const result = await signOutForgettingRegion(async () => ({
      data: null,
      error: { message: "server said no" },
    }));
    expect(result).toEqual({ data: null, error: { message: "server said no" } });
  });

  it("still clears the cookie when signOut rejects (transport failure)", async () => {
    seedRegionCookie();
    await expect(
      signOutForgettingRegion(async () => {
        throw new Error("API unreachable");
      }),
    ).rejects.toThrow("API unreachable");
    // The client-only hint is gone regardless of the server round-trip.
    expect(hasRegionCookie()).toBe(false);
  });
});
