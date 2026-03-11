# Browser Tests

Run the Playwright browser e2e test suite. No LLM costs — skips `@llm`-tagged tests (charts, conversations).

Requires dev server running (`bun run dev`).

## Steps

1. Verify the dev server is up:

```bash
curl -sf http://localhost:3000 > /dev/null && curl -sf http://localhost:3001/api/health > /dev/null && echo "Dev server ready" || echo "ERROR: Start dev server with 'bun run dev'"
```

2. Run the fast (no-LLM) browser tests:

```bash
bun run test:browser:fast
```

3. Report the results — how many passed/failed, and any failures with their spec file and test name.

4. If any tests fail, read the failure screenshot at `test-results/*/test-failed-1.png` and diagnose the issue. Common problems:
   - **Strict mode violations**: selector matches multiple elements — scope with `[data-slot=...]` or use `.first()`/`.nth()`
   - **Timeout**: dev server slow or page not loading — check server logs
   - **Element not found**: UI changed — update the selector in the spec file

Do NOT run `@llm` tests unless explicitly asked (they cost tokens). If the user wants the full suite, run `bun run test:browser` instead.
