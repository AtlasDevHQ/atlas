FROM oven/bun:1.3.11@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7 AS base

# Install only the tools needed for explore mode
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash coreutils grep findutils tree \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -r -s /bin/false sandbox || true

WORKDIR /app

# Copy sidecar source (root directory = sidecar/)
COPY server.ts ./server.ts

# Create semantic directory — populated at runtime or via volume mount
RUN mkdir -p /semantic && chmod a+r /semantic

# Keep this image minimal — adding packages or env vars weakens the isolation model

# No secrets, no database drivers, no node_modules beyond bun runtime
EXPOSE 8080
ENV PORT=8080
ENV SEMANTIC_DIR=/semantic

USER sandbox

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD bun -e "try { const r = await fetch('http://localhost:' + (process.env.PORT || 8080) + '/health'); if(!r.ok){console.error(r.status); process.exit(1)} } catch(e) { console.error(e.message); process.exit(1) }"

CMD ["bun", "run", "server.ts"]
