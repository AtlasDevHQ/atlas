# Atlas API — Hono standalone server + nsjail sandbox
# AtlasDevHQ infrastructure (api.useatlas.dev)
#
# Build context: repo root (../../)
#   docker build -f deploy/api/Dockerfile .

FROM oven/bun:1.3.13@sha256:87416c977a612a204eb54ab9f3927023c2a3c971f4f345a01da08ea6262ae30e AS base

# --- deps ---
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

# --- builder ---
FROM base AS builder
WORKDIR /app
COPY --from=deps /app ./
COPY . .
COPY packages/cli/data/seeds/ecommerce/semantic semantic
# Build workspace deps whose exports point to dist/ in dependency order:
# types → sdk → react. packages/react imports fetchStarterPrompts from
# @useatlas/sdk, so sdk must be built before react's bundler resolves it.
# plugin-sdk's package.json exports also point to ./dist/index.js — it must
# be built so @useatlas/chat's transitive `import "@useatlas/plugin-sdk"`
# resolves at boot (atlas.config.ts loads ./plugins/chat/src/index, which
# imports plugin-sdk). Added in #2608 / slice 1 of #2607 when the chat
# plugin first started being loaded by the SaaS config.
RUN cd packages/types && bun run build
RUN cd packages/sdk && bun run build
RUN cd packages/plugin-sdk && bun run build
RUN cd packages/react && bun run build
# @useatlas/webhook-publisher's package.json exports also point to ./dist/index.js.
# The API loads it at boot via the sub-processor publisher (scheduler tick) and
# the EE SLA alerter, so its dist must exist or module resolution ENOENTs at
# runtime. It has no @useatlas deps, so its build order in this group is free.
RUN cd packages/webhook-publisher && bun run build

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
# Shared wire-format Zod schemas (imported by API route handlers)
COPY --from=builder --chown=atlas:atlas /app/packages/schemas ./packages/schemas
# Plugin SDK — workspace symlink target for any plugin's peerDep.
# `plugins/chat/node_modules/@useatlas/plugin-sdk` resolves to this path
# via the relative symlink `../../../../packages/plugin-sdk`. Without
# this COPY, atlas.config.ts's `import "./plugins/chat/src/index"`
# transitively loads the chat plugin's `@useatlas/plugin-sdk` import
# and ENOENTs at boot, hard-failing the SaaS deploy. Added in #2608
# (slice 1 of #2607) when atlas.config.ts started importing chatPlugin.
COPY --from=builder --chown=atlas:atlas /app/packages/plugin-sdk ./packages/plugin-sdk
# @useatlas/webhook-publisher — workspace symlink target for the API's
# sub-processor publisher + the EE SLA alerter (both import it). Its
# package.json exports point to ./dist (built in the builder stage above);
# without this COPY the node_modules/@useatlas/webhook-publisher symlink
# dangles and the first scheduler tick / SLA alert ENOENTs at runtime.
COPY --from=builder --chown=atlas:atlas /app/packages/webhook-publisher ./packages/webhook-publisher
# Widget bundle — built from @useatlas/react (referenced by widget route)
COPY --from=builder --chown=atlas:atlas /app/packages/react/dist ./packages/react/dist
# OKF wire contract + bundle core — the api's ingest parsers import
# @atlas/okf-bundle/wire at runtime (#4373); without this COPY the
# node_modules/@atlas/okf-bundle workspace symlink dangles and the first
# knowledge ingest / mirror touch ENOENTs.
COPY --from=builder --chown=atlas:atlas /app/packages/okf-bundle ./packages/okf-bundle
# Hono API server source + dependencies
COPY --from=builder --chown=atlas:atlas /app/packages/api ./packages/api
# packages/mcp is the hosted-MCP edge — `api/index.ts` does
# `import("@atlas/mcp/hosted")` at boot, and the workspace symlink
# in node_modules/@atlas/mcp resolves to /app/packages/mcp at
# runtime. Without this COPY, the dynamic import ENOENTs and every
# request to /mcp/{workspace_id}/sse 404s with the Hono default
# (no route registered). The pre-fix catch logged at debug level,
# which prod Pino filters — so the breakage was invisible. See
# packages/api/src/api/index.ts:482 for the mount + the (now
# error-level) catch.
COPY --from=builder --chown=atlas:atlas /app/packages/mcp ./packages/mcp
COPY --from=builder --chown=atlas:atlas /app/node_modules ./node_modules
COPY --from=builder --chown=atlas:atlas /app/semantic ./semantic
COPY --from=builder --chown=atlas:atlas /app/package.json ./package.json
# Enterprise features (loaded conditionally at runtime)
COPY --from=builder --chown=atlas:atlas /app/ee ./ee
# Plugins (loaded at runtime by the plugin system)
COPY --from=builder --chown=atlas:atlas /app/plugins ./plugins
# Defensive symlink rebuild: bun ci in the deps stage creates
# `plugins/<p>/node_modules/@useatlas/{plugin-sdk,types}` as relative
# workspace symlinks, but the multi-stage COPY chain isn't reliably
# preserving them for every Docker driver. Recreate explicitly so
# atlas.config.ts's transitive loads of `./plugins/<p>/src/index` can
# resolve each plugin's `@useatlas/plugin-sdk` peerDep at boot regardless
# of upstream COPY-symlink behavior. The `-f` flag overwrites any
# pre-existing (possibly dangling) symlink that survived the COPY.
#
# `chat` is the interaction plugin (#2608); clickhouse/salesforce/snowflake/
# bigquery/elasticsearch are the datasource ADAPTER plugins atlas.config.ts
# loads at boot (#3253 / ADR-0013). Keep that subset in lockstep with the
# plugins[] array in atlas.config.ts — a boot-loaded plugin missing here
# ENOENTs its plugin-sdk import and hard-fails the API boot.
#
# `e2b` + `daytona` are the BYOC sandbox runtimes (#3409): not boot-loaded,
# but lazily imported by lib/sandbox/runtime.ts when probed / engaged. A
# dangling plugin-sdk symlink there doesn't fail boot — it makes the probe
# misreport the provider as "not installed", silently turning the card
# Unavailable. Keep this pair in lockstep with @atlas/api's
# @useatlas/{e2b,daytona} workspace deps.
RUN for p in chat clickhouse salesforce snowflake bigquery elasticsearch e2b daytona; do \
      mkdir -p /app/plugins/$p/node_modules/@useatlas && \
      ln -sfn /app/packages/plugin-sdk /app/plugins/$p/node_modules/@useatlas/plugin-sdk && \
      ln -sfn /app/packages/types /app/plugins/$p/node_modules/@useatlas/types; \
    done
