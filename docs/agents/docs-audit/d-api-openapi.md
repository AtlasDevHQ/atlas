## Part D: API Endpoints / OpenAPI Spec (MEDIUM-HIGH RISK)

**Docs:** `apps/docs/content/docs/api-reference/` (auto-generated from OpenAPI)
**Source of truth:** `packages/api/src/api/routes/openapi.ts` (programmatic spec built from Zod schemas)

### CRITICAL: OpenAPI Codegen Pipeline

The API reference docs are generated, NOT hand-maintained. The pipeline is:

```
OpenAPIHono typed routes (auto-generated) + staticPaths in routes/openapi.ts (hand-curated)
    ↓  merged by buildAtlasOpenApiDocument() in packages/api/src/api/index.ts
    ↓  bun packages/api/scripts/extract-openapi.ts
apps/docs/openapi.json                    ← GENERATED ARTIFACT (never edit directly!)
    ↓  cd apps/docs && bun ./scripts/generate-openapi.ts
apps/docs/content/docs/api-reference/     ← GENERATED MDX pages
```

**NEVER edit `apps/docs/openapi.json` directly** — it will be overwritten on next extraction.
To add/fix endpoints: edit `openapi.ts`, then run the extraction + generation scripts.

### Steps

1. Extract all route paths from `packages/api/src/api/index.ts` (the route mounting file)
2. Extract all endpoints in the spec: the bulk is auto-generated from OpenAPIHono typed route definitions; hand-curated static entries for plain-Hono routes live in `packages/api/src/api/routes/openapi.ts` (`staticPaths`/`staticTags`); the merge happens in `buildAtlasOpenApiDocument()` (`packages/api/src/api/index.ts`)
3. Cross-reference — every mounted route should appear in the merged spec (plain-`Hono` routers are structurally excluded, and routes can opt out via `hide: true` with a rationale — check for those conventions before flagging):

| Check | How |
|-------|-----|
| **Missing from openapi.ts** | Route in code but not in programmatic spec → HIGH |
| **Stale in openapi.ts** | Endpoint in spec but removed from code → HIGH |
| **Wrong methods** | GET vs POST mismatch → HIGH |
| **Schema drift** | Response shapes in openapi.ts don't match actual c.json() returns → HIGH |
| **openapi.json stale** | Run `bun packages/api/scripts/extract-openapi.ts` and check if output differs from committed file → MEDIUM |

### Fixing missing endpoints

1. Read the route handler in `packages/api/src/api/routes/<handler>.ts`
2. For an OpenAPIHono-mounted route, fix/extend its typed zod-openapi route definition; for a plain-Hono route, add a static entry to `staticPaths` in `openapi.ts`
3. Run `bun packages/api/scripts/extract-openapi.ts` to regenerate `apps/docs/openapi.json`
4. Run `cd apps/docs && bun ./scripts/generate-openapi.ts` to regenerate MDX pages
5. Commit all generated files alongside the source change

### Grep patterns
```bash
# Code: all mounted routes
grep -P '\.route\(|\.get\(|\.post\(|\.patch\(|\.delete\(|\.put\(' packages/api/src/api/index.ts packages/api/src/api/routes/*.ts | grep -oP '["'"'"']/[^"'"'"']+' | sort -u

# openapi.ts: all paths in spec
grep -oP '"/api/[^"]+"|"/widget[^"]*"' packages/api/src/api/routes/openapi.ts | sort -u

# Check if openapi.json is stale (should produce no diff if in sync)
bun packages/api/scripts/extract-openapi.ts && git diff apps/docs/openapi.json
```

---
