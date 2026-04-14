FROM oven/bun:1.3.11@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7 AS base

# --- Build ---
FROM base AS builder
WORKDIR /app
COPY apps/docs/ ./
COPY bun.lock* ./
# globals.css imports ../../brand.css (resolves to project root via symlink in
# the monorepo). In Docker the symlink target doesn't exist, so copy the real file.
COPY brand.css ./brand.css
RUN bun install
RUN bun run build

# --- Runtime ---
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN groupadd --system --gid 1001 atlas && \
    useradd --system --uid 1001 --gid atlas atlas

COPY --from=builder --chown=atlas:atlas /app/.next/standalone ./
COPY --from=builder --chown=atlas:atlas /app/.next/static ./.next/static

USER atlas
EXPOSE 3003
ENV PORT=3003
ENV HOSTNAME="0.0.0.0"

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:3003/').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["bun", "server.js"]
