FROM oven/bun:1.3.11 AS base

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

CMD ["bun", "run", "server.ts"]
