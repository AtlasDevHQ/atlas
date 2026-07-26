## Part A: Environment Variables (HIGH RISK)

**Docs:** `apps/docs/content/shared/reference/environment-variables.mdx`
**Source of truth:** `packages/api/src/lib/config.ts` (the `configFromEnv()` function) and `.env.example`

### Steps

1. Extract ALL `process.env.*` reads from `packages/api/src/lib/config.ts` (the `configFromEnv()` function) AND from across `packages/api/src/` — this is the authoritative list of what the code actually reads. Include ALL prefixes (ATLAS_*, DATABASE_*, BETTER_AUTH_*, SLACK_*, GOOGLE_*, GITHUB_*, MICROSOFT_*, OPENAI_*, OLLAMA_*, OTEL_*, PORT, NODE_ENV, VERCEL, etc.)
2. Extract all **settings-registry keys** from `packages/api/src/lib/settings.ts` (`key: "ATLAS_..."` entries). These are runtime-controllable knobs read via the registry, NOT via `process.env` — the grep in step 1 misses them. Each needs docs coverage AND correct framing: precedence is `workspace > platform > env > default`, so docs must not describe a registry-backed knob as env-only (on SaaS it's set in the Admin console, never by redeploy)
3. Extract all env vars from `.env.example`
4. Extract all env vars mentioned in `apps/docs/content/shared/reference/environment-variables.mdx`
5. Cross-reference:

| Check | How |
|-------|-----|
| **Missing from docs** | Var in code but not in docs page → HIGH (users can't discover it) |
| **Missing from .env.example** | Var in code but not in .env.example → MEDIUM (missing from template) |
| **Stale in docs** | Var in docs but not in code → HIGH (misleading) |
| **Wrong defaults** | Compare default values in docs vs code — especially numeric defaults like timeouts, limits |
| **Wrong descriptions** | Spot-check 5-10 vars where the docs description matches the code behavior |

### Grep patterns
```bash
# Code: ALL env vars read across the entire API package (not just config.ts)
grep -rP 'process\.env\.\w+' packages/api/src/ --include='*.ts' -h | grep -oP 'process\.env\.\w+' | sort -u

# Also check ee/ for enterprise env vars
grep -rP 'process\.env\.\w+' ee/src/ --include='*.ts' -h 2>/dev/null | grep -oP 'process\.env\.\w+' | sort -u

# Docs: all vars mentioned
grep -oP '[A-Z][A-Z_]+[A-Z]' apps/docs/content/shared/reference/environment-variables.mdx | sort -u

# .env.example: all vars (uncommented and commented)
grep -oP '^#?\s*[A-Z][A-Z_]+[A-Z]' .env.example | sed 's/^#\s*//' | sort -u
```

### A2. SaaS boot contract page (generated — check drift, never hand-edit)

**Docs:** `apps/docs/content/docs/platform-ops/saas-environment-variables.mdx` (SaaS tree)
**Source of truth:** `SAAS_ENV_KEYS` in `packages/api/src/lib/effect/saas-env.ts`

This page's env-var table is **machine-generated** by `scripts/generate-saas-env-doc.ts` and drift-checked in `/ci` by `scripts/check-saas-env-doc.sh`. Don't hand-diff the table — run the check:

```bash
bash scripts/check-saas-env-doc.sh   # non-zero exit = page is stale → regenerate, don't hand-edit
```

Still worth spot-checking: the prose around the generated table (boot-guard behavior, `SAAS_IMMUTABLE_KEYS` claims) against `saas-guards.ts` and `docs/development/saas-env-audit.md`.

---
