# syntax=docker/dockerfile:1.7
#
# Docs site (docs.useatlas.dev). Build context: repo root (dockerfileContext "../..").
#
# apps/docs is a workspace MEMBER, not a standalone package: since #4371 it
# devDepends on @atlas/fumadocs-okf (workspace:*), which in turn depends on
# @atlas/okf-bundle (#4380). A single-package `bun install` over just apps/docs
# cannot resolve the `workspace:` protocol ("@atlas/fumadocs-okf@workspace:*
# failed to resolve") — the whole build fails. So we install from the workspace
# ROOT, mirroring deploy/api + deploy/web. The heavy install is confined to the
# throwaway builder stage; the runtime image stays the lean Caddy static server
# (the docs site has no DB/API runtime path — ~25 MB *resident*, per the runner
# note below).

FROM oven/bun:1.3.13@sha256:87416c977a612a204eb54ab9f3927023c2a3c971f4f345a01da08ea6262ae30e AS base

# --- deps ---
# Resolve the full workspace so apps/docs's @atlas/fumadocs-okf symlink links.
# Only package.json files are needed here (bun ci validates the whole lockfile,
# so every member must be present). `--ignore-scripts` because apps/docs's
# `postinstall: fumadocs-mdx` needs the app SOURCE (source.config.ts), which is
# copied in the builder stage below — the postinstall runs there.
FROM base AS deps
WORKDIR /app
COPY package.json bun.lock* ./
COPY packages/api/package.json packages/api/package.json
COPY packages/web/package.json packages/web/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/mcp/package.json packages/mcp/package.json
COPY packages/sandbox-sidecar/package.json packages/sandbox-sidecar/package.json
COPY packages/oauth-helper/package.json packages/oauth-helper/package.json
COPY packages/plugin-sdk/package.json packages/plugin-sdk/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/react/package.json packages/react/package.json
COPY packages/types/package.json packages/types/package.json
COPY packages/schemas/package.json packages/schemas/package.json
COPY packages/webhook-publisher/package.json packages/webhook-publisher/package.json
COPY packages/fumadocs-okf/package.json packages/fumadocs-okf/package.json
COPY packages/okf-bundle/package.json packages/okf-bundle/package.json
COPY apps/docs/package.json apps/docs/package.json
COPY apps/www/package.json apps/www/package.json
COPY examples/nextjs-standalone/package.json examples/nextjs-standalone/package.json
COPY examples/embedded-mcp-onboarding/package.json examples/embedded-mcp-onboarding/package.json
# Plugins are workspace members — their package.json files must be present for
# the lockfile to validate during bun ci (--frozen-lockfile).
COPY plugins/clickhouse/package.json plugins/clickhouse/package.json
COPY plugins/yaml-context/package.json plugins/yaml-context/package.json
COPY plugins/daytona/package.json plugins/daytona/package.json
COPY plugins/duckdb/package.json plugins/duckdb/package.json
COPY plugins/e2b/package.json plugins/e2b/package.json
COPY plugins/email/package.json plugins/email/package.json
COPY plugins/mcp/package.json plugins/mcp/package.json
COPY plugins/jira/package.json plugins/jira/package.json
COPY plugins/mysql/package.json plugins/mysql/package.json
COPY plugins/nsjail/package.json plugins/nsjail/package.json
COPY plugins/obsidian/package.json plugins/obsidian/package.json
COPY plugins/obsidian-reader/package.json plugins/obsidian-reader/package.json
COPY plugins/sidecar/package.json plugins/sidecar/package.json
COPY plugins/snowflake/package.json plugins/snowflake/package.json
COPY plugins/salesforce/package.json plugins/salesforce/package.json
COPY plugins/elasticsearch/package.json plugins/elasticsearch/package.json
COPY plugins/vercel-sandbox/package.json plugins/vercel-sandbox/package.json
COPY plugins/railway-sandbox/package.json plugins/railway-sandbox/package.json
COPY plugins/bigquery/package.json plugins/bigquery/package.json
COPY plugins/chat/package.json plugins/chat/package.json
COPY plugins/webhook/package.json plugins/webhook/package.json
COPY plugins/webhook-action/package.json plugins/webhook-action/package.json
COPY plugins/teams/package.json plugins/teams/package.json
COPY plugins/email-digest/package.json plugins/email-digest/package.json
COPY plugins/twenty/package.json plugins/twenty/package.json
COPY create-atlas-plugin/package.json create-atlas-plugin/package.json
COPY ee/package.json ee/package.json
RUN bun ci --ignore-scripts

# --- Build ---
FROM base AS builder
WORKDIR /app

# GITHUB_TOKEN powers the "Last updated on …" timestamp on every docs page
# via fumadocs' getGithubLastEdit (apps/docs/src/app/(docs)/[[...slug]]/page.tsx).
# Without it the build hits unauthenticated GitHub API, rate-limits after ~60
# pages, and the silent catch swallows every failure (issue #2103). Railway
# auto-passes the service variable as a build arg only when ARG declares it.
# Self-hosted operators can omit this — the canary below skips when unset.
ARG GITHUB_TOKEN
ENV GITHUB_TOKEN=$GITHUB_TOKEN

# node_modules (workspace symlinks + resolved deps) from the deps stage.
COPY --from=deps /app ./
# Docs app + its workspace-dep sources (the @atlas/fumadocs-okf → @atlas/okf-bundle
# symlink targets) + the shared brand token file. globals.css imports
# ../../brand.css, which resolves through apps/docs/brand.css (a symlink to the
# repo-root brand.css); in Docker the symlink target must exist, so copy the real
# file to /app/brand.css.
COPY apps/docs apps/docs
COPY packages/fumadocs-okf packages/fumadocs-okf
COPY packages/okf-bundle packages/okf-bundle
COPY brand.css ./brand.css
COPY scripts/check-docs-canary.sh /usr/local/bin/check-docs-canary.sh
RUN chmod +x /usr/local/bin/check-docs-canary.sh
# fumadocs-mdx postinstall (generates .source/ from source.config.ts — skipped in
# the deps stage), then the static export, then the canary.
RUN cd apps/docs && bun run postinstall && bun run build && /usr/local/bin/check-docs-canary.sh

# --- Runtime ---
# Caddy serves the static out/ tree built above. The docs site has no
# runtime data path (no DB, no API), so retiring the Node server drops
# resident memory from ~900 MB (the Next.js MDX heap) to ~25 MB (Caddy
# + page cache), which is what was costing $10/mo on Railway.
FROM caddy:2.10-alpine AS runner

COPY deploy/docs/Caddyfile /etc/caddy/Caddyfile
COPY --from=builder /app/apps/docs/out /srv

# Pre-compress static assets so Caddy (file_server precompressed in
# Caddyfile) serves the .gz/.zst sidecars without recompressing on every
# request. curl is for HEALTHCHECK — BusyBox wget can't refuse redirects,
# so a future redirect rule accidentally catching / would mask brokenness.
RUN apk add --no-cache curl zstd findutils \
  && find /srv \( -name '*.html' -o -name '*.css' -o -name '*.js' \
                  -o -name '*.json' -o -name '*.svg' -o -name '*.xml' \
                  -o -name '*.txt' -o -name '*.md' \) \
       -size +1k \
       -exec gzip -9 -k {} + \
       -exec zstd -q -19 -k {} +

EXPOSE 3003
ENV PORT=3003

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS --max-redirs 0 -o /dev/null http://localhost:${PORT}/ || exit 1

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
