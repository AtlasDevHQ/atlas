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

These five labels do not exist in `AtlasDevHQ/atlas` yet — the `/triage` skill will create them lazily on first use via `gh label create -R AtlasDevHQ/atlas`. They do not collide with the existing label vocabulary.

## These labels are STATE — they don't replace kind/area

Atlas issues carry labels on **two orthogonal axes**:

| Axis | Labels | Set by |
| --- | --- | --- |
| **State** (where in the triage funnel) | `needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix` | `/triage` (Matt Pocock) |
| **Kind + location** (what kind of work, what part of the codebase) | `bug` / `feature` / `refactor` / `chore` / `docs` + `area: *` + optional `architecture` / `security` / `design` | `/next`, `/investigate`, `/kickoff`, `/tidy`, `/to-issues` (Atlas + Matt Pocock) |

**Both axes apply to every issue.** A community-filed issue starts as `bug, area: api, needs-triage`. After triage, it becomes `bug, area: api, ready-for-agent`. The triage-state label changes; the kind/area labels stay.

See `docs/agents/issue-tracker.md` for the full kind/area vocabulary and how to apply both axes together.

## When triage isn't relevant

Today, almost every Atlas issue is self-filed by the maintainer with a clear next step — those issues don't need to pass through the triage funnel. Skip the triage-state label for internal issues, and rely on the milestone + kind/area labels alone.

When Atlas opens to community contributions, every externally-filed issue should land with `needs-triage` and move through the state machine via `/triage`. At that point `/tidy` + `/triage` become the two pillars of issue hygiene (see `docs/agents/workflow.md`).

Edit the right-hand column of the table to match whatever vocabulary you actually use.
