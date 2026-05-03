# `/` Lighthouse baseline

Captures the initial Lighthouse profile for the landing page (`/` on `apps/www`) so the CI budget added in #2009 has something concrete to assert against.

`/` is the top of the marketing funnel — anything that regresses Performance or Accessibility on this surface degrades the first impression for every inbound visitor.

## Results — 2026-05-02

| Run | Performance | Accessibility | Best Practices | SEO |
|---|---|---|---|---|
| Desktop | **100** | **100** | **100** | **100** |
| Mobile | **95** | **100** | **100** | **100** |

### Web vitals

| Run | LCP | FCP | TBT | CLS | Speed Index |
|---|---|---|---|---|---|
| Desktop | 820 ms | 280 ms | 0 ms | 0 | 280 ms |
| Mobile | 3900 ms | 950 ms | 110 ms | 0 | 950 ms |

These are seed numbers used to populate the assertion thresholds in `lighthouserc.js`. The CI workflow re-measures on every PR that touches `apps/www/**` or `packages/web/**`; the seed only matters for "what's the warning threshold on day 1".

## CI budget — `lighthouserc.js`

The repo-root `lighthouserc.js` enforces these warn-level assertions for `/`:

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

Score thresholds sit close to the seed numbers; LCP ceilings are deliberately *generous* (≈2× the desktop seed, a hair above the mobile seed) because CI runners measure noisier than a local WSL2 box. The first month is configured as warn-only (no PR fail) while we calibrate flake.

## How to refresh

The seed numbers above were captured by the same scratch runner used for `/demo` (#1945). To re-measure:

```bash
cd apps/www
bun install
bun run build              # next build → apps/www/out/
PORT=8080 bun serve.ts &   # static server

# In another shell, against http://localhost:8080/
node /tmp/lighthouse-2009/run.mjs
```

The runner is intentionally not committed — it depends on a specific Chrome + Lighthouse + Puppeteer combo that doesn't belong in `package.json`. See `apps/www/.design/demo/lighthouse-baseline.md` for the canonical setup.

## Methodology notes

- **Build target.** `next build` with `output: "export"` (per `apps/www/next.config.ts`) → static HTML in `out/`, served by `apps/www/serve.ts` on a Bun runtime. CI mirrors this exactly.
- **Lighthouse.** v13.2.0, default desktop / mobile throttling presets (10 Mbps · 40 ms · 1× CPU desktop; 1.6 Mbps · 150 ms · 4× CPU mobile).
- **Browser.** Google Chrome headless, `--headless=new --no-sandbox --disable-dev-shm-usage --disable-gpu`.
- **Host machine caveat.** Numbers were captured on a WSL2 dev box, not a CI runner. The shape (desktop > mobile, perf ~100 desktop / mid-90s mobile) is the load-bearing fact; absolute LCP numbers will shift on Ubuntu runners. Re-run once CI has stabilized to tune thresholds.
