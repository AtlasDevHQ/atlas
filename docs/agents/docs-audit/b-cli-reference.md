## Part B: CLI Reference (HIGH RISK)

**Docs:** `apps/docs/content/shared/reference/cli.mdx`
**Source of truth:** `packages/cli/bin/atlas.ts` (workspace-facing `atlas` binary) AND `packages/cli/bin/atlas-operator.ts` (tenant-data operator binary, split out per ADR-0025 / #4045)

### Steps

1. Extract all CLI subcommands from BOTH `packages/cli/bin/atlas.ts` and `packages/cli/bin/atlas-operator.ts` (look for `.command()` calls or command dispatch). The docs page covers both binaries — check operator commands (`proactive`, `seed`, `ops wipe`, `ops smoke-crm`, `ops teardown-verify-accounts`, `export`, `learn`, …) are documented under the correct binary, including their double-gates (`ATLAS_WIPE_OK`, `ATLAS_TEARDOWN_OK`)
2. Extract all documented commands from `apps/docs/content/shared/reference/cli.mdx`
3. For each command, compare flags/options between code and docs
4. Cross-reference:

| Check | How |
|-------|-----|
| **Missing commands** | Command in code but not in docs → HIGH |
| **Stale commands** | Command in docs but removed from code → HIGH |
| **Missing flags** | Flag in code but not documented → MEDIUM |
| **Wrong flag descriptions** | Spot-check flag defaults and descriptions |
| **Wrong examples** | Do the example commands in docs use correct flag names? |

### Grep patterns
```bash
# Code: command names (both binaries)
grep -P '\.command\(|case "' packages/cli/bin/atlas.ts packages/cli/bin/atlas-operator.ts | head -50

# Code: option flags
grep -P '\.option\(' packages/cli/bin/atlas.ts packages/cli/bin/atlas-operator.ts | head -60

# Docs: documented commands
grep -P '^#{2,3}.*`atlas' apps/docs/content/shared/reference/cli.mdx
```

---
