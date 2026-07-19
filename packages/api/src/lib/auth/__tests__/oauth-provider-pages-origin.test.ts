/**
 * Regression (MCP consent 404): the OAuth 2.1 provider's `loginPage`,
 * `consentPage`, and `postLogin.page` MUST be absolute against the web-app
 * origin whenever the API and web app live on different hosts (SaaS:
 * api.useatlas.dev vs app.useatlas.dev; local dev: :3001 vs :3000).
 *
 * Better Auth's oauthProvider uses these values verbatim as the 302
 * `Location`. A browser resolves a relative path (`/login`) against the
 * *response* origin — the API — so a bare "/login" 404s on the API host. This
 * only bit a fresh MCP flow (no session, `prompt=consent`): a returning user
 * with a live session + prior consent skips both pages, which is why it hid
 * for so long. Same cross-origin trap `rewriteVerificationCallbackURL` fixes
 * for email links.
 *
 * The paired combined-origin assertion (getWebOrigin() → null, e.g. the
 * nextjs-standalone deploy where the API serves the web app on its own origin)
 * guards the inverse: the relative path must survive there, so a "just always
 * prefix" edit that broke the single-origin deploy would flip it.
 */

import { describe, it, expect, mock } from "bun:test";

// getWebOrigin is web-origin.ts's only export — mock it whole so a partial
// mock can't surface as a cross-file SyntaxError under bun's parallel workers.
// buildPlugins() reads getWebOrigin() at call time (not import time), so
// flipping `webOrigin` between cases is enough — no per-case remock needed.
let webOrigin: string | null = "https://app.useatlas.dev";
void mock.module("@atlas/api/lib/web-origin", () => ({
  getWebOrigin: () => webOrigin,
}));

const { buildPlugins } = await import("../server");

type OAuthProviderOptions = {
  loginPage?: string;
  consentPage?: string;
  postLogin?: { page?: string };
};

function oauthProviderOptions(): OAuthProviderOptions {
  const plugin = (buildPlugins() as Array<{ id?: string; options?: unknown }>).find(
    (p) => p?.id === "oauth-provider",
  );
  expect(plugin, "oauth-provider plugin must be registered").toBeDefined();
  return (plugin as { options: OAuthProviderOptions }).options;
}

describe("oauthProvider login/consent page origin", () => {
  it("pins pages to the web origin when API and web are different hosts", () => {
    webOrigin = "https://app.useatlas.dev";
    const opts = oauthProviderOptions();
    expect(opts.loginPage).toBe("https://app.useatlas.dev/login");
    expect(opts.consentPage).toBe("https://app.useatlas.dev/oauth2/consent");
    expect(opts.postLogin?.page).toBe("https://app.useatlas.dev/oauth2/post-login");
  });

  it("falls back to relative paths on a combined-origin deploy (getWebOrigin null)", () => {
    webOrigin = null;
    const opts = oauthProviderOptions();
    expect(opts.loginPage).toBe("/login");
    expect(opts.consentPage).toBe("/oauth2/consent");
    expect(opts.postLogin?.page).toBe("/oauth2/post-login");
  });
});
