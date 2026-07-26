## Part E: Plugin Documentation (MEDIUM RISK)

**Docs:** `apps/docs/content/shared/plugins/`
**Source of truth:** `plugins/*/package.json`, `plugins/*/src/index.ts`

### Steps

1. List all plugins in `plugins/` directory
2. For each plugin with a docs page, check:

| Check | How |
|-------|-----|
| **Package name matches** | Docs `bun add` command uses correct package name |
| **Import path correct** | Docs import matches actual package export |
| **Config options current** | Plugin Zod schema matches documented options table |
| **Version requirement** | Peer deps in package.json match docs prerequisites |

### Grep patterns
```bash
# All plugins
ls plugins/

# Plugin package names
grep '"name"' plugins/*/package.json

# Plugin exports
grep 'export' plugins/*/src/index.ts | head -30
```

---
