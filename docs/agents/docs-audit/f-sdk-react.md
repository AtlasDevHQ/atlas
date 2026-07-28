## Part F: SDK & React Reference (MEDIUM RISK)

**Docs:** `apps/docs/content/shared/reference/sdk.mdx`, `apps/docs/content/shared/reference/react.mdx`
**Source of truth:** `packages/sdk/src/index.ts`, `packages/react/src/index.ts`

### Steps

1. Extract all public exports from SDK and React package index files
2. Compare against documented API surface in reference pages
3. Check:

| Check | How |
|-------|-----|
| **Missing exports** | Exported from index.ts but not documented → MEDIUM |
| **Stale API** | Documented but no longer exported → HIGH |
| **Wrong signatures** | Function parameters in docs differ from code → HIGH |
| **Missing types** | Key types exported but not in docs type reference |

---
