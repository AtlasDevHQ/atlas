# Atlas API — Hono standalone server + nsjail sandbox
# AtlasDevHQ infrastructure (api.useatlas.dev)
#
# Build context: repo root (../../)
#   docker build -f deploy/api/Dockerfile .

FROM oven/bun:1.3.13@sha256:87416c977a612a204eb54ab9f3927023c2a3c971f4f345a01da08ea6262ae30e AS base

# --- manifests ---
# Just the workspace manifests + lockfile. Two different installs are made from
# this stage (see `deps` and `prod-deps` below); keeping the ~40 COPY lines in
# one place stops them drifting apart, and lets BuildKit run both installs
# concurrently off the same cached layer.
FROM base AS manifests
WORKDIR /app
COPY package.json bun.lock* ./
# Both patches (patchedDependencies in package.json/bun.lock) must be present in
# the build context for `bun ci` to apply them during install. A missing patch
# file is a hard install error, so pruning this COPY fails the build loudly —
# but don't: unlike `bun-types`, the `@chat-adapter/slack` patch is runtime
# load-bearing (multi-workspace Slack @-mention detection, #4911).
COPY patches patches
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

# --- deps (BUILD-time closure) ---
# The full workspace install. The builder stage needs it: tsup, the bundlers and
# every workspace's devDependencies are what `bun run build` uses to produce the
# dist/ outputs. This tree is NOT what ships — see prod-deps.
FROM manifests AS deps
RUN bun ci --ignore-scripts

# --- prod-deps (RUN-time closure) ---
# What actually ships in the runner. `bun ci` above installs the ENTIRE
# monorepo — web, docs, www, examples and all 20+ plugins — because a root
# install has no notion of which workspace the image is for. The api runtime
# needs a small fraction of that, and the rest was still being copied into the
# runtime stage: 2094 packages shipped against ~773 needed, and with them the
# large majority of the image's npm CVE surface, all of it in code the api
# never loads (#4880).
#
# `--filter` still resolves the `workspace:` protocol from the root, so the
# single-package-install blocker documented in deploy/docs/Dockerfile:5-13 does
# NOT apply here. `--frozen-lockfile` holds bun.lock byte-identical.
#
# The filter list is the set of workspaces this image LOADS, and must stay in
# lockstep with `plugins[]` in deploy/api/atlas.config.ts — same lockstep the
# symlink-rebuild block in the runner already demands. @useatlas/chat, e2b,
# daytona and twenty need no entry: they are @atlas/api dependencies, so the
# filter pulls them in transitively. The four adapter plugins below are not —
# they declare no dependencies at all, only peers (@clickhouse/client,
# snowflake-sdk, @useatlas/plugin-sdk). Naming them makes this tree correct on
# its own terms: their plugins/<p>/node_modules are populated here rather than
# being inherited from the full-install copy the runner takes from `builder`.
# Measured: adding the four costs zero extra packages.
FROM manifests AS prod-deps
RUN bun install --frozen-lockfile --ignore-scripts --production \
      --filter='@atlas/api' \
      --filter='@useatlas/clickhouse' \
      --filter='@useatlas/snowflake' \
      --filter='@useatlas/bigquery' \
      --filter='@useatlas/elasticsearch'
