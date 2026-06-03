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
EXCLUDE='^(stripe|react-day-picker|diff|just-bash|@vercel/sandbox|fumadocs-mdx|syncpack|esbuild|shadcn|@duckdb/node-api|chat|@chat-adapter/.*)$'
bun outdated --filter '*' 2>/dev/null \
  | grep -E '^\| ' | grep -vE '^\| Package' | grep -vE '\(peer\)|\(optional\)' \
  | sed -E 's/^\| +//; s/ +\|.*$//; s/ \(dev\)//' \
  | sort -u | grep -vE "$EXCLUDE" > /tmp/groupA.txt
wc -l /tmp/groupA.txt && cat /tmp/groupA.txt   # eyeball it
```
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
| `better-auth` 1.6.13 ↔ `kysely` **0.28.17** (NOT 0.29) | `@better-auth/kysely-adapter` imports `DEFAULT_MIGRATION_TABLE`, which kysely 0.29 dropped from its top-level exports → standalone Turbopack build breaks | root `package.json` `"overrides": { "kysely": "0.28.17" }` (templates already pin it). Lift when better-auth stops importing the removed symbol. See `reference_better_auth_kysely_029_incompat` |

When a new coupling bites, add a row here and a `reference_*` memory.

---

## Gotchas (hard-won — read before sweeping)

- **`bunfig.toml` `minimumReleaseAge = 172800` (48h)** quarantine: the `*` in `bun outdated` means a version is held by it. `bun update` (no `--latest`) installs the gate-eligible (≥48h-old) version and rewrites the `^` floor to it — inherently a within-major sweep.
- **CI-only failure #1 — frozen lockfile.** After `syncpack fix` rewrites ranges, you MUST `bun install` to update `bun.lock`, or CI's `bun install --frozen-lockfile` fails with "lockfile had changes, but lockfile is frozen". Local type/test won't catch it.
- **CI-only failure #2 — the standalone Turbopack build.** `bun run type` (tsgo) and unit tests do NOT exercise the ESM named-export resolution that `next build` of `examples/nextjs-standalone` does (it Turbopack-bundles `packages/api/src/lib/auth/server.ts` → better-auth → adapters). An upstream that drops/moves a named export (the kysely case) only fails there — under **Deploy Validation → Standalone Example Build**. Always run it locally before the PR.
- **Do NOT `rm -rf node_modules` to "test a fresh install."** A scripts-on `bun install` aborts on `@useatlas/types`' `prepare` (`bun x tsc` fetches the deprecated `tsc` registry shim → `TS6046 --moduleResolution` before root `.bin/tsc` is linked), leaving an **incomplete tree** → cascade of TS2307 (`next/navigation`), and bun's "no changes" short-circuit won't repair it. If you must wipe: `rm -rf node_modules && bun install --ignore-scripts` (full tree + bins, no prepare race), then `bun run type` rebuilds dist packages in root context. (`reference_bun_x_tsc_railpack_prepare`.)
- **`.syncpackrc.json` intentionally leaves some ranges loose** — peer ranges on published pkgs, and framework deps in templates/web (e.g. `better-auth` in `@atlas/web` stays `^1.6.9` by a versionGroup ignore; `react-resizable-panels` stays `^4`). Don't "fix" these; syncpack lint passing is the source of truth.
- **Transient infra flakes.** `Boot Build` / `canonical-eval` failing fast on `registry-1.docker.io ... Client.Timeout` are Docker-Hub timeouts, not your change. Re-run the job (`gh run rerun --job <id> -R AtlasDevHQ/atlas`); they're non-required checks anyway (merge gate = `ci` + `api-tests` shards + `Deploy Validation` + `Analyze (JS/TS)` + `Symlink Stub Build`).
- **Published `@useatlas/*` refs.** A sweep must NOT bump a published-package version ref in `create-atlas/templates/*` ahead of the publish — `check-published-symbols.ts` + the version-bump-ordering rule. Within-major sweeps of third-party deps don't trip this; bumping a `@useatlas/*` package does.

---

## Rules

- One Group A PR; one PR per Group B major. Never mix majors into the sweep.
- Always run the standalone build locally before the PR — it's the gate most likely to catch a dep break that type/test miss.
- Wait for CodeRabbit + Codex before merging (they catch dep-graph/security issues the in-house agents miss).
- A dep refresh is a `v0.0.x` patch-rollup tag, no milestone. After Group A + whichever Group B PRs land green, `/release` cuts the tag.
- Found a new coupled constraint or gotcha? Add it here and a `reference_*` memory in the same pass.
