# Atlas Web — Next.js query UI + admin console
# AtlasDevHQ infrastructure (app.useatlas.dev)
#
# Build context: repo root (../../)
#   docker build -f deploy/web/Dockerfile .

FROM oven/bun:1.3.10 AS base

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
COPY apps/docs/package.json apps/docs/package.json
COPY apps/www/package.json apps/www/package.json
COPY examples/nextjs-standalone/package.json examples/nextjs-standalone/package.json
COPY plugins/clickhouse-datasource/package.json plugins/clickhouse-datasource/package.json
COPY plugins/yaml-context/package.json plugins/yaml-context/package.json
COPY plugins/daytona-sandbox/package.json plugins/daytona-sandbox/package.json
COPY plugins/duckdb-datasource/package.json plugins/duckdb-datasource/package.json
COPY plugins/e2b-sandbox/package.json plugins/e2b-sandbox/package.json
COPY plugins/email-action/package.json plugins/email-action/package.json
COPY plugins/mcp-interaction/package.json plugins/mcp-interaction/package.json
COPY plugins/jira-action/package.json plugins/jira-action/package.json
COPY plugins/mysql-datasource/package.json plugins/mysql-datasource/package.json
COPY plugins/nsjail-sandbox/package.json plugins/nsjail-sandbox/package.json
COPY plugins/sidecar-sandbox/package.json plugins/sidecar-sandbox/package.json
COPY plugins/slack-interaction/package.json plugins/slack-interaction/package.json
COPY plugins/snowflake-datasource/package.json plugins/snowflake-datasource/package.json
COPY plugins/salesforce-datasource/package.json plugins/salesforce-datasource/package.json
COPY plugins/vercel-sandbox/package.json plugins/vercel-sandbox/package.json
RUN bun ci --ignore-scripts

# --- builder ---
FROM base AS builder
WORKDIR /app
COPY --from=deps /app ./
COPY . .
# Bake the API URL into the client JS bundle at build time
ENV NEXT_PUBLIC_ATLAS_API_URL=https://api.useatlas.dev
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
CMD ["bun", "packages/web/server.js"]
