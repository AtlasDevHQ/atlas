# syntax=docker/dockerfile:1.7

FROM oven/bun:1.3.13@sha256:87416c977a612a204eb54ab9f3927023c2a3c971f4f345a01da08ea6262ae30e AS base

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

COPY apps/docs/ ./
COPY bun.lock* ./
# globals.css imports ../../brand.css (resolves to project root via symlink in
# the monorepo). In Docker the symlink target doesn't exist, so copy the real file.
COPY brand.css ./brand.css
COPY scripts/check-docs-canary.sh /usr/local/bin/check-docs-canary.sh
RUN chmod +x /usr/local/bin/check-docs-canary.sh
RUN bun install
RUN bun run build && /usr/local/bin/check-docs-canary.sh

# --- Runtime ---
# Caddy serves the static out/ tree built above. The docs site has no
# runtime data path (no DB, no API), so retiring the Node server drops
# resident memory from ~900 MB (the Next.js MDX heap) to ~25 MB (Caddy
# + page cache), which is what was costing $10/mo on Railway.
FROM caddy:2.10-alpine AS runner

COPY deploy/docs/Caddyfile /etc/caddy/Caddyfile
COPY --from=builder /app/out /srv

# Pre-compress static assets so Caddy serves .gz/.zst sidecars without
# re-compressing on every request. Trades container build time for
# runtime CPU + bandwidth.
RUN apk add --no-cache zstd findutils \
  && find /srv \( -name '*.html' -o -name '*.css' -o -name '*.js' \
                  -o -name '*.json' -o -name '*.svg' -o -name '*.xml' \
                  -o -name '*.txt' -o -name '*.md' \) \
       -size +1k \
       -exec gzip -9 -k {} + \
       -exec zstd -q -19 -k {} +

EXPOSE 3003
ENV PORT=3003

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://localhost:${PORT}/ || exit 1

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
