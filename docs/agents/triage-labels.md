# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the
actual label strings used in this repo's tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

Verified 2026-08-17 against `gh label list -R AtlasDevHQ/atlas`: all five exist with exactly
these strings, so `/triage` applies existing labels rather than creating duplicates. No
overrides needed.

## This is one of two axes, not the whole labelling scheme

Every Atlas issue carries **both**:

1. **State** — one of the five above.
2. **Kind + location** — exactly one of `bug` / `feature` / `refactor` / `chore` / `docs`,
   plus one or more `area: *`, plus optional `architecture` / `security` / `design` / `blocked`.

They don't replace each other, and a skill that applies only a state label has half-labelled
the issue.

## Lifecycle notes

- The state labels are created lazily — most issues here are self-filed by the maintainer
  with a clear next step, so `/triage` is rarely needed today. It becomes central if this
  repo opens to outside contributions.
- `needs-triage` and `needs-info` assert a **live obligation**, so remove both when closing
  an issue. `ready-for-agent` / `ready-for-human` / `wontfix` are **kept** on closed issues —
  they record routing and verdict, not an outstanding obligation.
