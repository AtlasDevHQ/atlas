import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { EmbedErrorView, buildEmbedThemeForceScript, resolveEmbedTheme } from "../embed";

describe("resolveEmbedTheme", () => {
  test("resolves 'dark' and 'light' verbatim", () => {
    expect(resolveEmbedTheme("dark")).toBe("dark");
    expect(resolveEmbedTheme("light")).toBe("light");
  });

  test("returns undefined (follow visitor system) for empty/absent values without warning", () => {
    // No `?theme=` param → the embed follows the visitor's own system preference
    // rather than forcing a theme (#4686). Absence is expected, not an error.
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveEmbedTheme(undefined)).toBeUndefined();
    expect(resolveEmbedTheme("")).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("takes the first entry of a repeated query param", () => {
    expect(resolveEmbedTheme(["dark", "light"])).toBe("dark");
  });

  test("warns and follows the visitor system on an unrecognized value", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveEmbedTheme("neon")).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("buildEmbedThemeForceScript", () => {
  // The forced-theme override script pushes the resolved theme onto
  // `documentElement` so a `?theme=` param wins over the visitor's own
  // system/localStorage preference (the root theme-init would otherwise stamp it).
  test("toggles the .dark class to the forced boolean", () => {
    expect(buildEmbedThemeForceScript(true)).toContain('classList.toggle("dark",true)');
    expect(buildEmbedThemeForceScript(false)).toContain('classList.toggle("dark",false)');
  });

  test("is wrapped in a try/catch so a locked-down document can't throw", () => {
    expect(buildEmbedThemeForceScript(true)).toStartWith("try{");
    expect(buildEmbedThemeForceScript(true)).toContain("catch");
  });
});

describe("EmbedErrorView", () => {
  afterEach(cleanup);

  // Each fail reason maps to a distinct, navigation-free message. `expired` and
  // `not-found` are how a revoked link "kills the embed" — the AC path.
  const cases: Array<[Parameters<typeof EmbedErrorView>[0]["reason"], RegExp]> = [
    ["expired", /expired/i],
    ["not-found", /could not be found/i],
    ["auth-required", /organization/i],
    ["network-error", /reach Atlas/i],
    ["server-error", /Could not load/i],
  ];

  test.each(cases)("reason %s renders its message", (reason, matcher) => {
    render(<EmbedErrorView reason={reason} />);
    expect(screen.getByText(matcher)).toBeDefined();
    cleanup();
  });

  test("never renders a login/retry link inside the frame (partner-safe chrome)", () => {
    render(<EmbedErrorView reason="auth-required" />);
    // Only the 'Powered by Atlas' attribution anchor is allowed; no in-frame nav.
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("https://www.useatlas.dev");
  });
});
