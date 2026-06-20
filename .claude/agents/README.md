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
agents: the repo's own `/code-review` and `/simplify` skills already know Atlas's conventions
and remain the canonical generic passes. These four add the specialist axes a single generic
pass spreads thin.

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

- **In the loop:** the L2 dispatcher fans all four out in parallel against the implementer's
  diff, then hands findings back to address before `/ci` + `/pr`.
- **Ad hoc:** they auto-trigger by `description` match, or invoke one explicitly, e.g.
  "use silent-failure-hunter on this diff".

## Updating from upstream

When the upstream toolkit changes, re-diff the vendored copies and re-apply the Atlas tuning.
These are pinned by copy, not by marketplace, so updates are intentional — keep the
Atlas-specific standards blocks intact when pulling upstream methodology changes.
