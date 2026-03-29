FROM oven/bun:1.3.11 AS base

# --- Build ---
FROM base AS builder
WORKDIR /app
COPY apps/docs/ ./
COPY bun.lock* ./
# brand.css is @imported as ../../../../brand.css from src/app/globals.css,
# resolving to the monorepo root. In Docker the project root is /app, so the
# import escapes the project. Copy brand.css into the project and rewrite the
# relative import so it resolves within the build context.
COPY brand.css ./brand.css
RUN sed -i 's|../../../../brand.css|../../brand.css|' src/app/globals.css
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
