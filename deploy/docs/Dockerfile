FROM oven/bun:1.3.10 AS base

# --- Install ---
FROM base AS deps
WORKDIR /app
COPY apps/docs/package.json ./
COPY bun.lock* ./
RUN bun install

# --- Build ---
# Maintain repo path structure so fumadocs lastModified plugin can resolve git history
FROM base AS builder
RUN apt-get update -qq && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY .git .git
COPY apps/docs/ apps/docs/
COPY brand.css brand.css
COPY --from=deps /app/node_modules apps/docs/node_modules
WORKDIR /repo/apps/docs
RUN bun run build

# --- Runtime ---
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=builder --chown=1001:1000 /repo/apps/docs/.next/standalone ./
COPY --from=builder --chown=1001:1000 /repo/apps/docs/.next/static ./.next/static

USER 1001
EXPOSE 3003
ENV PORT=3003
ENV HOSTNAME="0.0.0.0"

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3003/docs || exit 1

CMD ["bun", "server.js"]
