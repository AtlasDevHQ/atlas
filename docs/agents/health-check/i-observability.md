## Part I: Observability — MEDIUM

### I1. Structured Logging

**Reference:** `packages/api/src/lib/logger.ts`

| Check | What to Verify |
|-------|----------------|
| Pino used everywhere | No raw `console.log` in production paths (see D2) |
| Request context | `requestId` + `userId` bound via AsyncLocalStorage |
| Redaction | Sensitive fields redacted in log output |
| Log levels | Appropriate levels used (error for errors, warn for warnings, not info for everything) |

---

### I2. Health Endpoint

**Reference:** `packages/api/src/api/routes/health.ts`

| Check | What to Verify |
|-------|----------------|
| Probes all systems | Datasource, internal DB, semantic layer, explore backend, auth mode |
| No secrets exposed | Response doesn't include connection strings, API keys |
| Stale state detection | Backend capability failures correctly reflected (not cached stale) |

---