# BYOC sandbox SDK symlinks (#3409). The e2b/daytona plugins lazily
# require their provider SDK from their own directory; bun's isolated
# installer satisfies that with a plugins/<p>/node_modules/<sdk> symlink
# into the central store, but (same caveat as above) the COPY chain isn't
# guaranteed to preserve it. Recreate against the stable
# packages/api/node_modules paths (the SDKs are optionalDependencies of
# @atlas/api — the @vercel/sandbox pattern).
RUN ln -sfn /app/packages/api/node_modules/e2b /app/plugins/e2b/node_modules/e2b && \
    mkdir -p /app/plugins/daytona/node_modules/@daytonaio && \
    ln -sfn /app/packages/api/node_modules/@daytonaio/sdk /app/plugins/daytona/node_modules/@daytonaio/sdk
# Build-time assertion (#3409): run the real BYOC availability probe
# (lib/sandbox/runtime.ts getProviderRuntimeAvailability — the same code
# path /api/v1/admin/sandbox/status serves) and require it to report
# EXACTLY the shipped provider set. The module list is derived from
# PROVIDER_RUNTIMES at build time, so there is no hand-copied list to
# drift; the expected map below is the machine-checked statement of the
# provider-set decision — railway: false documents the deliberate
# deferral (no deny-all egress mode; see #3368/#3409), and a future
# provider added to PROVIDER_RUNTIMES fails this build until the map is
# consciously updated. A regression here doesn't fail boot — it silently
# flips the /admin/sandbox cards to "Unavailable" — so fail the build
# loudly instead. The two plugin-context requires assert the SDK
# symlinks above: the plugins lazily require their SDK from their own
# directory, which the api-context probe can't see.
RUN bun -e "const { getProviderRuntimeAvailability } = await import('/app/packages/api/src/lib/sandbox/runtime.ts'); const got = await getProviderRuntimeAvailability(); const want = { vercel: true, e2b: true, daytona: true, railway: false }; const wantKeys = Object.keys(want).sort().join(','), gotKeys = Object.keys(got).sort().join(','); if (gotKeys !== wantKeys) throw new Error('BYOC provider set changed (' + gotKeys + ' vs expected ' + wantKeys + ') — decide whether the new provider ships in this image, then update the expected map in deploy/api/Dockerfile'); for (const p of Object.keys(want)) if (got[p] !== want[p]) throw new Error('BYOC runtime availability for ' + p + ': got ' + got[p] + ', expected ' + want[p]);" \
    && cd /app/plugins/e2b && bun -e "require('e2b');" \
    && cd /app/plugins/daytona && bun -e "require('@daytonaio/sdk');" \
    || (echo "ERROR: BYOC sandbox runtime assertion failed — the bun error above names the provider/module; shipping anyway would silently flip its /admin/sandbox card to Unavailable (#3409)" >&2 && exit 1)
