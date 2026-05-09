# Branch Protection (`main`)

## What's protected

`main` has GitHub branch protection enabled. The current configuration:

| Setting | Value |
| --- | --- |
| Required status checks (strict, must be green on the head SHA being merged) | `ci`, `api-tests (1/4)`, `api-tests (2/4)`, `api-tests (3/4)`, `api-tests (4/4)`, `Deploy Validation`, `Analyze (javascript-typescript)` |
| `strict` (branch must be up to date with `main` before merge) | `true` |
| Required pull request reviews | none |
| Enforce on admins | `false` |
| Force pushes | blocked |
| Branch deletion | blocked |

`strict: true` means a PR built against an outdated `main` must rebase or merge `main` and re-run CI before the merge button enables. This catches the "two PRs each green in isolation but conflicting at integration" class of failure.

### The `Deploy Validation` umbrella

Scaffold smoke (`Scaffold (docker)` / `Scaffold (vercel)`), `Standalone Example Build`, and `Config & Deploy Mode` live in `.github/workflows/deploy-validation.yml`. The matrix scaffold job is gated by a `Detect scaffold-relevant changes` job and skips on PRs that don't touch templates, examples, or `packages/{api,web,types,cli}/...`.

Naïvely listing those four contexts as required does **not** work. GitHub Actions emits a single check named `Scaffold (${{ matrix.platform }})` (the literal, un-substituted template) when the entire matrix job is skipped, so `Scaffold (docker)` and `Scaffold (vercel)` never appear in `check-runs` for docs-only PRs. Required-context names that don't appear leave `mergeStateStatus: BLOCKED` forever — the original config in this PR hit exactly that. (Single-non-matrix conditional jobs like `Standalone Example Build` *do* report their literal name when skipped, so the bug is matrix-specific.)

The fix is the umbrella job `deploy-validation-required` (`name: Deploy Validation`) at the bottom of the workflow. It uses `needs: [changes, scaffold-smoke, standalone-build, config-validation]` and `if: always()` so it runs on every PR, then asserts each dependency completed with `success` or `skipped`. Branch protection requires only this single name; the conditional jobs vary freely underneath.

## Why this list

The list is the minimum set of checks that demonstrably catches the failure modes we have already hit on `main`:

- `ci` — runs `check-dockerfile-workspace.sh`, `check-railway-watch.sh`, `check-template-drift.sh`, `check-security-headers-drift.sh`, `check-schema-drift.sh`, `check-oauth-helper-drift.sh`, type-check, lint, non-api tests, and the e2e integration tier. The #2206 incident (PR #2198 broke Railway because `check-dockerfile-workspace.sh` hadn't finished when the merge fired) is the canonical reason this gate must be required, not optional
- `api-tests (1/4)`–`(4/4)` — sharded `@atlas/api` test suite, including the real-Postgres migration smoke (`migrate-pg.test.ts`). Migration regressions like #2221 (the broken `keepers` CTE in 0054) only surface against a real database
- `Deploy Validation` — umbrella over `scaffold-smoke` (`docker` + `vercel`), `standalone-build`, and `config-validation` (see "The `Deploy Validation` umbrella" above). Catches scaffold-template drift, standalone-build regressions, and Docker/deploy-mode misconfigurations
- `Analyze (javascript-typescript)` — CodeQL. Static security analysis we want enforced, not advisory

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
      "Analyze (javascript-typescript)"
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
