Run the same checks CI runs. This must pass before opening a PR.

**Run all gates in parallel:**

```bash
bun run lint           # ESLint — 0 errors, 0 warnings
bun run type           # TypeScript strict mode (tsgo) — 0 errors
bun run test           # All tests (isolated per-file runner)
bun x syncpack lint    # Workspace dependency versions consistent
SKIP_SYNCPACK=1 bash scripts/check-template-drift.sh  # Template drift
```

**Evaluate results:**

| Gate | Pass criteria |
|------|---------------|
| Lint | Zero output (no errors or warnings) |
| Type | No errors after build |
| Test | All packages pass, 0 failures |
| Syncpack | `No issues found` |
| Template drift | `Template drift check passed` |

**If any gate fails:**

1. Fix the issue directly — these are almost always small:
   - Lint: type annotations, unused vars, unsafe types
   - Type: missing types, interface mismatches
   - Syncpack: run `bun x syncpack fix` then verify
   - Template drift: run `bash create-atlas/scripts/prepare-templates.sh` then verify
   - Tests: read the failure, fix the code or test

2. After fixing, re-run only the failed gate to verify, then run all gates once more.

**If all gates pass:**

Report: `CI gates: lint, type, test, syncpack, drift — all pass.`

**Rules:**
- Never skip a gate or mark it as "probably fine"
- If a gate fails on code you didn't write (pre-existing), still fix it — CI won't distinguish
- If a test is flaky (passes on retry), note it but don't ignore it
