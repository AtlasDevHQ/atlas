# OpenAPI representation bake-off — Path A vs Path B

> v0.0.2 — REST Datasources · slice 1b ([#2931](https://github.com/AtlasDevHQ/atlas/issues/2931)) · PRD [#2868](https://github.com/AtlasDevHQ/atlas/issues/2868)
>
> **This report's recommendation is advisory.** The maintainer records the final
> default on #2931 before slice 2 ([#2926](https://github.com/AtlasDevHQ/atlas/issues/2926))
> consumes it. Both modes ship selectable; nothing is deleted.

## The question

A REST datasource has no tables for the agent to `executeSQL` against. Slice 0
(#2923) normalizes any OpenAPI 3.x document into one `OperationGraph`; the agent
then needs that surface rendered into its system prompt. There are two ways to
render it, and slice 2 has to pick a default:

| | **Path A — `operation-graph`** (#2924) | **Path B — `semantic-yaml`** (#2931) |
|---|---|---|
| What the agent sees | A flat operation digest (operation table + schema property summaries) rendered straight off the graph | An entity-relational semantic model — one entity per REST resource, with `operations` / `dimensions` / `joins` / `query_patterns`, the same shape as a SQL datasource's `semantic/entities/*.yml` |
| New module | `representation.ts` | `semantic-generator.ts` (walks the graph → entities; generalizes the #2860 `getPersonRestSchema` hotfix) |
| Hypothesis | Lean; the agent infers structure from operations + schemas | Richer; entities + first-class joins match the surface the agent already reasons over for SQL |

Both feed through the **same** datasource header (`renderDatasourceHeader`) and
drive the **same** `executeRestOperation` tool — so any measured delta is
attributable to the body, not incidental framing drift.

## Methodology

The Twenty acceptance suite (`twenty-acceptance.test.ts`) is parameterized over
`RepresentationMode`. Every assertion runs once per mode against the **real**
`runAgent` loop, with the agent's tool decisions supplied by a scripted
`MockLanguageModelV3` (the established agent-integration pattern) and an
in-process mock Twenty workspace seeded from real response shapes. The agent
loop selects the mode off the resolved datasource
(`ATLAS_OPENAPI_REPRESENTATION` today; per-install config in slice 2).

What this measures and what it does **not**:

- ✅ **Plumbing fidelity** — does each representation carry the four Twenty traps
  faithfully through `representation → tool → slice-0 client → wire`? This is a
  real pass/fail signal.
- ✅ **Prompt-token cost** — `approxTokens` (chars / 4) of the rendered
  representation. This is the load-bearing differentiator (see below).
- ⚠️ **`stepCount` is NOT a model-quality signal here.** Because the LLM is
  scripted, both modes execute the identical tool sequence, so step counts are
  identical by construction. They confirm the *shape* of the interaction (single
  lookup = 1 call; the `$ref` chain = 4 calls in one turn) but cannot show one
  representation leading the model to fewer steps. Settling that needs a live
  model on real workloads — which is exactly why **both modes stay selectable**
  (slice 2's per-install toggle) rather than the loser being deleted now.

## Results

### Correctness — pass/fail per action

Every `scripts/twenty-mcp.ts`-backing action, run through both modes:

| Action (operationId) | Trap exercised | Path A | Path B |
|---|---|---|---|
| `listPeople` (findManyPeople) | — | ✅ | ✅ |
| `getPerson` (findOnePerson) | — | ✅ | ✅ |
| `searchPeople` filter round-trip | TRAP 1 `field[op]:value` | ✅ | ✅ |
| `searchPeople` custom fields inline | TRAP 3 no `customFields` wrapper | ✅ | ✅ |
| `listCompanies` / `searchCompanies` | — | ✅ | ✅ |
| `listNotes` (findManyNotes) | — | ✅ | ✅ |
| `getPersonRestSchema` (from prompt, 0 calls) | schema grounded in representation | ✅ | ✅ |
| **"Matt's notes"** Person→NoteTarget→Note | TRAP 2 `targetPersonId` join + TRAP 4 `bodyV2.markdown` | ✅ | ✅ |
| writes blocked (upsert / createNote / deletes / wipe) | read-only gate | ✅ | ✅ |
| representation reached the system prompt | — | ✅ | ✅ |

**Both modes pass every assertion. Neither is disqualified.** The four traps
survive both renderings:

- **TRAP 1** — filter syntax `field[COMPARATOR]:value`. Path A inlines it on the
  `filter` param; Path B surfaces it once at the datasource level + per-entity
  `search` query patterns.
- **TRAP 2** — `targetPersonId` is a first-class `NoteTarget` column in both; Path
  B additionally renders the `person`/`note` `$ref`s as `many_to_one` joins.
  Neither invents a bare `personId`.
- **TRAP 3** — `atlasFirstSource` / `atlasLastSource` / `atlasStripeCustomerId`
  are inline columns on `Person`; no `customFields` wrapper appears in either.
- **TRAP 4** — note bodies flatten to `bodyV2.markdown`, and Path B preserves the
  parent object's "write markdown under bodyV2.markdown" guidance.

### Prompt tokens (the decisive metric)

Same Twenty spec (13 operations, 4 resources), `displayName: "Twenty"`:

| Mode | Prompt chars | ~Prompt tokens | vs Path A |
|---|---|---|---|
| `operation-graph` (A) | 3,894 | **~974** | baseline |
| `semantic-yaml` (B) | 7,061 | **~1,766** | **+81% (+792 tokens)** |

The representation lives in the system prompt, so this cost is paid **on every
agent step**. For the 5-step "Matt's notes" turn that is ~3,960 extra input
tokens for Path B over the turn — for identical output.

Path B is more verbose because it restates each operation inside its entity
block *and* enumerates columns/joins/query-patterns. That structure is real
signal (joins as first-class edges, SQL-parity surface), but on the Twenty spec
it did not buy any correctness or interaction-shape improvement the harness can
detect — it only cost tokens.

### `stepCount` — multi-endpoint "Matt's notes"

| Mode | REST calls | Agent steps |
|---|---|---|
| `operation-graph` | 4 | 5 |
| `semantic-yaml` | 4 | 5 |

Identical, by construction (see methodology caveat).

## Generalization check (not Twenty-overfit)

`semantic-generator.test.ts` runs the same walk against a second, hand-crafted
**Widget Store API** — a different domain, different naming (`{widgetId}` not
`{id}`), a different filter dialect (RSQL, not Twenty's bracket syntax), and a
single-`$ref` join. The generator produces correct `Widget` / `Category`
entities with **no Twenty-specific code**:

- Record-schema resolution generalizes: `Widget` resolves via its create body;
  `categories → Category` resolves via operationId / name-singularization
  (exactly as Twenty's `companies → Company`, which has neither a body nor a
  typed response).
- Nested objects flatten generically (`dimensions.widthMm`); a single `$ref`
  becomes a `many_to_one` join; the RSQL filter dialect is captured verbatim.
- Single-record classification keys on the `{param}` segment, not a literal
  `{id}`, so `getWidget` is correctly a `get`.

**No Twenty-only path was found.** The one Twenty-shaped assumption worth
flagging for future specs: irregular plurals (`people → Person`) only resolve
because Twenty exposes a create/update body or a `find*Many` operationId; a
resource that is *only* an irregularly-pluralized read with an untyped response
would fall back to a title-cased resource name. That is a rare shape and degrades
to an operations-only entity (still addressable), not a failure.

## Recommendation

**Default slice 2 to Path A (`operation-graph`); keep Path B (`semantic-yaml`)
selectable behind the per-install toggle.**

Reasoning:

1. **Equal correctness.** Path B's richer structure earned no measurable
   correctness or interaction-shape win on Twenty; it must justify itself on
   token cost alone, and there it loses (+81%).
2. **Tokens are paid every step.** The representation is fixed system-prompt
   overhead re-sent on each agent step. The leaner mode is the safer default,
   especially as specs grow (a full Twenty `/rest/open-api/core` is ~250 KB of
   JSON — an external, approximate figure per Twenty's published spec at time of
   writing, not measured from the test fixture; Path B's per-entity restatement
   scales worse than Path A's flat digest).
3. **The open question needs live data, and we kept the means to answer it.** A
   richer entity/join surface *may* help a real model on harder multi-hop
   questions — something the scripted harness cannot show. Path B stays a
   one-flag switch (`ATLAS_OPENAPI_REPRESENTATION=semantic-yaml`), so slice 2 can
   A/B it on real workloads without re-deriving anything. The generated model is
   also the natural cache artifact (`workspace_plugins.config.openapi_snapshot`,
   OQ4) regardless of which mode renders the prompt.

> **Maintainer decision (record on #2931):** _<pending — slice 2 (#2926) closeout MUST replace this line with the chosen default. Until then the code default (`DEFAULT_REPRESENTATION_MODE = "operation-graph"` in `datasource.ts`) already reflects this report's Path-A recommendation.>_

## Reproducing

```bash
cd packages/api
# Bake-off run (both modes) — metrics table prints at teardown:
bun test src/lib/openapi/__tests__/twenty-acceptance.test.ts
# Generator golden + generalization tests:
bun test src/lib/openapi/__tests__/semantic-generator.test.ts
# Regenerate golden YAML after an intentional generator change (never automatic):
bun run openapi:regen-goldens
```
