import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Vercel uses its own build pipeline — no `output: "standalone"` needed
  serverExternalPackages: ["pg", "mysql2", "@clickhouse/client", "@duckdb/node-api", "snowflake-sdk", "jsforce", "just-bash", "nodemailer", "pino", "pino-pretty", "stripe"],
  // Workspace-published TS plugins that are statically imported from ee/src/ —
  // Turbopack would otherwise fail to compile their raw .ts source from node_modules.
  transpilePackages: ["@useatlas/twenty"],
  // Type checking is handled by `bun run type` (tsgo); skip during Next.js build
  typescript: { ignoreBuildErrors: true },
  // Security headers — mirrors packages/web/next.config.ts so scaffolded
  // projects ship hardened by default. Customising guidance lives in
  // apps/docs/content/docs/security/security-headers.mdx.
  //
  // - HSTS pins HTTPS for a year. `preload` advertises eligibility; submission
  //   is a separate operator decision.
  // - CSP is intentionally generous on connect-src/img-src because self-hosted
  //   deployments may point at any datasource host or load avatars from
  //   arbitrary origins. The strict bits — frame-ancestors, object-src,
  //   base-uri, form-action — are the ones that block real attack vectors.
  // - `script-src` keeps `'unsafe-inline'` because Next.js inlines hydration
  //   data; `'unsafe-eval'` is included for libraries like Recharts that JIT
  //   chart paths. Operators on a strict-CSP build can fork this list.
  //
  // The `/shared/:token/embed` route inherits everything except frame-ancestors,
  // which it overrides to `*` so customers can embed shared conversations.
  // Browsers ignore X-Frame-Options when CSP `frame-ancestors` is present, so
  // setting both globally is safe — the embed override wins where it matches.
  //
  // The `headers()` function below is the canonical security-header policy.
  // It is mirrored byte-for-byte into the scaffold next.config.ts files —
  // see `scripts/check-security-headers-drift.sh`, which fails CI on drift.
  // SECURITY-HEADERS-START
  async headers() {
    // In dev, Turbopack serves `/_next/static/*` chunks under STABLE (unhashed)
    // filenames, so the production `immutable` policy below would pin the
    // browser to stale chunks across recompiles — broken HMR, and source edits
    // that silently never reach the running page. Guard it: dev revalidates,
    // prod keeps `immutable`. `next build` / `next start` set NODE_ENV to
    // "production"; `next dev` does not.
    const isDev = process.env.NODE_ENV !== "production";
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://challenges.cloudflare.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "connect-src 'self' https: wss:",
      "frame-src 'self' https://challenges.cloudflare.com",
      "frame-ancestors 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
      "worker-src 'self' blob:",
    ].join("; ");

    // The embed CSP is the global CSP with `frame-ancestors` widened to `*`.
    // The `csp.replace(...)` is brittle: if the global directive
    // `frame-ancestors 'self'` is reworded or reordered, this becomes a silent
    // no-op and the embed regresses to the global frame-ancestors. The runtime
    // check fails the Next build if that happens. Computed once and shared by
    // every embed route below so the conversation and dashboard embeds can never
    // drift apart.
    const embedCsp = (() => {
      const replaced = csp.replace(
        "frame-ancestors 'self'",
        "frame-ancestors *",
      );
      if (replaced === csp) {
        throw new Error(
          "next.config.ts: embed CSP override no-op'd — `frame-ancestors 'self'` not found in global CSP. Update the replace() target.",
        );
      }
      return replaced;
    })();

    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains; preload",
          },
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
      {
        // Shared-conversation embed view must remain framable from any origin.
        // CSP frame-ancestors takes precedence over X-Frame-Options per the W3C
        // CSP spec, so the global X-Frame-Options DENY is harmlessly ignored on
        // this path.
        source: "/shared/:token/embed",
        headers: [{ key: "Content-Security-Policy", value: embedCsp }],
      },
      {
        // Shared-dashboard embed view — same any-origin framing posture as the
        // conversation embed above (decided 2026-07-10; the embed is a frame
        // around the shared dashboard view, never a second sharing surface).
        source: "/shared/dashboard/:token/embed",
        headers: [{ key: "Content-Security-Policy", value: embedCsp }],
      },
      {
        // App shell HTML (issue #2488): force revalidation so a new deploy
        // invalidates the bundle on the next navigation. The negative lookahead
        // excludes `/_next/static/*` (handled below) and `/api/*` (the Hono API
        // owns its own Cache-Control on each route). Path-to-regexp lookahead
        // anchors at position 0, so this only excludes paths *beginning with*
        // `_next/static` or `api/` — not paths that merely contain them.
        source: "/((?!_next/static|api/).*)",
        headers: [
          {
            key: "Cache-Control",
            value: "no-cache, must-revalidate",
          },
        ],
      },
      {
        // Hashed asset URLs (`/_next/static/chunks/foo-<hash>.js`) are
        // content-addressed and safe to cache forever in production. Next.js
        // sets this by default for files it serves directly, but declaring it
        // explicitly here keeps the policy stable regardless of how the
        // standalone server is wrapped (Railway, Docker, reverse proxies).
        // In dev the filenames are stable but the content is not, so revalidate
        // instead of pinning `immutable` (see `isDev` at the top of headers()).
        source: "/_next/static/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: isDev
              ? "no-cache"
              : "public, max-age=31536000, immutable",
          },
        ],
      },
    ];
  },
  // SECURITY-HEADERS-END
};

export default nextConfig;
