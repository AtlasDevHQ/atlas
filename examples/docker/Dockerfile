FROM oven/bun:1.3.10 AS base

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
COPY apps/www/package.json apps/www/package.json
COPY examples/nextjs-standalone/package.json examples/nextjs-standalone/package.json
# Plugins are workspace members — their package.json files must be
# present for the lockfile to validate during bun ci (--frozen-lockfile).
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

FROM base AS builder
WORKDIR /app
COPY --from=deps /app ./
COPY . .
COPY packages/cli/data/demo-semantic semantic

# --- nsjail build stage (parallel with builder) ---
ARG INSTALL_NSJAIL=true
FROM debian:trixie-slim AS nsjail-builder
ARG INSTALL_NSJAIL=true
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

FROM base AS runner
ARG INSTALL_NSJAIL=true
WORKDIR /app
ENV NODE_ENV=production
RUN echo "atlas:x:1001:" >> /etc/group && \
    echo "atlas:x:1001:1001:atlas:/app:/bin/sh" >> /etc/passwd
# Install nsjail runtime dependencies + Python for nsjail Python sandbox
RUN if [ "$INSTALL_NSJAIL" = "true" ]; then \
      apt-get update && apt-get install -y --no-install-recommends \
        libnl-route-3-200 libprotobuf32t64 \
        python3 python3-pip \
      && pip3 install --break-system-packages --no-cache-dir \
        pandas numpy matplotlib seaborn scipy scikit-learn \
      && rm -rf /var/lib/apt/lists/*; \
    fi
COPY --from=nsjail-builder /nsjail-out/ /usr/local/bin/
# Hono API server source + dependencies
COPY --from=builder --chown=atlas:atlas /app/packages/api ./packages/api
COPY --from=builder --chown=atlas:atlas /app/node_modules ./node_modules
COPY --from=builder --chown=atlas:atlas /app/semantic ./semantic
COPY --from=builder --chown=atlas:atlas /app/package.json ./package.json
COPY --chown=atlas:atlas examples/docker/scripts/start.sh ./scripts/start.sh
# Demo seeding (Railway "Atlas Demo" template — ATLAS_SEED_DEMO=true)
COPY --from=builder --chown=atlas:atlas /app/packages/cli/data/demo.sql ./data/demo.sql
COPY --chown=atlas:atlas examples/docker/scripts/seed-demo.ts ./scripts/seed-demo.ts
# pg is installed in packages/api/node_modules (not hoisted to root).
# seed-demo.ts runs from /app/scripts/ and needs pg — symlink it so
# bun's module resolution finds it from the root node_modules.
RUN ln -s /app/packages/api/node_modules/pg node_modules/pg 2>/dev/null; true
RUN chmod +x scripts/start.sh
USER atlas
EXPOSE 3001
ENV HOSTNAME=0.0.0.0
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD bun -e "try { const r = await fetch('http://localhost:' + (process.env.PORT || 3001) + '/api/health'); if(!r.ok){console.error(r.status); process.exit(1)} } catch(e) { console.error(e.message); process.exit(1) }"
CMD ["sh", "scripts/start.sh"]
