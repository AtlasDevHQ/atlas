## Part G: Error Codes (MEDIUM RISK)

**Docs:** `apps/docs/content/shared/reference/error-codes.mdx`
**Source of truth:** `packages/types/src/errors.ts`

### Steps

1. Extract all error code constants from `packages/types/src/errors.ts`
2. Extract all documented error codes from `apps/docs/content/shared/reference/error-codes.mdx`
3. Cross-reference:

| Check | How |
|-------|-----|
| **Missing codes** | Code in source but not in docs → MEDIUM |
| **Stale codes** | Code in docs but removed from source → HIGH |
| **Wrong retryability** | Docs say retryable but source says not (or vice versa) → HIGH |
| **Missing guidance** | Error code documented but no troubleshooting steps |

---