# Demo seeding (ATLAS_SEED_DEMO=true) — single canonical seed since 1.4.0 (#2021)
COPY --from=builder --chown=atlas:atlas /app/packages/cli/data/seeds/ecommerce/seed.sql ./data/demo.sql
COPY --chown=atlas:atlas examples/docker/scripts/seed-demo.ts ./scripts/seed-demo.ts
# Profile-aware seed gate (#2937): start.sh shells out to this to resolve
# ATLAS_SEED_DEMO through the env-profile. It imports env-profile by RELATIVE
# path (../packages/api/src/lib/env-profile) because a script under /app/scripts/
# is outside the @atlas/api package and there is no node_modules/@atlas/api to
# resolve here; env-profile is dependency-free so the relative import is
# self-contained. The build-time assertion below proves it resolves.
COPY --chown=atlas:atlas examples/docker/scripts/resolve-seed-demo.ts ./scripts/resolve-seed-demo.ts
COPY --chown=atlas:atlas deploy/api/atlas.config.ts ./atlas.config.ts
COPY --chown=atlas:atlas deploy/api/scripts/start.sh ./scripts/start.sh
# Build-time assertion: canonical seed must be non-empty and the bundled
# semantic layer must contain entities. Catches a regressed COPY at build
# time rather than booting against an empty DB. (#2021 review-pass)
RUN test -s ./data/demo.sql || (echo "ERROR: ./data/demo.sql is empty or missing" >&2 && exit 1)
RUN test -d ./semantic/entities && [ "$(ls -A ./semantic/entities 2>/dev/null)" ] || (echo "ERROR: ./semantic/entities is missing or empty" >&2 && exit 1)
# Build-time assertion (#2937): the profile-aware seed shim must resolve its
# @atlas/api/lib/env-profile import in the image layout and print a clean
# boolean. Run WITHOUT redirecting stderr so a broken import (exports-map drift,
# a regressed COPY, a moved module) fails the build loudly here — otherwise
# start.sh's `2>/dev/null` would silently degrade the seed gate to the legacy
# raw check forever, with no log line anywhere.
RUN out="$(bun /app/scripts/resolve-seed-demo.ts)"; [ "$out" = "true" ] || [ "$out" = "false" ] || (echo "ERROR: resolve-seed-demo.ts did not print a clean boolean: [$out]" >&2 && exit 1)
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
