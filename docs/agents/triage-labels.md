# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

All five labels exist in `AtlasDevHQ/atlas` and are in use. They do not collide with the existing label vocabulary.

⚠️ **`ready-for-agent` is an execution trigger, not a description.** `/ship-batch` and `/ship-milestone` both select work with `gh issue list --label ready-for-agent` — so the label does not mean "this is well specified", it means "an agent may start this unattended". A fully specified issue that nobody should start yet must NOT carry it. See *Blocked on an external event* below.

## These labels are STATE — they don't replace kind/area

Atlas issues carry labels on **two orthogonal axes**:

| Axis | Labels | Set by |
| --- | --- | --- |
| **State** (where in the triage funnel) | `needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix` | `/triage` (Matt Pocock) |
| **Kind + location** (what kind of work, what part of the codebase) | `bug` / `feature` / `refactor` / `chore` / `docs` + `area: *` + optional `architecture` / `security` / `design` | `/next`, `/investigate`, `/kickoff`, `/tidy`, `/to-tickets` (Atlas + Matt Pocock) |

**Both axes apply to every issue.** A community-filed issue starts as `bug, area: api, needs-triage`. After triage, it becomes `bug, area: api, ready-for-agent`. The triage-state label changes; the kind/area labels stay.

See `docs/agents/issue-tracker.md` for the full kind/area vocabulary and how to apply both axes together.

## The two WAITING states are cleared when an issue closes

`needs-triage` and `needs-info` assert a **live obligation** — "a maintainer still has to evaluate this", "we are still waiting on someone". On a closed issue both are false by construction, so they are removed at close. `/tidy` sweeps any that survive (§2b).

The other three are **not** swept, and the asymmetry is the point:

| Label | On a closed issue | Why |
| --- | --- | --- |
| `needs-triage` / `needs-info` | **removed** | Claims an obligation that closing discharged |
| `ready-for-agent` / `ready-for-human` | kept | Records who the work was routed to — history, not a claim about the present |
| `wontfix` | kept | It *is* the verdict, and the verdict is why the issue is closed |

⚠️ **A stale `needs-triage` reads as a real open question in every label view**, and it accumulates silently because closing an issue is the one moment nobody is looking at its labels. 75 closed issues had carried one — the oldest since 2026-06-14 — and both `needs-info` survivors were `state_reason: completed`, i.e. resolved issues advertising that we were still waiting on the reporter. Swept 2026-08-17.

## When triage isn't relevant

Today, almost every Atlas issue is self-filed by the maintainer with a clear next step — those issues don't need to pass through the triage funnel. Skip the triage-state label for internal issues, and rely on the milestone + kind/area labels alone.

When Atlas opens to community contributions, every externally-filed issue should land with `needs-triage` and move through the state machine via `/triage`. At that point `/tidy` + `/triage` become the two pillars of issue hygiene (see `docs/agents/workflow.md`).

## Blocked on an external event

The five roles describe **specification readiness**, and Atlas has a class they don't cover: issues that are completely specified and deliberately must not be started, because they wait on something outside the repo. There is no sixth label — the convention is a state plus a title marker, split by what is being waited on:

| Waiting on | State | Title | Examples |
| --- | --- | --- | --- |
| **A third party** to ship something | `needs-info` | `[blocked]` after the conventional-commit type | #4404 (a HubSpot KB read API), #3368 (a Railway no-egress sandbox mode), #5281 (the TypeScript 7.1 programmatic API) |
| **Our own scale**, i.e. a metric a human must read | `ready-for-human` | unchanged | #2109 (>150 MCP sessions/region for two weeks), #2055 (measure before adopting Redis) |

`needs-info` is a reuse rather than a perfect fit — its canonical meaning is "waiting on the reporter", and here the party who has to act is a vendor. It is the right home anyway: it is the machine's only waiting state, it keeps the issue out of the `ready-for-agent` selector, and the `[blocked]` prefix makes the distinction legible in a title list.

**Give every blocked issue an unblock test** — the specific observation that would move it back to `needs-triage`, written so someone can perform it without re-deriving the analysis ("re-read Railway's sandbox network-mode docs and look for a third mode alongside isolated and private"). A blocked issue with no unblock test is indistinguishable from an abandoned one.

Edit the right-hand column of the table to match whatever vocabulary you actually use.
