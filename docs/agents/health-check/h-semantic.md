## Part H: Semantic Layer & Config — MEDIUM

### H1. Semantic Layer Schema

```
Check: semantic/entities/*.yml — valid YAML with required fields (table, description, columns)
Check: semantic/catalog.yml — lists all entities
Check: semantic/glossary.yml — ambiguous terms marked
```

| Check | What to Verify |
|-------|----------------|
| Entity files parse | All YAMLs load without errors |
| Required fields | Every entity has `table`, `description`, `columns` |
| Column types valid | Types are: text, integer, real, numeric, date, boolean (or DB-specific equivalents) |
| Metrics reference valid tables | `semantic/metrics/*.yml` reference tables that exist in entities |

---

### H2. Declarative Config

**Reference:** `packages/api/src/lib/config.ts`

| Check | What to Verify |
|-------|----------------|
| Config precedence | `atlas.config.ts` overrides env vars for datasources/tools when present |
| Env var fallback | Without config file, env vars work exactly as documented |
| Config schema | Zod validation catches malformed configs at startup |

---
