## Part C: Auth & Access Control — HIGH

### C1. Auth System Integrity

**Reference:** `packages/api/src/lib/auth/`

| Check | What to Verify |
|-------|----------------|
| Mode detection | Priority: JWKS > Better Auth > API key > none. Cached after first call |
| Simple key | Timing-safe comparison (`timingSafeEqual`), not `===` |
| Managed auth | `BETTER_AUTH_SECRET` min 32 chars enforced |
| BYOT | JWKS endpoint validated, issuer check, optional audience check |
| Rate limiting | Per-user (authenticated) or per-IP (fallback). 429 with Retry-After header |
| Audit logging | All queries logged with user identity, scrubbed SQL, timing |

**Grep checks:**
```
Grep for: timingSafeEqual in packages/api/src/lib/auth/simple-key.ts — must be present
Grep for: authenticateRequest in packages/api/src/api/routes/ — every route that needs auth uses it
```

---
