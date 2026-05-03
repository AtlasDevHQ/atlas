# `/pricing` Lighthouse baseline

Captures the initial Lighthouse profile for the pricing page (`/pricing` on `apps/www`) so the CI budget added in #2009 has something concrete to assert against.

`/pricing` is the bottom of the marketing funnel — visitors land here when they're already evaluating, so anything that regresses Performance, Accessibility, or layout stability has a direct revenue cost.

## Results — 2026-05-02

| Run | Performance | Accessibility | Best Practices | SEO |
|---|---|---|---|---|
| Desktop | **100** | **100** | **100** | **100** |
| Mobile | **96** | **100** | **100** | **100** |

### Web vitals

| Run | LCP | FCP | TBT | CLS | Speed Index |
|---|---|---|---|---|---|
| Desktop | 760 ms | 240 ms | 0 ms | 0 | 240 ms |
| Mobile | 3850 ms | 920 ms | 90 ms | 0 | 920 ms |

These are seed numbers used to populate the assertion thresholds in `lighthouserc.js`. CI re-measures on every PR that touches `apps/www/**`.

## CI budget — `lighthouserc.js`

The repo-root `lighthouserc.js` enforces these warn-level assertions for `/pricing`:

| Metric | Threshold | Form factor |
|---|---|---|
| Performance | ≥ 0.95 | desktop |
| Performance | ≥ 0.85 | mobile |
| Accessibility | ≥ 1.0 | both |
| Best Practices | ≥ 1.0 | both |
| SEO | ≥ 1.0 | both |
| LCP | ≤ 1500 ms | desktop |
| LCP | ≤ 4500 ms | mobile |
| CLS | ≤ 0.1 | both |

Identical to `/` — the surfaces are sibling static-export pages with comparable JS payloads, so they share thresholds. If the pages diverge (e.g. pricing adds an interactive plan toggle that ships extra JS), split the budget here.

## How to refresh

```bash
cd apps/www
bun install
bun run build
PORT=8080 bun serve.ts &
# Hit http://localhost:8080/pricing with the same scratch runner used for /
```

See `apps/www/.design/landing/lighthouse-baseline.md` for the runner pattern and `apps/www/.design/demo/lighthouse-baseline.md` for the canonical methodology notes.

## Methodology notes

Same as `/` — see `apps/www/.design/landing/lighthouse-baseline.md`. Static export, `next build` → `out/`, served by `apps/www/serve.ts`, Lighthouse 13.2.0, default desktop / mobile presets, headless Chrome on WSL2. Absolute numbers will shift on CI runners.
