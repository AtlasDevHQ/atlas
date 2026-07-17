import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { EmbedErrorView, resolveEmbedTheme } from "../embed";

describe("resolveEmbedTheme", () => {
  test("resolves 'dark' and 'light' verbatim", () => {
    expect(resolveEmbedTheme("dark")).toBe("dark");
    expect(resolveEmbedTheme("light")).toBe("light");
  });

  test("defaults to 'light' for empty/absent values without warning", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveEmbedTheme(undefined)).toBe("light");
    expect(resolveEmbedTheme("")).toBe("light");
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("takes the first entry of a repeated query param", () => {
    expect(resolveEmbedTheme(["dark", "light"])).toBe("dark");
  });

  test("warns and falls back to 'light' on an unrecognized value", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveEmbedTheme("neon")).toBe("light");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("EmbedErrorView", () => {
  afterEach(cleanup);

  // Each fail reason maps to a distinct, navigation-free message. `expired` and
  // `not-found` are how a revoked link "kills the embed" — the AC path.
  const cases: Array<[Parameters<typeof EmbedErrorView>[0]["reason"], RegExp]> = [
    ["expired", /expired/i],
    ["not-found", /could not be found/i],
    // #4690: 401 vs 403 keep distinct copy — the wrong-org viewer isn't told to sign in.
    ["login-required", /sign in to atlas/i],
    ["membership-required", /not a member/i],
    ["network-error", /reach Atlas/i],
    ["server-error", /Could not load/i],
  ];

  test.each(cases)("reason %s renders its message", (reason, matcher) => {
    render(<EmbedErrorView reason={reason} />);
    expect(screen.getByText(matcher)).toBeDefined();
    cleanup();
  });

  // Both auth reasons must stay navigation-free — `login-required` is the one most
  // likely to tempt a future edit into adding an in-frame "Sign in" CTA (#4690).
  test.each(["login-required", "membership-required"] as const)(
    "reason %s never renders a login/retry link inside the frame (partner-safe chrome)",
    (reason) => {
      render(<EmbedErrorView reason={reason} />);
      // Only the 'Powered by Atlas' attribution anchor is allowed; no in-frame nav.
      const links = screen.getAllByRole("link");
      expect(links).toHaveLength(1);
      expect(links[0]?.getAttribute("href")).toBe("https://www.useatlas.dev");
      cleanup();
    },
  );
});
