FROM oven/bun:1.3.10 AS base

FROM base AS deps
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun ci --ignore-scripts

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN mkdir -p semantic && bun run build

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
RUN echo "nodejs:x:1001:" >> /etc/group && \
    echo "nextjs:x:1001:1001:nextjs:/app:/bin/sh" >> /etc/passwd
# Install nsjail runtime dependencies (when nsjail is enabled)
RUN if [ "$INSTALL_NSJAIL" = "true" ]; then \
      apt-get update && apt-get install -y --no-install-recommends \
        libnl-route-3-200 libprotobuf32t64 \
      && rm -rf /var/lib/apt/lists/*; \
    fi
COPY --from=nsjail-builder /nsjail-out/ /usr/local/bin/
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/semantic ./semantic
USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD bun -e "try { const r = await fetch('http://localhost:3000/api/health'); if(!r.ok){console.error(r.status); process.exit(1)} } catch(e) { console.error(e.message); process.exit(1) }"
CMD ["bun", "server.js"]
