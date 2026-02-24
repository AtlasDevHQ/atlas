FROM oven/bun:1.3 AS base

FROM base AS deps
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun ci --ignore-scripts

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun run build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN echo "nodejs:x:1001:" >> /etc/group && \
    echo "nextjs:x:1001:1001:nextjs:/app:/bin/sh" >> /etc/passwd
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
