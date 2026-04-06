# Atlas API — Hono standalone server + nsjail sandbox
# AtlasDevHQ infrastructure (api.useatlas.dev)
#
# Build context: repo root (../../)
#   docker build -f deploy/api/Dockerfile .

FROM oven/bun:1.3.11 AS base

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
# Plugins are workspace members — their package.json files must be
# present for the lockfile to validate during bun ci (--frozen-lockfile).
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
COPY packages/cli/data/demo-semantic semantic
COPY packages/cli/data/cybersec-semantic data/cybersec-semantic
COPY packages/cli/data/ecommerce-semantic data/ecommerce-semantic
# Build @useatlas/types first (exports point to dist/) then the react widget bundle
RUN cd packages/types && bun run build
RUN cd packages/react && bun run build

# --- nsjail build stage (parallel with builder) ---
ARG INSTALL_NSJAIL=false
FROM debian:trixie-slim AS nsjail-builder
ARG INSTALL_NSJAIL=false
RUN mkdir -p /nsjail-out && \
    if [ "$INSTALL_NSJAIL" = "true" ]; then \
      apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates autoconf bison flex gcc g++ git make pkg-config \
        protobuf-compiler libprotobuf-dev libnl-route-3-dev libtool \
      && rm -rf /var/lib/apt/lists/* \
      && git clone --depth 1 --branch 3.4 https://github.com/google/nsjail.git /nsjail-src \
      && cd /nsjail-src && make -j$(nproc) \
      && cp /nsjail-src/nsjail /nsjail-out/nsjail; \
    fi

# --- runner ---
FROM base AS runner
ARG INSTALL_NSJAIL=false
WORKDIR /app
ENV NODE_ENV=production
RUN echo "atlas:x:1001:" >> /etc/group && \
    echo "atlas:x:1001:1001:atlas:/app:/bin/sh" >> /etc/passwd
# Install nsjail runtime dependencies (when nsjail is enabled)
RUN if [ "$INSTALL_NSJAIL" = "true" ]; then \
      apt-get update && apt-get install -y --no-install-recommends \
        libnl-route-3-200 libprotobuf32t64 \
      && rm -rf /var/lib/apt/lists/*; \
    fi
COPY --from=nsjail-builder /nsjail-out/ /usr/local/bin/
# Shared types (workspace symlink target — needed at runtime by API + plugins)
COPY --from=builder --chown=atlas:atlas /app/packages/types ./packages/types
# Widget bundle — built from @useatlas/react (referenced by widget route)
COPY --from=builder --chown=atlas:atlas /app/packages/react/dist ./packages/react/dist
# Hono API server source + dependencies
COPY --from=builder --chown=atlas:atlas /app/packages/api ./packages/api
COPY --from=builder --chown=atlas:atlas /app/node_modules ./node_modules
COPY --from=builder --chown=atlas:atlas /app/semantic ./semantic
COPY --from=builder --chown=atlas:atlas /app/package.json ./package.json
# Enterprise features (loaded conditionally at runtime)
COPY --from=builder --chown=atlas:atlas /app/ee ./ee
# Plugins (loaded at runtime by the plugin system)
COPY --from=builder --chown=atlas:atlas /app/plugins ./plugins
# Demo seeding (ATLAS_SEED_DEMO=true) — all three datasets coexist in the same DB
COPY --from=builder --chown=atlas:atlas /app/packages/cli/data/demo.sql ./data/demo.sql
COPY --from=builder --chown=atlas:atlas /app/packages/cli/data/cybersec.sql ./data/cybersec.sql
COPY --from=builder --chown=atlas:atlas /app/packages/cli/data/ecommerce.sql ./data/ecommerce.sql
COPY --chown=atlas:atlas examples/docker/scripts/seed-demo.ts ./scripts/seed-demo.ts
COPY --chown=atlas:atlas deploy/api/atlas.config.ts ./atlas.config.ts
COPY --chown=atlas:atlas deploy/api/scripts/start.sh ./scripts/start.sh
# pg is installed in packages/api/node_modules (not hoisted to root).
# seed-demo.ts runs from /app/scripts/ and needs pg — symlink it so
# bun's module resolution finds it from the root node_modules.
RUN ln -s /app/packages/api/node_modules/pg node_modules/pg 2>/dev/null; true
RUN chmod +x scripts/start.sh
USER atlas
EXPOSE 3001
ENV HOSTNAME=0.0.0.0
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=5 \
  CMD bun -e "try { const r = await fetch('http://localhost:' + (process.env.PORT || 3001) + '/api/health'); if(!r.ok){console.error(r.status); process.exit(1)} } catch(e) { console.error(e.message); process.exit(1) }"
CMD ["sh", "scripts/start.sh"]
