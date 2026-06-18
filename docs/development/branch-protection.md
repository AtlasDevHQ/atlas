# Branch Protection

Two branches carry protection rules — `main` (the integration branch) and `prod` (the Railway-tracking artifact advanced by `/release`).

# Branch Protection (`main`)

## What's protected

`main` has GitHub branch protection enabled. The current configuration:

| Setting | Value |
| --- | --- |
| Required status checks (strict, must be green on the head SHA being merged) | `ci`, `api-tests (1/4)`, `api-tests (2/4)`, `api-tests (3/4)`, `api-tests (4/4)`, `Deploy Validation`, `Analyze (javascript-typescript)`, `Symlink Stub Build`, `fork-pr-gate` |
| `strict` (branch must be up to date with `main` before merge) | `true` |
| Required pull request reviews | none |
| Enforce on admins | `false` |
| Force pushes | blocked |
| Branch deletion | blocked |

`strict: true` means a PR built against an outdated `main` must rebase or merge `main` and re-run CI before the merge button enables. This catches the "two PRs each green in isolation but conflicting at integration" class of failure.

### The `Deploy Validation` umbrella

Scaffold smoke (`Scaffold (docker)` / `Scaffold (vercel)`), `Standalone Example Build`, `Config & Deploy Mode`, `Boot Build`, and `Boot Smoke` live in `.github/workflows/deploy-validation.yml`. The `changes` detector emits two outputs — `scaffolds` and `boot-smoke` — and each gate consumes whichever applies. Scaffold + standalone skip when the PR doesn't touch templates, examples, or `packages/{api,web,types,cli}/...`; boot-smoke skips when the PR doesn't touch runtime paths (`packages/{api,web,types,schemas,plugin-sdk,sandbox-sidecar}/...`, `plugins/`, `ee/`, `deploy/api/`, the SaaS env fixture, or the lockfile).

`Boot Build` runs **unconditionally** — it's a fast (~30s warm, ~3-4min cold) `docker build --target builder` that catches Dockerfile-shape breakage on every PR regardless of which paths were touched. The cheap unconditional gate exists because a repo-shape change (renamed dir, missing COPY) can break the production image without touching any path in the boot-smoke filter. `Boot Smoke` runs the full ~15min postgres-service + container-start + `/api/health` probe + SaaS env contract check on runtime-relevant PRs only. Both jobs share a single gha cache scope so warm runs are fast.

Naïvely listing those contexts as required does **not** work. GitHub Actions emits a single check named `Scaffold (${{ matrix.platform }})` (the literal, un-substituted template) when the entire matrix job is skipped, so `Scaffold (docker)` and `Scaffold (vercel)` never appear in `check-runs` for docs-only PRs. Required-context names that don't appear leave `mergeStateStatus: BLOCKED` forever — the original config in this PR hit exactly that. (Single-non-matrix conditional jobs like `Standalone Example Build` *do* report their literal name when skipped, so the bug is matrix-specific.)

The fix is the umbrella job `deploy-validation-required` (`name: Deploy Validation`) at the bottom of the workflow. It uses `needs: [changes, scaffold-smoke, standalone-build, config-validation, boot-build, boot-smoke]` and `if: always()` so it runs on every PR, then asserts each dependency completed with `success` (for the unconditional `changes` + `boot-build` + `config-validation`) or `success`/`skipped` (for the path-gated jobs). Branch protection requires only this single name; the conditional jobs vary freely underneath.

## Why this list

The list is the minimum set of checks that demonstrably catches the failure modes we have already hit on `main`:

