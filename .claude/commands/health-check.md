---
description: "Audit the codebase against CLAUDE.md rules across 10 dimensions — security, auth, errors, types, architecture, tools, deploy, semantic, observability, docs. Read-only, ~every 10 PRs."
---

# Atlas Codebase Health Check

Perform a comprehensive codebase audit against CLAUDE.md guidelines and established patterns. Run periodically (~10 PRs) to catch drift and technical debt.

**Mode:** Read-only — do NOT make changes. Generate a structured report.

---

## Parts

Each part is a separate file — read only the ones you're running. `$ARGUMENTS` may name
part letters (`/health-check B D J`); with no argument, run every part in order.

| Part | Area | Severity | File |
|------|------|----------|------|
| **A** | Gate Checks | Must pass | [`a-gates.md`](../../docs/agents/health-check/a-gates.md) |
| **B** | Security (SQL) | CRITICAL | [`b-security-sql.md`](../../docs/agents/health-check/b-security-sql.md) |
| **C** | Auth & Access Control | HIGH | [`c-auth.md`](../../docs/agents/health-check/c-auth.md) |
| **D** | Code Quality | HIGH | [`d-code-quality.md`](../../docs/agents/health-check/d-code-quality.md) |
| **E** | Architecture Compliance | HIGH | [`e-architecture.md`](../../docs/agents/health-check/e-architecture.md) |
| **F** | Agent & Tools Compliance | MEDIUM-HIGH | [`f-agent-tools.md`](../../docs/agents/health-check/f-agent-tools.md) |
| **G** | Deployment Compliance | MEDIUM | [`g-deployment.md`](../../docs/agents/health-check/g-deployment.md) |
| **H** | Semantic Layer & Config | MEDIUM | [`h-semantic.md`](../../docs/agents/health-check/h-semantic.md) |
| **I** | Observability | MEDIUM | [`i-observability.md`](../../docs/agents/health-check/i-observability.md) |
| **J** | Documentation Sync | LOW | [`j-docs-sync.md`](../../docs/agents/health-check/j-docs-sync.md) |
| **K** | Dev Tooling | LOW | [`k-dev-tooling.md`](../../docs/agents/health-check/k-dev-tooling.md) |

## Execution Strategy

Use the Task tool with `subagent_type=Explore` to parallelize investigation. Run up to 4 agents in parallel; **each agent reads only its own part files** from the table above, not this whole command:

1. **Gate agent** — part A (lint, type, test, syncpack)
2. **Security agent** — parts B and C (SQL validation, secrets, explore isolation, auth)
3. **Architecture agent** — parts D, E, F, G (code quality, error handling, type safety, imports, deployment)
4. **Compliance agent** — parts H, I, J, K (semantic layer, observability, docs, dev tooling)

---

## Output Format

```markdown
## Gate Results
- [ ] Lint: PASS/FAIL (details if fail)
- [ ] Type check: PASS/FAIL
- [ ] Tests: PASS/FAIL (X passed, Y failed)
- [ ] Syncpack: PASS/FAIL

## Critical Issues (Must Fix)
| File:Line | Section | Issue | Fix |
|-----------|---------|-------|-----|

## High Issues (Fix Soon)
| File:Line | Section | Issue | Fix |
|-----------|---------|-------|-----|

## Medium Issues (Should Fix)
| File:Line | Section | Issue | Fix |
|-----------|---------|-------|-----|

## Low Issues (Can Defer)
| File:Line | Section | Issue | Recommendation |
|-----------|---------|-------|----------------|

## Positive Patterns (Keep Doing)
- Pattern — Where it's done well
```

---

## Priority Order

1. **GATE (A0):** Lint, Type, Tests, Syncpack — must pass before proceeding
2. **CRITICAL (B1-B4):** SQL validation pipeline, readonly enforcement, secrets, explore isolation
3. **HIGH (C1, D1-D7, E1-E2):** Auth integrity, no secrets in source, console usage, error handling, type safety, function complexity, test mocks, frontend isolation, import hygiene
4. **MEDIUM-HIGH (E3-E4, F1-F3):** Server external packages, bun-only, agent compliance, tool registry
5. **MEDIUM (G1-G2, H1-H2, I1-I2):** Deployment, semantic layer, observability
6. **LOW (J1-J2, K1):** Documentation sync, dev tooling

---

## Focus Areas

Start with these directories:

| Priority | Directory | What to Check |
|----------|-----------|---------------|
| CRITICAL | `packages/api/src/lib/tools/` | SQL validation, explore isolation, tool registry |
| CRITICAL | `packages/api/src/lib/security.ts` | Secrets scrubbing patterns |
| HIGH | `packages/api/src/lib/auth/` | Auth modes, rate limiting, audit |
| HIGH | `packages/api/src/lib/db/` | Connection adapters, readonly enforcement |
| HIGH | `packages/api/src/api/routes/` | Route auth, error handling |
| MEDIUM | `packages/web/src/` | Frontend isolation, no API imports |
| MEDIUM | `packages/api/src/lib/agent.ts` | Step limit, tool orchestration |
| MEDIUM | `examples/` | Dockerfile compliance, config consistency |
| LOW | `semantic/` | YAML validity, entity completeness |
| LOW | `CLAUDE.md` | Documentation accuracy |

---
