---
paths:
  - "packages/api/src/lib/tools/**"
  - "packages/api/src/lib/agent*.ts"
---

# Agent tools and the agent loop

- [ ] **Tools return structured data** — `executeSQL` returns `{ columns, rows }`
- [ ] **Default tool set lives in the registry** — `defaultRegistry` (`lib/tools/registry.ts`) registers `explore`, `executeSQL`, `searchBrain`, `correct_fact`, `createDashboard`, `sendEmail`, `createLinearIssue`, and OAuth-gated `querySalesforce`; `buildRegistry` adds `executePython` (when `ATLAS_PYTHON_ENABLED`) + configured action tools. Never wire a tool around the registry. A tool RENAME goes in `RENAMED_TOOLS` in the same file — `validateToolConfig` throws on an unknown `atlas.config.ts` `tools:` entry, so an unmapped rename is a boot failure in someone else's deployment
- [ ] **Explore is read-only by isolation, not command validation** — There is no command allowlist; the agent may run arbitrary shell (`awk`/`sed`/pipes included). Read-only scoping to `semantic/` is enforced structurally by each backend (ephemeral microVM / read-only bind mounts / OverlayFs): writes land in ephemeral or in-memory layers and never touch host files. Output is capped at 1 MB at the tool seam. Sandbox priority documented under **Security (General)** above
- [ ] **Agent max steps** — `stopWhen: stepCountIs(getAgentMaxSteps())`. Default 25, via `ATLAS_AGENT_MAX_STEPS` (1–100)
- [ ] **Tools are traced by registration, not by diligence** — `ToolRegistry.getAll()` wraps every executable tool in an `atlas.tool.<name>` span (`lib/tools/tool-spans.ts`), so a new tool needs no telemetry code; a tool that wants more detail adds an inner span that nests under it. Span/attribute conventions + the grandfathered off-prefix names: [docs/development/telemetry.md](docs/development/telemetry.md)
- [ ] **Semantic layer drives the agent** — Read entity YAMLs before writing SQL

## The loop

```
POST /api/v1/chat → authenticateRequest → checkRateLimit → withRequestContext → validateEnvironment
    → runAgent(messages)  [or runAgentEffect → yield* AtlasAiModel]
    → streamText (AI SDK, ToolRegistry, stopWhen: stepCountIs(getAgentMaxSteps()))
        ├── explore → read semantic/ + knowledge mirrors in the sandbox (read-only by isolation)
        ├── executeSQL → validate (one parse) → resolveSqlExecutionPlan → reject | single | fanout
        │                → query via ConnectionRegistry → { columns, rows }
        ├── searchBrain → fused trust-labeled read: facts (tier-2) · episodes (tier-3) · KB docs (ADR-0036)
        ├── correct_fact → the four correction verbs (retract · supersede · re-authority · pin), owner/admin-gated at execute time
        └── createDashboard · sendEmail · createLinearIssue · querySalesforce · executePython (gated)
    → Data Stream Response → Chat UI

Other routes use: runHandler(c, ...) → RequestContext + AuthContext via Effect bridge
```

`runAgentEffect` yields `AtlasAiModel` from Effect Context — testable with a mock LLM via `createAiModelTestLayer()`. Durable sessions (when enabled) checkpoint per-step for crash-resume + approval-park (ADR-0020).

## Registering a tool

```typescript
import { ToolRegistry, defaultRegistry } from "@atlas/api/lib/tools/registry";
const custom = new ToolRegistry();
custom.register({ name: "myTool", description: "...", tool: myAISDKTool });
custom.freeze();
```