# Build tooling that survives the production filter, because it enters as an
# OPTIONAL PEER of better-auth (`drizzle-kit: ">=0.31.4"`) rather than as
# anyone's devDependency — so neither --production nor --filter drops it.
#   - esbuild + @esbuild/linux-x64: Trivy reports the vendored Go stdlib inside
#     the platform binary, which alone accounted for 106 of the image's 199 npm
#     findings and all 3 criticals. Three versions are resolved; none is
#     reachable from any runtime import.
#   - drizzle-kit (+ @drizzle-team/brocli, its CLI framework): generates the
#     migration SQL from schema.ts at DEVELOPMENT time. The runtime migration
#     path is the hand-rolled runMigrations in lib/db/migrate.ts, and schema.ts
#     has no runtime importer at all. drizzle-ORM stays — it is a real
#     dependency of schema.ts.
#   - tsx + @esbuild-kit/*: an esbuild-based TS loader. Nothing execs it; bun
#     runs TypeScript directly.
# assert-runtime-imports.ts in the runner is what proves none of this is
# reachable from shipped source.
RUN rm -rf node_modules/.bun/esbuild@* \
           node_modules/.bun/@esbuild+* \
           node_modules/.bun/@esbuild-kit+* \
           node_modules/.bun/drizzle-kit@* \
           node_modules/.bun/@drizzle-team+brocli@* \
           node_modules/.bun/tsx@*

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
# PostgreSQL 18 client tools — the backup engine (ee/src/backups, #4457)
# spawns `pg_dump`/`psql`, and the client major must be >= the PG 18 internal
# DBs (pg_dump refuses a newer server major). The base image's Debian ships an
# older postgresql-client, so pin PGDG's postgresql-client-18.
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates gnupg \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg \
    && . /etc/os-release \
    && echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] http://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update && apt-get install -y --no-install-recommends postgresql-client-18 \
    && rm -rf /var/lib/apt/lists/*
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
# Dependency store — from prod-deps, NOT builder: the runtime closure, not the
# build one. Everything above this line copies workspace SOURCE (plus, for the
# workspaces that have them, the full install's node_modules symlinks). Those
# links stay valid because bun's isolated store slugs — including the peer-
# resolution hash suffix — are identical between the two installs: every slug
# in the scoped store is present verbatim in the full one. Links to packages
# the production filter dropped are left dangling on purpose; that is the
# pruning. assert-runtime-imports.ts below proves nothing shipped still needs
# one of them.
COPY --from=prod-deps --chown=atlas:atlas /app/node_modules ./node_modules
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
# Build-time assertion (#4880): STATIC half. Every bare import in the shipped
# source must resolve against the shipped node_modules. The runtime stage
# installs a production closure, so a package imported from runtime source but
# declared in `devDependencies` simply is not here — and because bun resolves
# lazily that is not a boot failure, it is a module-not-found thrown whenever
# some route or scheduler tick first reaches the import. Three packages were
# already in that state when this landed (@effect/sql, @effect/sql-pg and
# drizzle-orm, all imported by lib/db/*). Catch the next one at build time.
COPY --chown=atlas:atlas deploy/api/scripts/assert-runtime-imports.ts ./scripts/assert-runtime-imports.ts
RUN bun /app/scripts/assert-runtime-imports.ts /app
# Build-time assertion (#4880): DYNAMIC half. The static sweep proves the
# packages are on disk; it cannot prove the workspace symlink layout actually
# resolves, which is the failure mode every defensive block above was written
# about. So really load the boot graph. Each plugin import is run from the
# plugin's own directory because that is where its @useatlas/plugin-sdk peer
# resolves from, and the three package imports are run from packages/api
# because that is the context api/index.ts imports them in — there is no root
# node_modules/@atlas for them to resolve through.
# `set -e` plus brace groups, not `|| ( … && exit 1 )`: `exit` inside a subshell
# only leaves the subshell, so a failing early iteration would be masked by a
# later one succeeding and the RUN would exit 0.
RUN set -e; \
    for p in chat clickhouse snowflake bigquery elasticsearch; do \
      (cd /app/plugins/$p && bun -e "await import('/app/plugins/$p/src/index');") \
        || { echo "ERROR: boot-loaded plugin '$p' failed to import — its dependency or its @useatlas/plugin-sdk peer does not resolve in the shipped tree (#4880). Keep the prod-deps --filter list in lockstep with plugins[] in atlas.config.ts." >&2; exit 1; }; \
    done; \
    (cd /app/packages/api && bun -e "await import('@atlas/mcp/hosted'); await import('@useatlas/webhook-publisher'); await import('@atlas/okf-bundle/wire');") \
      || { echo "ERROR: a runtime dynamic-import target failed to resolve (#4880) — @atlas/mcp/hosted backs /mcp/{workspace_id}/sse, @useatlas/webhook-publisher backs the scheduler tick + EE SLA alerter, @atlas/okf-bundle/wire backs knowledge ingest. The bun error above names which." >&2; exit 1; }
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
