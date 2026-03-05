FROM oven/bun:1.3.10-debian AS base

# Install only the tools needed for explore mode
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    coreutils \
    grep \
    findutils \
    tree \
    && rm -rf /var/lib/apt/lists/*

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

# Keep this image minimal — adding packages or env vars weakens the isolation model

# No secrets, no database drivers, no node_modules beyond bun runtime
EXPOSE 8080
ENV PORT=8080
ENV SEMANTIC_DIR=/semantic

USER nobody

CMD ["bun", "run", "src/server.ts"]
