FROM oven/bun:1.3.11-debian AS base

# Install tools needed for explore mode + Python for executePython
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    coreutils \
    grep \
    findutils \
    tree \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Install data science libraries (user code may use these)
RUN pip3 install --no-cache-dir --break-system-packages \
    pandas \
    numpy \
    matplotlib \
    scipy \
    scikit-learn \
    statsmodels

# Use existing nobody user (65534) — don't create a new one, the base image has it
# Fall back to creating if not present (shouldn't happen with debian-based images)
RUN id -u nobody >/dev/null 2>&1 || useradd -r -s /bin/false -u 65534 -g 65534 sandbox

WORKDIR /app

# Copy sidecar source
COPY packages/sandbox-sidecar/package.json ./
COPY packages/sandbox-sidecar/src/ ./src/

# Semantic layer — baked in from demo data (matches other Railway services).
# For custom datasets, rebuild with a volume mount or replace semantic/ in CI.
COPY packages/cli/data/demo-semantic/ /semantic/
RUN chmod -R a-w /semantic/

# No secrets, no database drivers, no node_modules beyond bun runtime
EXPOSE 8080
ENV PORT=8080
ENV SEMANTIC_DIR=/semantic

USER nobody

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD bun -e "try { const r = await fetch('http://localhost:' + (process.env.PORT || 8080) + '/health'); if(!r.ok){console.error(r.status); process.exit(1)} } catch(e) { console.error(e.message); process.exit(1) }"

CMD ["bun", "run", "src/server.ts"]
