Refresh npm dependencies across the monorepo. Renovate is **Docker-only** (`renovate.json` → `enabledManagers: ["dockerfile"]`), so npm deps drift until a manual sweep. This command does the sweep the way it actually works in this repo — including the gotchas that only CI (not local type/test) catches. Ships as a **patch-rollup tag** (`v0.0.x`, no milestone — like v0.0.5), per [ADR-0008](../../docs/adr/0008-versioning-and-release-tags.md).

Two-group model — **never mix them in one PR**:

- **Group A — within-major sweep** (minor/patch). One batched PR. `bun update` can't cross a `^` major, so a single allowlisted sweep is safe to review as a unit.
- **Group B — major bumps.** One PR **per package**, security-sensitive first. Each needs changelog/migration reading and (for sandbox/billing/auth) a staging soak. Held out of the Group A sweep by an explicit exclude list.

---

## Group A — within-major sweep

**Step 1: Branch.**
```bash
git checkout main && git pull && git checkout -b chore/deps-group-a-<tag>   # e.g. chore/deps-group-a-v0.0.7
```

**Step 2: Derive the allowlist** — every outdated direct dep, minus the Group B majors. `bun outdated` only lists **direct** deps (transitives like `kysely` won't appear — see coupled-bump table).
```bash
EXCLUDE='^(stripe|react-day-picker|diff|just-bash|@vercel/sandbox|fumadocs-.*|syncpack|esbuild|shadcn|@duckdb/node-api|chat|@chat-adapter/.*|@playwright/test|@useatlas/types)$'
bun outdated --filter '*' 2>/dev/null \
  | sed -E 's/\x1b\[[0-9;]*m//g' | sed 's/│/|/g' \
  | grep -E '^\| ' | grep -vE '^\| Package' | grep -vE '\(peer\)|\(optional\)' \
  | sed -E 's/^\| +//; s/ +\|.*$//; s/ \(dev\)//' \
  | sort -u | grep -vE "$EXCLUDE" > /tmp/groupA.txt
wc -l /tmp/groupA.txt && cat /tmp/groupA.txt   # eyeball it
```
- **The two `sed` passes are load-bearing on bun 1.3.13.** `bun outdated` renders the table with **Unicode box-drawing pipes (`│`, U+2502) and ANSI colour codes even when piped** — NOT ASCII `|`. Without `sed -E 's/\x1b\[[0-9;]*m//g'` (strip ANSI) + `sed 's/│/|/g'` (normalize the bar), the `grep -E '^\| '` matches **zero rows** and the allowlist comes out empty (silent — you only notice because `wc -l` says 0). Eyeball the count every time.
- **`@useatlas/types` is excluded** — it's a workspace-published package; a sweep must never bump its ref (trips `check-published-symbols` / version-bump-ordering). **`@playwright/test` is excluded** — see the playwright row in coupled constraints (bumping it splits `playwright-core` against the `@axe-core/playwright` peer).

Re-check the EXCLUDE list against `bun outdated` each time — when a Group B major lands, drop it from EXCLUDE; when a new major appears, add it.

**Step 3: Apply.** **Both** `--filter '*'` **and** the explicit package names are load-bearing — keep them:
- Without the **names**, bare `bun update --filter '*'` reports "no changes" for workspace-only deps (ai, hono, effect, mysql2, @tanstack/*, tailwindcss…).
- Without `--filter '*'`, `bun update <pkg>` only re-resolves the lockfile and the **root** manifest — it does **not** rewrite sub-workspace `package.json` `^` floors (verified: `bun update hono` left a downgraded `packages/api` floor untouched). The floor cascade across every workspace is what `--filter '*'` does.

(Verified on the pinned `bun@1.3.13` — `engines.bun` is `>=1.3.13 <1.3.14`. `bun update` here accepts `--filter`; if a future bun drops it, re-test before changing this line. See `reference_bun_update_workspace_cascade` in auto-memory.) `bun update` (no `--latest`) stays inside the existing `^` range, so no major can cross.
```bash
bun update --filter '*' $(tr '\n' ' ' < /tmp/groupA.txt)
bun x syncpack fix          # reconcile ranges across workspaces (.syncpackrc.json)
bun install                 # ← REQUIRED: reconcile bun.lock to syncpack's package.json edits,
                            #   else CI's `bun install --frozen-lockfile` fails (CI-only failure #1)
```

**Step 4: Verify no major crossed** (belt-and-suspenders — `^` ranges already block it):
```bash
grep -oE '"(stripe|react-day-picker|just-bash|@vercel/sandbox|fumadocs-mdx|diff|syncpack|shadcn|@duckdb/node-api)@[^"]*"' bun.lock | sort -u
```
Any moved major = a Group B leak; remove it (restore that range) and re-run.

**Step 5: Reconcile coupled bumps + code.** See the **Coupled constraints** table below. Then make any code edits the bumps force — e.g. an `@ts-expect-error` that a fixed upstream type now makes *unused* (tsgo errors on an unused directive, so it must be deleted). Find them via the type-check.

**Step 6: Gate.** The gate is the **full `/ci`** — not a hand-picked subset; see [`ci.md`](ci.md) for its current check set (the source of truth — don't re-enumerate it here, it drifts). A dep sweep changes `package.json` + templates, so the drift/parity checks `/ci` runs — template-drift and the `@useatlas/*` **published-symbols** check especially — are the ones most likely to catch a sweep mistake. Run the full `/ci`, **plus** the two things it does NOT cover:
```bash
# 1. frozen-lockfile parity (CI-only failure #1) — must say "no changes"
bun install --frozen-lockfile
# 2. the standalone Turbopack build (CI-only failure #2) — /ci doesn't build the example
rm -rf examples/nextjs-standalone/.next
bun run --filter '@atlas/nextjs-standalone' build
```
For fast iteration before the final `/ci`, `cd packages/api && bun run scripts/test-isolated.ts --affected` (not the full suite). Then `/pr` to open the PR, wait for **CodeRabbit + Codex** (never merge before the bots), squash-merge, `/reset`.

---

## Group B — major bumps (one PR each, security-first)

> **Coverage gap to own:** the Step-2 EXCLUDE drops each Group B package **entirely** from the within-major sweep — including its *safe within-major* patches. So a patch/minor security fix for a held package (e.g. `stripe`, `@vercel/sandbox`) is picked up by **neither** group by default. Mitigation: (a) every Group B PR should bump to the **latest within-major** as its baseline even when you're not yet ready for the major, and (b) treat a within-major security advisory on a held package as its own fast-track PR — don't wait for the major. When you do take a package's major, drop it from EXCLUDE so the sweep covers it again.

Sequence by blast radius, not alphabetically:

1. **`@vercel/sandbox`** — SaaS-pinned prod sandbox (`deploy/api/atlas.config.ts`, `networkPolicy: "deny-all"`). Verify the deny-all policy + per-service `VERCEL_*` env still wire; **soak on staging**. Highest risk.
2. **`just-bash`** — explore/SQL sandbox backend. Verify the read-only isolation contract.
3. **`stripe`** — pinned API-version bump + Better-Auth Stripe plugin compat (billing). Read the API-version changelog.
4. **`react-day-picker`** — date-picker API breaks in web.
5. **`diff`** — dashboard-versioning / spec-drift consumers.
6. Low-risk / defer (batch or skip): `fumadocs-mdx`, `syncpack`, `shadcn` (dev CLI), `esbuild` (obsidian plugin dev), `@duckdb/node-api` (r-series). None gate the tag.

Each: branch → bump the one package (`bun update --filter '*' <pkg>@<major>` or edit the range + `bun install`) → read its changelog/migration notes → `/ci` + the relevant build → PR → bots → merge.

---

## Coupled constraints (bump these together, or pin)

These won't show up from `bun outdated` reasoning alone — they're cross-package version locks:

| Constraint | Why | Action |
|---|---|---|
| `zod` 4.4.x ↔ `@modelcontextprotocol/sdk` ≥1.29 | else `packages/mcp` fails `ZodString not assignable to AnySchema` | both are in the allowlist; keep them moving together |
| ~~`better-auth` ↔ `kysely` **0.28.17**~~ **(override LIFTED — `v0.0.21` sweep)** | `@better-auth/kysely-adapter` ≤1.6.16 *imported* `DEFAULT_MIGRATION_TABLE`, dropped from kysely 0.29's top-level exports. **better-auth 1.6.19 fixed it** — the adapter now *defines the constant locally* ("without importing from a moving path") and declares the peer `kysely: "^0.28.17 \|\| ^0.29.0"`. | **Override removed** from root + both templates. Workspace lockfile stays kysely 0.28.17 by inertia (no churn); fresh scaffolds float to 0.29.x, which better-auth now supports. If a future kysely break recurs, re-pin. See `reference_better_auth_kysely_029_incompat` |
| `@playwright/test` ↔ `@axe-core/playwright` peer (`playwright-core`) | `@axe-core/playwright`'s peer is `playwright-core: ">=1.0.0"` (resolves to the **highest** gate-eligible), while `@playwright/test`→`playwright` pins an **exact** `playwright-core`. Once a newer `playwright-core` becomes gate-eligible, bumping `@playwright/test` desyncs the two → **two `playwright-core` versions** → e2e `Page` type clash (`bun run type` fails). Main's single-version state is **inertia-only** (its lockfile predates the newer release); a fresh resolve would split it too. | **Hold `@playwright/test` out of the sweep** (it's in EXCLUDE) — a dev-only test runner one patch behind costs nothing. The alternative is a permanent `"overrides": { "playwright-core": "<exact>" }` synced on every playwright bump; not worth it. See `reference_playwright_axe_core_peer_split` |
| `fumadocs-core` / `fumadocs-ui` ↔ `fumadocs-openapi` (**major lockstep**) | `fumadocs-openapi`'s **major** tracks core/ui's **breaking minor**. openapi `10.x` peer-deps `fumadocs-core/ui ^16.9.0` and imports `renderTranslation` (`fumadocs-core/i18n`) + `useTranslations` (`fumadocs-ui/contexts/i18n`); core/ui **16.10** renamed those to `defineTranslations` / `useI18n`, and openapi **11.x** is the version that adopts the new API. A within-major sweep that bumps core/ui 16.9→16.10 but holds openapi in 10.x ships an **incompatible pair** → `next build` of `apps/docs` fails (`Export … doesn't exist in target module`) and the **Railway docs deploy breaks** — caught after #3811. `bun outdated` won't flag it: both are *within-major* moves. | **Hold the whole `fumadocs-*` family out of the sweep** (now in EXCLUDE) and **pin core/ui below 16.10** (`~16.9.3`) in root + `apps/docs/package.json` until you do the `fumadocs-openapi` 10→11 migration deliberately — it also renames `createAPIPage`→`createOpenAPIPage` and reshapes the page-factory signature (`createOpenAPIPage(options)` returning a client component with `payload`/`preloaded` props). Bump core/ui **and** openapi **together** across the major, with a local `apps/docs` build. See `reference_fumadocs_openapi_core_major_lockstep` |

When a new coupling bites, add a row here and a `reference_*` memory.

**Lifting an override cleanly (controlled, not `rm bun.lock`):** to drop an override without uncontrolled churn, remove it from `package.json` and run a plain `bun install` — the transitive stays at its locked version by inertia (frozen-lockfile replays it), so there's **no version change in the workspace** and the diff is tiny. **Never `rm bun.lock` to "lift" an override** — a full regen re-resolves *everything* within ranges (ignoring the allowlist) and silently bumps Group-B/held packages (`@vercel/sandbox`, `stripe`) plus major transitives (e.g. `graphql 16→17`) and drops test deps. Measured once: targeted = ~291 within-major lines, `rm bun.lock` = 632 lines incl. a Group-B leak. If you genuinely want the transitive to *move* (not just unpin), do it as its own change with the relevant soak.

---

## Gotchas (hard-won — read before sweeping)

- **`bunfig.toml` `minimumReleaseAge = 172800` (48h)** quarantine: the `*` in `bun outdated` means a version is held by it. `bun update` (no `--latest`) installs the gate-eligible (≥48h-old) version and rewrites the `^` floor to it — inherently a within-major sweep.
- **CI-only failure #1 — frozen lockfile.** After `syncpack fix` rewrites ranges, you MUST `bun install` to update `bun.lock`, or CI's `bun install --frozen-lockfile` fails with "lockfile had changes, but lockfile is frozen". Local type/test won't catch it.
- **CI-only failure #2 — the standalone Turbopack build.** `bun run type` (tsgo) and unit tests do NOT exercise the ESM named-export resolution that `next build` of `examples/nextjs-standalone` does (it Turbopack-bundles `packages/api/src/lib/auth/server.ts` → better-auth → adapters). An upstream that drops/moves a named export (the kysely case) only fails there — under **Deploy Validation → Standalone Example Build**. Always run it locally before the PR.
- **Do NOT `rm -rf node_modules` to "test a fresh install."** A scripts-on `bun install` aborts on `@useatlas/types`' `prepare` (`bun x tsc` fetches the deprecated `tsc` registry shim → `TS6046 --moduleResolution` before root `.bin/tsc` is linked), leaving an **incomplete tree** → cascade of TS2307 (`next/navigation`), and bun's "no changes" short-circuit won't repair it. If you must wipe: `rm -rf node_modules && bun install --ignore-scripts` (full tree + bins, no prepare race), then `bun run type` rebuilds dist packages in root context. (`reference_bun_x_tsc_railpack_prepare`.)
- **`.syncpackrc.json` intentionally leaves some ranges loose** — peer ranges on published pkgs, and framework deps in templates/web (e.g. `better-auth` in `@atlas/web` stays `^1.6.9` by a versionGroup ignore; `react-resizable-panels` stays `^4`). Don't "fix" these; syncpack lint passing is the source of truth.
- **Transient infra flakes.** `Boot Build` / `canonical-eval` failing fast on `registry-1.docker.io ... Client.Timeout` are Docker-Hub timeouts, not your change. Re-run the job (`gh run rerun --job <id> -R AtlasDevHQ/atlas`); they're non-required checks anyway (merge gate = `ci` + `api-tests` shards + `Deploy Validation` + `Analyze (JS/TS)` + `Symlink Stub Build`).
- **Run `lint` BEFORE building examples / regenerating templates — build artifacts poison it.** `bun run lint` globs `examples/ create-atlas/`. If you've run the standalone build first, `examples/nextjs-standalone/.next/` (bundled minified JS) gets linted → tens of thousands of bogus `no-explicit-any`/`ban-ts-comment` errors (saw 36k). Same for the template-drift check, which regenerates the gitignored `create-atlas/templates/*/src/`. CI doesn't hit this (lint runs on a clean checkout). Fix: `rm -rf examples/nextjs-standalone/.next` and `git clean -fdX create-atlas/templates/` before lint, or run lint first.
- **Sandbox/explore unit tests fail locally without the sidecar.** `python.test.ts`, `explore-backend.test.ts`, `explore-workspace-override.test.ts` (`packages/api/src/lib/tools/__tests__/`) hang/timeout (e.g. `rejects when ATLAS_SANDBOX_URL is not set` at 5000ms) when no sandbox sidecar/Docker is running — **identical failures on clean `main`** in the same env; they pass in CI. To prove a test failure is environmental vs. your sweep: `git stash`, `bun install` (→ main deps), re-run the file, compare, then `git stash pop` + `bun install`.
- **Published `@useatlas/*` refs.** A sweep must NOT bump a published-package version ref in `create-atlas/templates/*` ahead of the publish — `check-published-symbols.ts` + the version-bump-ordering rule. Within-major sweeps of third-party deps don't trip this; bumping a `@useatlas/*` package does.

---

## Rules

- One Group A PR; one PR per Group B major. Never mix majors into the sweep.
- Always run the standalone build locally before the PR — it's the gate most likely to catch a dep break that type/test miss.
- Wait for CodeRabbit + Codex before merging (they catch dep-graph/security issues the in-house agents miss).
- A dep refresh is a `v0.0.x` patch-rollup tag, no milestone. After Group A + whichever Group B PRs land green, `/release` cuts the tag.
- Found a new coupled constraint or gotcha? Add it here and a `reference_*` memory in the same pass.
