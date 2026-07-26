## Part G: Deployment Compliance — MEDIUM

### G1. Dockerfile Consistency

| Check | What to Verify |
|-------|----------------|
| Bun version pinned | All Dockerfiles use exact same `oven/bun:X.Y.Z` version matching CI `BUN_VERSION` |
| Non-root user | Final stage runs as non-root (atlas:atlas or similar) |
| Health check | `HEALTHCHECK` instruction present, hits `/api/health` |
| No secrets baked in | No `ENV` or `ARG` with real credentials |
| Multi-stage build | Deps/build stages separated from runtime stage |

```
Check all Dockerfiles: examples/docker/Dockerfile
Grep for: oven/bun: — verify version matches
Grep for: USER — verify non-root
Grep for: HEALTHCHECK — verify present
```

---

### G2. Environment Variable Hygiene

| Check | What to Verify |
|-------|----------------|
| `.env` not committed | `.gitignore` includes `.env` |
| `.env.example` current | All env vars from CLAUDE.md have entries in `.env.example` |
| Startup validation | `packages/api/src/lib/startup.ts` checks for required vars |
| No deprecated vars | No code references removed/renamed env vars |

---