- `ci` — umbrella over six parallel sub-jobs in `.github/workflows/ci.yml`: `drift` (drift scripts + syncpack + Dockerfile bun-pin), `lint`, `type`, `build` (SDK + widget + `@atlas/web` Next.js + OpenAPI drift), `test-others` (non-api workspace tests), and `test-e2e-integration` (cross-package contract tests). The umbrella mirrors the `Deploy Validation` pattern — branch protection still requires one context (`ci`) and the umbrella fails if any sub-job fails. The historic monolithic `ci` was serial and took ~3m30s; the parallel split lands in ~1m30s. The #2206 incident (PR #2198 broke Railway because `check-dockerfile-workspace.sh` hadn't finished when the merge fired) is the canonical reason this gate must be required, not optional
- `api-tests (1/4)`–`(4/4)` — sharded `@atlas/api` test suite, including the real-Postgres migration smoke (`migrate-pg.test.ts`). Migration regressions like #2221 (the broken `keepers` CTE in 0054) only surface against a real database
- `Deploy Validation` — umbrella over `scaffold-smoke` (`docker` + `vercel`), `standalone-build`, `config-validation`, `boot-build`, and `boot-smoke` (see "The `Deploy Validation` umbrella" above). Catches scaffold-template drift, standalone-build regressions, Docker/deploy-mode misconfigurations, Dockerfile-shape breakage on every PR (`boot-build`), and full container-boot regressions including SaaS env contract drift on runtime-relevant PRs (`boot-smoke`, gated)
- `Analyze (javascript-typescript)` — CodeQL. Static security analysis we want enforced, not advisory
- `Symlink Stub Build` — the `ee-stub-build` job in `.github/workflows/ci.yml`. Replaces `ee/` with the no-op stub at `scripts/ee-stub/` and re-runs `bun run type` + `bun run build` against core. Closes the 1.5.1 architecture-deepening arc (#2017 / milestone #48): the inversion that made every enterprise subsystem reachable from core via a `Context.Tag` is only meaningful if a regression that re-introduces a `core → ee` import beyond `lib/effect/enterprise-layer.ts` actually fails the merge gate. Without this required, a PR that breaks core-only compile can still ship
- `fork-pr-gate` — `.github/workflows/fork-pr-gate.yml`. Runs on every PR open/update/label event via `pull_request_target` and reports on each (passing immediately for same-repo PRs; status is keyed to the head SHA, which `synchronize` re-runs), so it never leaves the merge BLOCKED-forever on internal PRs. For a PR from a **fork** — or any PR whose head-repo provenance can't be positively confirmed as this repo — it auto-applies the `external-fork` label and fails closed until a maintainer applies `external-approved` by hand. See [The fork-PR gate](#the-fork-pr-gate) below

### The fork-PR gate

CodeQL default setup — the required `Analyze (javascript-typescript)` check — **structurally cannot run on PRs from forks** (GitHub doesn't expose repo secrets / the code-scanning upload token to fork-triggered runs). So a fork PR *always* shows that gate as missing, which under the override rules below reads exactly like a "broken required check" and invites an `--admin` merge. That is precisely how #3772 — an unreviewed external fork PR — reached `main`: the agent classified the never-running CodeQL gate as broken and admin-merged.

`fork-pr-gate` removes the ambiguity. It is a tiny `pull_request_target` workflow (base-repo token, **never checks out or runs fork code** — it only reads event metadata and sets a label + status) that:

- passes immediately for same-repo PRs (`head.repo.fork == false`), so internal PRs are unaffected;
- for fork PRs, applies the `external-fork` label (a permanent, searchable marker — `gh pr list --label external-fork`) and **fails** until a maintainer applies `external-approved`.

The `external-approved` label *is* the human sign-off: a person read the diff and vouched for the external code. A red `fork-pr-gate` is **missing-by-design, not broken** — see "When override is not legitimate" below. This converts "trust the agent's broken-gate judgment" into "a human must physically approve external code", with no impact on the internal solo-dev flow.

## Why required reviews are off

Atlas is currently a solo project run with parallel Claude Code sessions. Required reviews would block every merge — there's no second author. If/when the team grows, revisit this.

## Why `enforce_admins` is off

Branch protection is a safety rail, not a straitjacket. There exist edge cases where the required gate cannot complete and the only way to unblock production is to bypass it. Examples:

- GitHub Actions outage — workflow runs hang in `queued` state for hours
- A required check is pinned to a SHA that no longer reflects the PR (e.g. after a force-push the old check stays green and the new one never starts)
- An infrastructure incident requires a single-line revert and the gate workflow itself is the thing that's broken

For these cases the override path is `gh pr merge --admin`. With `enforce_admins: true` even the admin would be blocked and there would be no way to ship a hot-fix. The trade-off is that the discipline (don't admin-merge through a slow gate, only a broken one) sits in process rather than in policy.

## When override is legitimate

Use `gh pr merge --admin` **only** when:

1. The required check itself is broken (workflow stuck, infra outage, runner platform issue) — verify by inspecting the workflow run and confirming it cannot complete
2. The change is a hot-fix to restore production, the gate's pass/fail signal is unavailable, and the alternative is leaving production broken

When you do override, document the reason in the PR description or the merge commit message so the audit trail is recoverable. "Tests are slow" is not legitimate. "I want to land this faster" is not legitimate.

## When override is not legitimate

- The check is pending and you don't want to wait — wait. The 1.4.x cadence already saw two CI gaps caused by exactly this (#2186, #2201, plus #2206 itself). The cost of waiting 5–15 minutes is much smaller than the cost of breaking Railway boot for everyone
- The check failed and you believe the failure is unrelated — investigate first. Re-run the workflow if it looks like a flake. If you can prove the failure is unrelated and infra is broken, that's a "broken gate" case (above) — but only after you've proven it
- "It worked locally" — local `/ci` and CI run different code paths (e.g. the `dist/` artifact parity issue documented in `feedback_ci_dist_artifact_parity.md`). The gate exists because local-pass doesn't imply CI-pass
- **A gate that is missing-by-design on this class of PR** — a fork PR has no CodeQL `Analyze` run and a red `fork-pr-gate` *by design*. Neither is "broken". Admin-merging an external fork PR is **never** legitimate for an agent — apply `external-approved` after a human security review instead. See [The fork-PR gate](#the-fork-pr-gate) and #3772

## Reproducing the configuration

The protection was applied via `gh api PUT repos/AtlasDevHQ/atlas/branches/main/protection` with this body:

```json
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "ci",
      "api-tests (1/4)",
      "api-tests (2/4)",
      "api-tests (3/4)",
      "api-tests (4/4)",
      "Deploy Validation",
      "Analyze (javascript-typescript)",
      "Symlink Stub Build",
      "fork-pr-gate"
    ]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
```

Inspect the live config with:

```bash
gh api repos/AtlasDevHQ/atlas/branches/main/protection
```

## When to update this list

Add a context to `required_status_checks.contexts` when:

- A new CI workflow gates a class of regression that has actually caused a production incident (the bar is "we got burned", not "this would be nice")
- A new required job is added to an existing workflow with a stable name

Remove a context when:

- The workflow it refers to is removed or renamed
- The check has been a source of unfixable flakes for so long that requiring it does more harm than good (in which case fix the flake first; removal is a last resort)

PRs that change the required-checks list should reference the incident or motivation in the description.

# Branch Protection (`prod`)

The `prod` branch is the Railway-tracking artifact: each `/release` fast-forwards it to the tagged SHA via `git push origin <tag-sha>^{}:prod --force-with-lease`, and the 5 prod services (`api`, `api-eu`, `api-apac`, `web`, `www`) deploy from it. See [ADR-0008 § Release branches: none](../adr/0008-versioning-and-release-tags.md#release-branches-none) and [release-process.md § Mental model](./release-process.md#mental-model).

## What's protected

| Setting | Value |
| --- | --- |
| Required status checks | none |
| Required pull request reviews | none |
| Enforce on admins | `false` |
| Force pushes | **allowed** (required so `/release` can fast-forward with `--force-with-lease`) |
| Branch deletion | blocked |

The protection here is intentionally minimal — `prod` is not a code review surface, and the integrity property we care about is "advanced only by `/release`", which is enforced by convention + the `--force-with-lease` semantic rather than by GitHub.

## Why force pushes are allowed

`/release` fast-forwards `prod` from any SHA (the latest tag), which is a force-push from GitHub's perspective even though it advances the branch monotonically in practice. `--force-with-lease` (never bare `--force`) provides concurrency safety: a second `/release` running against an out-of-date local view of `origin/prod` is refused.

## Why no required checks

The `/ci` gate has already passed on the SHA being released — `/release` refuses to tag if `/ci` fails. Layering a GitHub-side required-check on `prod` would duplicate that gate and slow tag-pushes for no risk reduction. If "Wait for CI" is enabled on the Railway side (the optional belt-and-braces in `release-process.md`), CI runs on `prod` get the same treatment as `main` runs.

## Why no required reviews

Same reasoning as `main` — solo developer, parallel-Claude workflow. Revisit if the team grows.

## What's NOT enforced by GitHub

- **"No PRs target `prod`"** — there is no GitHub setting that disallows PR creation against a specific branch. The convention is: only `/release` ever pushes to `prod`. If someone opens a PR targeting `prod` by mistake, close it; don't merge.
- **"Only `/release` advances `prod`"** — also a convention. The skill is the canonical path; manual `git push origin <sha>^{}:prod --force-with-lease` is permitted for rollbacks (documented in `.claude/commands/release.md`).

If the team grows beyond solo, both can be tightened via `restrictions.users` (push allowlist) and a CODEOWNERS rule that fails PRs targeting `prod`.

## Reproducing the configuration

```bash
gh api PUT repos/AtlasDevHQ/atlas/branches/prod/protection -F enforce_admins=false \
  -F required_pull_request_reviews=null \
  -F restrictions=null \
  -F allow_force_pushes=true \
  -F allow_deletions=false \
  -F required_status_checks=null
```

The branch must exist before protection can be applied. Either let `/release` create it on first run and apply protection immediately after, or create an empty `prod` branch preemptively:

```bash
git push origin main:prod  # initial fast-forward; subsequent /release calls force-with-lease
```
