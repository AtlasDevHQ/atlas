## Part C: Configuration Reference (HIGH RISK)

**Docs:** `apps/docs/content/shared/reference/config.mdx`
**Source of truth:** `packages/api/src/lib/config.ts` (the `AtlasConfigSchema` Zod schema)

### Steps

1. Read the Zod schema `AtlasConfigSchema` from `packages/api/src/lib/config.ts`
2. Extract all top-level and nested config keys with their types and defaults
3. Read `apps/docs/content/shared/reference/config.mdx`
4. Cross-reference:

| Check | How |
|-------|-----|
| **Missing config keys** | Key in Zod schema but not in docs → HIGH |
| **Stale config keys** | Key in docs but removed from schema → HIGH |
| **Wrong types** | Docs say string but schema is number, etc. → HIGH |
| **Wrong defaults** | Default in docs differs from `.default()` in Zod → MEDIUM |
| **Missing nested options** | Sub-objects (rls, cache, pool, python, sandbox, session, learn) fully documented? |
| **defineConfig() example** | Does the main example in docs validate against current schema? |

### How to find schema sections
Don't use a hardcoded list. Read the `AtlasConfigSchema` from `packages/api/src/lib/config.ts` and extract ALL top-level keys dynamically. As of this writing these include datasources, rls, cache, pool, sandbox, python, session, learn, actions, scheduler, enterprise — but new sections may have been added. The schema is the source of truth.

---
