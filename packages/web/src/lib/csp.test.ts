import { describe, it, expect } from "bun:test";
import { buildCsp, isEmbedRoute, frameAncestorsFor } from "./csp";

/** Pull a single directive's value out of a built CSP string. */
function directive(csp: string, name: string): string | undefined {
  return csp
    .split("; ")
    .find((d) => d === name || d.startsWith(`${name} `))
    ?.slice(name.length)
    .trim();
}

describe("buildCsp", () => {
  const NONCE = "dGVzdC1ub25jZQ=="; // base64("test-nonce")

  it("script-src is nonce + strict-dynamic and NEVER contains 'unsafe-inline' (the #3899 acceptance criterion)", () => {
    const script = directive(buildCsp(NONCE, "'self'", "prod"), "script-src")!;
    expect(script).toContain(`'nonce-${NONCE}'`);
    expect(script).toContain("'strict-dynamic'");
    // The whole point: an injected inline <script> must not execute.
    expect(script).not.toContain("'unsafe-inline'");
  });

  it("'unsafe-eval' is dev-only — present in dev, absent in prod", () => {
    expect(directive(buildCsp(NONCE, "'self'", "dev"), "script-src")).toContain(
      "'unsafe-eval'",
    );
    // Production build needs no eval (Recharts draws via d3-shape, no codegen).
    expect(
      directive(buildCsp(NONCE, "'self'", "prod"), "script-src"),
    ).not.toContain("'unsafe-eval'");
  });

  it("frame-ancestors threads through: 'self' for the app shell, '*' for embeds", () => {
    expect(directive(buildCsp(NONCE, "'self'", "prod"), "frame-ancestors")).toBe(
      "'self'",
    );
    expect(directive(buildCsp(NONCE, "*", "prod"), "frame-ancestors")).toBe("*");
  });

  it("preserves the rest of the hardened directive set unchanged", () => {
    const csp = buildCsp(NONCE, "'self'", "prod");
    expect(directive(csp, "default-src")).toBe("'self'");
    expect(directive(csp, "object-src")).toBe("'none'");
    expect(directive(csp, "base-uri")).toBe("'self'");
    expect(directive(csp, "form-action")).toBe("'self'");
    // style-src intentionally keeps 'unsafe-inline' (Tailwind/Next critical CSS).
    expect(directive(csp, "style-src")).toBe("'self' 'unsafe-inline'");
  });

  it("style-src is unaffected by env (only script-src gains unsafe-eval)", () => {
    expect(directive(buildCsp(NONCE, "'self'", "dev"), "style-src")).toBe(
      "'self' 'unsafe-inline'",
    );
  });

  it("frame-src admits the Cloudflare Turnstile challenge iframe (#4159)", () => {
    // The signup Turnstile widget renders its challenge in an iframe from
    // challenges.cloudflare.com; without this host, `frame-src 'self'` blocks it
    // and the widget never renders (the button stays permanently disabled).
    const frame = directive(buildCsp(NONCE, "'self'", "prod"), "frame-src")!;
    expect(frame).toContain("'self'");
    expect(frame).toContain("https://challenges.cloudflare.com");
  });
});

describe("frameAncestorsFor", () => {
  it("widens to '*' ONLY on the embed sub-route (so customers can frame shared conversations)", () => {
    expect(frameAncestorsFor("/shared/abc123/embed")).toBe("*");
    expect(frameAncestorsFor("/shared/abc123/embed/")).toBe("*");
  });

  it("keeps 'self' for the app/admin shell — guards the clickjacking boundary (the security decision under test)", () => {
    // A regression returning "*" here would make every admin page embeddable
    // from any origin. This is the assertion that catches an inverted ternary.
    expect(frameAncestorsFor("/admin")).toBe("'self'");
    expect(frameAncestorsFor("/")).toBe("'self'");
    expect(frameAncestorsFor("/shared/abc123")).toBe("'self'");
    expect(frameAncestorsFor("/admin/abc123/embed")).toBe("'self'");
  });
});

describe("isEmbedRoute", () => {
  it("matches the embed view with and without a trailing slash", () => {
    expect(isEmbedRoute("/shared/abc123/embed")).toBe(true);
    expect(isEmbedRoute("/shared/abc123/embed/")).toBe(true);
  });

  it("does NOT match the shared conversation page itself (only the embed sub-route widens frame-ancestors)", () => {
    expect(isEmbedRoute("/shared/abc123")).toBe(false);
    expect(isEmbedRoute("/shared/abc123/")).toBe(false);
  });

  it("does not match deeper paths or token segments containing slashes", () => {
    expect(isEmbedRoute("/shared/abc123/embed/extra")).toBe(false);
    expect(isEmbedRoute("/shared/a/b/embed")).toBe(false);
  });

  it("does not match unrelated or look-alike routes (no frame-ancestors widening leak)", () => {
    expect(isEmbedRoute("/embed")).toBe(false);
    expect(isEmbedRoute("/admin")).toBe(false);
    expect(isEmbedRoute("/shared")).toBe(false);
    expect(isEmbedRoute("/admin/abc123/embed")).toBe(false);
  });
});
