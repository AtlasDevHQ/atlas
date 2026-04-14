# Atlas Web — Next.js query UI + admin console
# AtlasDevHQ infrastructure (app.useatlas.dev)
#
# Build context: repo root (../../)
#   docker build -f deploy/web/Dockerfile .

FROM oven/bun:1.3.11@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7 AS base

# --- deps ---
FROM base AS deps
WORKDIR /app
COPY package.json bun.lock* ./
COPY packages/api/package.json packages/api/package.json
COPY packages/web/package.json packages/web/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/mcp/package.json packages/mcp/package.json
COPY packages/sandbox-sidecar/package.json packages/sandbox-sidecar/package.json
COPY packages/plugin-sdk/package.json packages/plugin-sdk/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/react/package.json packages/react/package.json
COPY packages/types/package.json packages/types/package.json
COPY apps/docs/package.json apps/docs/package.json
COPY apps/www/package.json apps/www/package.json
COPY examples/nextjs-standalone/package.json examples/nextjs-standalone/package.json
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
COPY plugins/sidecar/package.json plugins/sidecar/package.json
COPY plugins/slack/package.json plugins/slack/package.json
COPY plugins/snowflake/package.json plugins/snowflake/package.json
COPY plugins/salesforce/package.json plugins/salesforce/package.json
COPY plugins/vercel-sandbox/package.json plugins/vercel-sandbox/package.json
COPY plugins/bigquery/package.json plugins/bigquery/package.json
COPY plugins/chat/package.json plugins/chat/package.json
COPY plugins/webhook/package.json plugins/webhook/package.json
COPY plugins/teams/package.json plugins/teams/package.json
COPY plugins/email-digest/package.json plugins/email-digest/package.json
COPY create-atlas-plugin/package.json create-atlas-plugin/package.json
COPY ee/package.json ee/package.json
RUN bun ci --ignore-scripts

# --- builder ---
FROM base AS builder
WORKDIR /app
COPY --from=deps /app ./
COPY . .
# Build workspace deps whose exports point to dist/ before the Next.js app
RUN cd packages/types && bun run build
RUN cd packages/react && bun run build
# Bake build-time env vars into the client JS bundle
ENV NEXT_PUBLIC_ATLAS_API_URL=https://api.useatlas.dev
ENV NEXT_PUBLIC_ATLAS_AUTH_MODE=managed
RUN cd packages/web && bun run build

# --- runner ---
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN echo "atlas:x:1001:" >> /etc/group && \
    echo "atlas:x:1001:1001:atlas:/app:/bin/sh" >> /etc/passwd
# Next.js standalone output (includes server.js + traced node_modules)
COPY --from=builder --chown=atlas:atlas /app/packages/web/.next/standalone ./
# Static assets (not included in standalone output)
COPY --from=builder --chown=atlas:atlas /app/packages/web/.next/static ./packages/web/.next/static
COPY --from=builder --chown=atlas:atlas /app/packages/web/public ./packages/web/public
USER atlas
ENV HOSTNAME=0.0.0.0
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD bun -e "try { const r = await fetch('http://localhost:3000/'); if(!r.ok){console.error(r.status); process.exit(1)} } catch(e) { console.error(e.message); process.exit(1) }"
CMD ["bun", "packages/web/server.js"]
