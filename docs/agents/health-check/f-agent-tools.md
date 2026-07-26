## Part F: Agent & Tools Compliance — MEDIUM-HIGH

### F1. Agent Step Limit

**Reference:** `packages/api/src/lib/agent.ts`

```
Grep for: stepCountIs|maxSteps|stopWhen in packages/api/src/lib/agent.ts
```

| Check | What to Verify |
|-------|----------------|
| Max steps | `stopWhen: stepCountIs(getAgentMaxSteps())` — default 25, configurable via `ATLAS_AGENT_MAX_STEPS` (1–100) |
| No infinite loops | No code path that could bypass step counting |

---

### F2. Tool Return Structure

**Rule:** Tools return structured data, not raw strings.

| Tool | Expected Return |
|------|----------------|
| `executeSQL` | `{ columns, rows }` |
| `explore` | Structured file/directory content |

```
Check: packages/api/src/lib/tools/*.ts — verify return types match expected structure
```

---

### F3. Tool Registry Immutability

**Reference:** `packages/api/src/lib/tools/registry.ts`

| Check | What to Verify |
|-------|----------------|
| Default registry frozen | `defaultRegistry.freeze()` called — no runtime mutations |
| No tool injection | No code path adds tools to a frozen registry |

---
