# Atlas review agents

Specialist code-review subagents used as the **internal-review panel** in the agent loops
(`docs/agents/loops.md`, L2). They are invoked via the `Agent` tool with a fresh context so a
reviewer never just rubber-stamps the implementer's own diff.

## Provenance

These four agents are **vendored and tuned** from
[anthropics/claude-code `plugins/pr-review-toolkit`](https://github.com/anthropics/claude-code/tree/main/plugins/pr-review-toolkit).
We kept the upstream review *methodology* and rewrote every project-specific reference to
match Atlas's actual conventions (Pino `log.warn`/`console.debug`, `requestId` on 500s,
`Data.TaggedError`, the `catch { return false }`-is-a-bug rule, the isolated test runner,
`createConnectionMock`, `-pg` fixtures, the `@useatlas/types` ↔ `@useatlas/schemas` SSOT) —
not the upstream's Sentry/Statsig/`errorIds.ts` references.

We deliberately did **not** vendor the toolkit's generic `code-reviewer` and `code-simplifier`
agents: the existing `/code-review` and `/simplify` skills already cover Atlas's conventions
and remain the canonical generic passes. These four add the specialist axes a single generic
pass spreads thin.

### ⚠️ We use these for a different JOB than upstream, and the difference bites

Upstream's toolkit reviews **someone else's finished PR, once**. `/review-panel` runs them as
an **iterative convergence loop on the author's own in-progress work**, re-running until CLEAN.
Those have different failure modes, and two upstream defaults are actively wrong for ours:

- **"Review only the changed lines."** Correct for a one-shot review of a finished diff. In a
  convergence loop it makes a defect's *adjacent twin* structurally invisible — the twin is an
  unchanged line, so no reviewer can report it, round after round. `/review-panel` Step 2
  therefore widens the scope to *changed lines plus the enclosing declaration*.
- **Fully fresh context every round.** Correct for independence, and it is what stops a
  reviewer rubber-stamping the implementer. But a one-shot review has no "previous round's
  fix" to audit, so upstream has no notion of one — and round N cannot check round N−1's work
  without being told what it was. Step 2 passes the prior fix commits in as an explicit audit
  target while leaving everything else fresh.

Neither is an upstream bug. They are defaults for a job we are not doing. Keep both divergences
when re-vendoring — see "Updating from upstream" below.

## The panel

| Agent | Axis | Tuned to |
| --- | --- | --- |
| `silent-failure-hunter` | error handling & silent failures | CLAUDE.md § Error Handling |
| `type-design-analyzer` | type invariants & safety | CLAUDE.md § Type Safety + § Effect.ts |
| `pr-test-analyzer` | test coverage & discipline | CLAUDE.md § Testing |
| `comment-analyzer` | comment accuracy & idiom | comment-density + `// intentionally ignored:` |

All four are **advisory and read-only** (`tools: Read, Grep, Glob, Bash`) — they report
findings, they do not edit code.

## Usage

- **In the loop:** the L2 loop fans all four out in parallel against the implementer's
  diff, then hands findings back to address before `/ci` + `/pr`.
- **Ad hoc:** they auto-trigger by `description` match, or invoke one explicitly, e.g.
  "use silent-failure-hunter on this diff".

## Updating from upstream

When the upstream toolkit changes, re-diff the vendored copies and re-apply the Atlas tuning.
These are pinned by copy, not by marketplace, so updates are intentional — keep the
Atlas-specific standards blocks intact when pulling upstream methodology changes.

⚠️ **Two things to re-apply every time, because upstream will keep asserting the opposite:**
the widened review scope and the prior-fix audit target (see the job-mismatch section above).
Both live in `/review-panel` Step 2 rather than in the agent files, so a clean re-vendor of the
agents does not lose them — but a re-vendor that also "corrects" the command back to
`review only this diff` restores the blind spot the widening exists to close.
