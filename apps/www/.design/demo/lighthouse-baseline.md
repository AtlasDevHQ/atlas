# `/demo` Lighthouse baseline

Closes the Lighthouse half of #1945. The `/demo` Bucket 6 design pass (#1942) shipped without measuring against a regression baseline; this captures the first one so future passes have something to diff against.

`/demo` is marketing-adjacent — landing funnels here, so the surface is treated like the other public-facing pages.

## Results — 2026-05-02

| Run | Performance | Accessibility | Best Practices | SEO |
|---|---|---|---|---|
| Desktop · cold | **100** | **100** | **100** | **100** |
| Desktop · active | **100** | 96 | **100** | **100** |
| Mobile · cold | 87 | **100** | **100** | **100** |
| Mobile · active | 87 | 96 | **100** | **100** |

### Web vitals

| Run | LCP | FCP | TBT | CLS | Speed Index |
|---|---|---|---|---|---|
| Desktop · cold | 777 ms | 246 ms | 0 ms | 0 | 246 ms |
| Desktop · active | 780 ms | 251 ms | 0 ms | 0 | 251 ms |
| Mobile · cold | 4069 ms | 906 ms | 91 ms | 0 | 906 ms |
| Mobile · active | 4068 ms | 906 ms | 88 ms | 0 | 906 ms |

## What "cold" and "active" mean here

- **Cold** — first load of `/demo` for a visitor with no prior demo session. Renders the email-gate hero, dataset preview card, and four sample-query chips (the surface introduced by #1942).
- **Active** — same load, but `sessionStorage` is pre-seeded with a real bearer from `POST /api/v1/demo/start`. The component short-circuits the email gate and mounts `<AtlasChat>` (sidebar + empty conversation surface + chat input). The token comes from a fresh demo session for each run; the page never gets past mounting the empty chat surface (no LLM key was set, so no actual chat turn was issued — see methodology notes).

## Findings worth tracking

1. **Mobile LCP is the weakest link.** 4.07 s on Moto-G-Power-class hardware is well above the 2.5 s "good" threshold. The cold surface has no images and no third-party scripts, so this is JS execution: hydrating React + Tailwind + the page module on a 4× CPU-throttled, 1.6 Mbps-throttled profile. Worth keeping an eye on; not actionable as part of this baseline.
2. **Active state regresses Accessibility from 100 → 96.** Single audit failing: `color-contrast` on the "Sign up to connect your data" link in the demo banner (`text-primary` against the `bg-muted/40` banner background, in `packages/web/src/app/demo/page.tsx`). Filed as #2010; not fixed inline per the bug-pass discipline.
3. **CLS is 0 across all runs** — the `#1942` two-column hero holds layout cleanly, including the email form's mobile stack.
4. **TBT is effectively zero on desktop and ~90 ms on mobile** — well within budget. The active state didn't regress TBT meaningfully because `<AtlasChat>` mounts with an empty conversation list (no message rendering work).

## CI Lighthouse budget — decision

**No CI Lighthouse budget exists today.** Verified by:

- `grep -l -i 'lighthouse\|lhci' .github/workflows/* apps/www/* packages/web/*` → no matches.
- `grep -i 'lighthouse\|lhci' package.json apps/www/package.json packages/web/package.json` → no matches.
- No `lighthouserc.{json,js,cjs}`, no `lhci.config.*`, no `lighthouse-budget.json` anywhere in the tree.

The marketing surfaces (`/`, `/pricing`, `/demo`) currently have no automated Lighthouse regression check. **Setting one up is out of scope for #1945** — that issue is scoped as measurement + tracking; standing up `@lhci/cli` against Railway preview URLs is its own piece of work (workflow file, GitHub secrets for the LHCI server token or temporary public storage, baseline thresholds per surface, decisions about flake tolerance under shared CI runners).

Filed as #2009.

## Methodology

- **Build target.** `bun run build` against `packages/web` (Next.js 15 production build, server-rendered `/demo` is `○ (Static)` per the build manifest), served via `next start` on `:3000`. The Hono API ran via `bun run --hot packages/api/src/api/server.ts` on `:3001` to back `POST /api/v1/demo/start` for the active runs.
- **Lighthouse.** v13.2.0, run via the `startFlow` user-flow API so `evaluateOnNewDocument` could pre-seed `sessionStorage` on the same Puppeteer page Lighthouse audited. Standard Lighthouse `lighthouse(url, …)` opens its own tab, which doesn't share `sessionStorage` with a pre-seeded tab — that mistake hid the active state on the first run and is documented in the runner script comments.
- **Browser.** Google Chrome 146.0.7680.164 (Linux x64), `--headless=new --no-sandbox --disable-dev-shm-usage --disable-gpu`. The exact build is a snapshot of what was on the host on 2026-05-02 — don't update it piecemeal; re-run the full baseline if the host meaningfully changes.
- **Throttling presets.** Lighthouse defaults at the time of measurement: desktop = 10 Mbps / 40 ms RTT / 1× CPU; mobile = 1.6 Mbps / 150 ms RTT / 4× CPU. Lighthouse documents the mobile profile as a Moto-G-class device and has renamed it before (Moto G4 → Moto G Power) — the throttling numbers are the durable facts here, not the device name.
- **Active-state caveat.** With `ATLAS_PROVIDER` / `ANTHROPIC_API_KEY` unset locally, the chat surface mounts but no agent turn was produced. The active baseline therefore covers "post-gate, empty conversation surface" — the moment immediately after a user submits their email. A "post-first-turn" measurement would need either a configured LLM or a stubbed chat endpoint and is not part of this baseline.
- **Host machine caveat.** Run on a WSL2 box, not a CI runner. Numbers shouldn't be compared 1:1 against the eventual CI budget — the relative shape (desktop ≫ mobile, active ≈ cold for this surface) is what's load-bearing here. Re-run when standing up the CI workflow to set the actual thresholds.

## Reproducing

The runner is intentionally a scratch script under `/tmp` (not committed) — it depends on a running dev/prod Atlas stack and doesn't belong in the repo. Recreate with:

```bash
# Boot the stack
bun install
bun run db:up
cd packages/web && bun run build && bun run start &     # :3000 prod
bun run --hot packages/api/src/api/server.ts &          # :3001 api

# Install runner deps
mkdir -p /tmp/lighthouse-1945 && cd /tmp/lighthouse-1945
bun add -d lighthouse@13 puppeteer-core chrome-launcher

# Runner — see the inline notes for the active-state seeding pattern
node run.mjs
```

The runner's job: launch Chrome via `chrome-launcher`, connect Puppeteer to it, register an `evaluateOnNewDocument` hook that seeds `atlas-demo-{token,email,expires}` from a fresh `POST /api/v1/demo/start`, then call `startFlow(page, …).navigate(URL)` with `disableStorageReset: true` so the seeded storage survives Lighthouse's navigation. Four runs, two form factors × two states.
