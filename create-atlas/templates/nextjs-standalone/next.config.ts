import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Vercel uses its own build pipeline — no `output: "standalone"` needed
  serverExternalPackages: ["pg", "mysql2", "@clickhouse/client", "@duckdb/node-api", "snowflake-sdk", "jsforce", "just-bash", "pino", "pino-pretty", "stripe"],
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
  async headers() {
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "connect-src 'self' https: wss:",
      "frame-src 'self'",
      "frame-ancestors 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
      "worker-src 'self' blob:",
    ].join("; ");

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
        // Embed view must remain framable from any origin. CSP frame-ancestors
        // takes precedence over X-Frame-Options per the W3C CSP spec, so the
        // global X-Frame-Options DENY is harmlessly ignored on this path.
        //
        // The `csp.replace(...)` below is brittle: if the global directive
        // `frame-ancestors 'self'` is reworded or reordered, this becomes a
        // silent no-op and the embed regresses to the global frame-ancestors.
        // The runtime check below fails the Next build if that happens.
        source: "/shared/:token/embed",
        headers: [
          {
            key: "Content-Security-Policy",
            value: (() => {
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
            })(),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
