## Part K: Dev Tooling — LOW

### K1. Dev Server Scripts

**Reference:** Root `package.json`

| Check | What to Verify |
|-------|----------------|
| `dev` script | Starts both API (:3001) and Web (:3000) concurrently |
| `dev:api` | Standalone Hono API on :3001 |
| `dev:web` | Standalone Next.js on :3000 |
| Production unaffected | `scripts/start.sh` doesn't depend on dev tooling |
| CI unaffected | `.github/workflows/` doesn't depend on dev tooling |
