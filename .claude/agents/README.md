# Atlas review agents

Specialist code-review subagents used as the **internal-review panel** in the agent loops
(`docs/agents/loops.md`, L2). They are invoked via the `Agent` tool with a fresh context so a
reviewer never just rubber-stamps the implementer's own diff.

## Provenance

Four of the five agents here are **vendored and tuned** from
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
| `fix-vs-finding` | does a fix reproduce its own defect? | **not vendored — Atlas-native** |

All are **advisory and read-only** — they report findings, they do not edit code. The four
vendored ones carry `tools: Read, Grep, Glob, Bash`; `fix-vs-finding` drops `Bash`, because
its job is one question about a diff it is handed rather than an investigation.

⚠️ **`fix-vs-finding` has no upstream and must not be dropped in a re-vendor.** It exists
because four times **inside #5077's review alone** a fix reproduced the defect it fixed one
layer over, with the principle written down correctly nearby and twice in the same commit.
It is dispatched per must-fix from `/review-panel` Step 5d, not as part of the parallel
fan-out, and it is deliberately given only two inputs: the finding's principle **as a
universal**, and the fix diff. Handing it more context is the failure mode, not a courtesy —
the author's own context is what hid the recurrence.

## Usage

- **In the loop:** the L2 loop fans the four vendored reviewers out in parallel against the
  implementer's diff, then hands findings back to address before `/ci` + `/pr`.
  `fix-vs-finding` runs afterwards, once per must-fix, against that fix's own diff.
- **Ad hoc:** they auto-trigger by `description` match, or invoke one explicitly, e.g.
  "use silent-failure-hunter on this diff".

## Updating from upstream

When the upstream toolkit changes, re-diff the vendored copies and re-apply the Atlas tuning.
These are pinned by copy, not by marketplace, so updates are intentional — keep the
Atlas-specific standards blocks intact when pulling upstream methodology changes.

⚠️ **Three things to re-apply every time, because upstream will keep asserting the opposite:**
the widened review scope and the prior-fix audit target (see the job-mismatch section above),
plus `fix-vs-finding` itself. The first two live in `/review-panel` Step 2 rather than in the
agent files, so a clean re-vendor of the agents does not lose them — but a re-vendor that also
"corrects" the command back to `review only this diff` restores the blind spot the widening
exists to close. The third is a **file upstream does not have**, so a re-vendor that syncs the
directory deletes it and Step 5d then silently dispatches nothing.
