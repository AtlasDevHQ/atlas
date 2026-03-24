# Python Data Science Sandbox

**Status:** Core complete — 4/6 sub-issues shipped (PRs #46, #47, #48, #49). Remaining: nsjail + Vercel backends (backlog)
**Date:** 2026-03-06
**Updated:** 2026-03-07

## What shipped

### PR #46 — Tool definition + import guard
- `executePython` AI SDK tool in `packages/api/src/lib/tools/python.ts`
- AST-based import guard (16 blocked modules, 12 blocked builtins)
- Gated behind `ATLAS_PYTHON_ENABLED=true` in `buildRegistry()`

### PR #47 — Sidecar backend (replaced just-bash)
- `POST /exec-python` on the sandbox sidecar (`packages/sandbox-sidecar/src/server.ts`)
- Sidecar-side AST guard (double enforcement — client validates, sidecar re-validates)
- Per-execution temp directory + randomized result marker (no collision, no stdout spoofing)
- Isolated exec namespace (`exec()` in separate globals dict)
- 30s timeout with SIGKILL, configurable via `ATLAS_PYTHON_TIMEOUT`
- Registry fails fast if `ATLAS_PYTHON_ENABLED=true` without `ATLAS_SANDBOX_URL`
- Sidecar Dockerfile adds python3 + data science packages
- docker-compose.yml includes sandbox service

### PR #49 — Agent prompt tuning
- Conditional `PYTHON_GUIDANCE` section in system prompt (only when `executePython` is in the registry)
- SQL vs Python boundaries, anti-patterns, chart output preference guidance
- Updated `EXECUTE_PYTHON_DESCRIPTION` in registry.ts with specific output mode docs

### PR #48 — Python result card in UI
- `PythonResultCard` component in `packages/web/src/ui/components/chat/python-result-card.tsx`
- Renders all output types: error state, text (pre), tables (DataTable), Recharts charts (via synthetic ChartDetectionResult), base64 PNG images
- Dynamic import of ResultChart (Recharts is heavy)
- MIME type validation on chart images (only image/png, image/jpeg)
- Collapsible card with Python badge + explanation text
- Error boundary wraps entire component

### Architecture as built

```
Agent loop (unsandboxed)
  |
  |-- executeSQL --> validated SQL --> DB --> { columns, rows }
  |
  +-- executePython(code, explanation, data?) --> python.ts
        |
        |-- validatePythonCode() --- AST import guard (defense-in-depth)
        |-- executePythonViaSidecar() --> POST /exec-python on sidecar
              |
              |-- Sidecar re-validates via AST (authoritative)
              |-- Data injected via stdin JSON --> `df` (DataFrame) or `data` (dict)
              |-- User code runs in isolated namespace via exec()
              |-- Per-execution tmpdir, no secrets, SIGKILL timeout
              +-- Returns PythonResult (discriminated union)
```

### Output types (as built)

```typescript
// Discriminated union
type PythonResult =
  | { success: true; output?: string; table?: { columns, rows }; charts?: PythonChart[]; rechartsCharts?: RechartsChart[] }
  | { success: false; error: string; output?: string }

// User code sets these in its namespace:
// _atlas_table = {"columns": [...], "rows": [...]}     → table output (existing ResultChart renders)
// _atlas_chart = {"type": "line", "data": [...], ...}  → Recharts-compatible (interactive)
// chart_path(n) → save matplotlib PNG                   → base64 image output
// print() → narrative text
```

### Phased chart strategy

1. **Recharts-first (shipped)** — `_atlas_table` and `_atlas_chart` produce data that the existing `ResultChart` component renders as interactive bar/line/pie charts. Zero UI work needed.
2. **Images later (#41)** — `chart_path(n)` + matplotlib PNGs for advanced viz (heatmaps, scatter matrices, violin plots). Needs a new UI component. Enhancement, not blocker.

## Remaining work

| # | Issue | Status | Notes |
|---|-------|--------|-------|
| #40 | Tool definition + just-bash | **Done** | Shipped in #46+#47 |
| #43 | Sidecar backend | **Done** | Shipped in #47 |
| #44 | Agent prompt tuning | **Done** | Shipped in #49. Conditional PYTHON_GUIDANCE in system prompt |
| #41 | Python result card in UI | **Done** | Shipped in #48. PythonResultCard: text, tables, Recharts, base64 images |
| #42 | nsjail Python backend | Backlog | Lower priority — alternative for single-container deploys |
| #45 | Vercel sandbox backend | Backlog | Depends on @vercel/sandbox Python support |

## Resolved questions

1. **Data passing** — inline JSON on stdin. Simple, stateless, works.
2. **Chart format** — dual: Recharts JSON (interactive, primary) + base64 PNG (static, for advanced viz)
3. **Backend architecture** — sidecar is the primary backend. No just-bash fallback for Python (unlike explore). nsjail as optional alternative later.
4. **Security model** — defense-in-depth: client-side AST guard + sidecar-side AST guard + container isolation

## Open questions

1. **Library versioning** — pin exact versions in the sidecar Dockerfile, or track latest?
2. **Plugin SDK surface** — new `code-sandbox` plugin type or extend existing `sandbox` type?
3. **Input size cap** — no guard on data payload size yet. Large SQL results could OOM the sidecar.
