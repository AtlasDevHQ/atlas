## Part D: Code Quality — HIGH

### D1. No Secrets in Source

```
Grep for: sk-ant-|sk-proj-|AKIA|password\s*=\s*["'] in packages/ and examples/ and apps/
Exclude: .env.example, test files with obviously fake values, CLAUDE.md documentation
```

Any real-looking API key, connection string, or credential = CRITICAL.

---

### D2. Console Usage in Production Code

```
Grep for: console\.(log|error|warn|debug|info) in packages/api/src/ and packages/cli/bin/ and packages/mcp/src/
Exclude: test files (*test*, *spec*), test-setup.ts
```

| Location | Acceptable? |
|----------|-------------|
| `explore-nsjail.ts` | Yes — child process stderr logging |
| `packages/cli/` | Yes — CLI uses console directly (no pino) |
| `packages/sandbox-sidecar/` | Yes — sidecar uses console directly |
| Test files | Yes |
| `packages/api/src/` (non-test) | No — must use Pino logger |

---

### D3. TODO/FIXME/HACK Audit

```
Grep for: TODO|FIXME|HACK|XXX|TEMP in packages/ and apps/ and examples/
Exclude: node_modules/, .next/, dist/
```

For each found: assess whether it's tracked in a GitHub issue. Untracked TODOs = tech debt.

---

### D4. Error Handling Quality

**Reference:** Patterns established in 0.7.3 — Error Handling & Resilience

| Check | What to Verify |
|-------|----------------|
| No empty catches | No `catch { }` or `catch { /* ... */ }` without logging. Every catch must `log.warn`/`console.debug` or re-throw |
| Type-narrow all errors | `catch (err)` must guard with `err instanceof Error ? err.message : String(err)` before accessing `.message` |
| Request IDs on 500s | Every 500 response includes `requestId` for log correlation. Check global error handler in `packages/api/src/api/index.ts` |
| No generic messages | Grep for "Something went wrong", "An error occurred", "An unexpected error" — should not appear in non-test code |
| Security-safe fallbacks | `catch { return false }` on auth/security checks is a bug — must return 500, not false negative |
| Structured errors | API routes return structured JSON `{ error: "code", message: "..." }`, not raw strings |
| Intentional catches annotated | Best-effort catches (e.g., dialect fallback loops) must have `// intentionally ignored: <reason>` |

```
Grep for: catch\s*\{ in packages/ — empty catch blocks (no variable captured)
Grep for: catch\s*\(.*\)\s*\{ in packages/ — then verify each has logging or re-throw
Grep for: "Something went wrong"|"An error occurred"|"An unexpected error" in packages/ — should be zero in non-test code
Grep for: \.message\b in catch blocks — verify preceded by instanceof Error guard
```

**Pattern reference (from 0.7.3):**
```typescript
// GOOD — type-narrowed with logging
} catch (err) {
  log.warn({ err: err instanceof Error ? err.message : String(err), requestId }, "Failed to ...");
  return c.json({ error: "internal_error", message: "..." }, 500);
}

// BAD — silent swallow
} catch { return false; }

// BAD — unguarded .message access
} catch (err) { log.error(err.message); }
```

---

### D5. Type Safety

**Reference:** Patterns established in 0.7.2 — Type Safety & Code Smells

| Check | What to Verify |
|-------|----------------|
| No explicit `any` | Grep for `: any` in non-test `.ts`/`.tsx` files. Should be near zero. Remaining must have `oxlint-disable` + justification |
| Minimal `!` assertions | Non-null assertions should be rare and justified. Prefer `?.` or explicit null checks |
| No unused exports | Dead exports add confusion. Public API packages (`sdk`, `react`, `plugin-sdk`, `types`) are exceptions — external consumers may use them |

```
Grep for: : any in packages/ --include='*.ts' --include='*.tsx' (exclude test files, .d.ts)
Grep for: \!\. in packages/ --include='*.ts' (non-null assertions)
```

---

### D6. Function Complexity

**Reference:** Patterns established in 0.7.2 — Function complexity refactor

| Check | What to Verify |
|-------|----------------|
| No functions > 50 lines | Long functions should be extracted into named helpers |
| No deep nesting (3+ levels) | Deeply nested if/try/catch should be flattened or extracted |
| Helpers have descriptive names | Extracted helpers should explain what the block does |

Focus areas: `packages/api/src/lib/tools/sql.ts`, `packages/api/src/lib/startup.ts`, `packages/api/src/lib/tools/actions/handler.ts`

---

### D7. Test Mock Hygiene

**Reference:** Shared mock factory from 0.7.4 — Test Hardening

| Check | What to Verify |
|-------|----------------|
| `createConnectionMock` usage | All connection mocks in `packages/api/` tests should use the shared factory from `packages/api/src/__mocks__/connection.ts` |
| No partial `mock.module()` | Every `mock.module()` call must mock ALL named exports. Partial mocks cause `SyntaxError` in other test files |
| No inline connection mocks | Test files shouldn't create ad-hoc connection mock objects |

```
Grep for: mock.module.*connection in packages/api/src/ --include='*.test.ts'
For each match, verify it imports createConnectionMock
```

---
