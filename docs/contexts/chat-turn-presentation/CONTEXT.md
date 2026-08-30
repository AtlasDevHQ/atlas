# Chat turn presentation

> **One of Atlas's bounded contexts.** The map is [CONTEXT-MAP.md](../../../CONTEXT-MAP.md);
> system-wide decisions stay in [docs/adr/](../../adr/). Extracted from the root
> [CONTEXT.md](../../../CONTEXT.md) on 2026-08-30 ([#5302](https://github.com/AtlasDevHQ/atlas/issues/5302)):
> the prose below is that file's `## Chat turn presentation` section verbatim — only the relative links are repathed for the new depth — and it is no longer there.
> Vocabulary rules for consumers: [docs/agents/domain.md](../../agents/domain.md).


How one agent turn is presented in the chat transcript. A turn has two faces: the **activity** (everything the agent did on the way) and the **answer** (what the turn exists to deliver). Presentation is answer-first: the answer is the visually dominant element; activity is live while the agent works, then settles into a collapsed receipt. Vocabulary pinned by PRD #4292 (answer-first chat turn presentation); the receipt/promotion mechanics shipped with #4298 (finished turns, notebook convergence #4301) and #4300 (live working phase), so the present-tense descriptions below are shipped behavior — remaining #4292 slices (answer styles, editorial voice) note their own status.

- **Answer**:
  The final user-facing text of an agent turn — the thing the user asked for. Streams as the dominant element once the working phase ends.
  _Avoid_: "response" (the whole turn, activity included), "final message".

- **Activity**:
  Everything the agent did on the way to the answer — semantic-layer reads, SQL/REST executions, and narration. Rendered live during the working phase as a compact per-step feed; never interleaved at full weight with the answer.
  _Avoid_: "thinking" (model reasoning is a distinct, never-surfaced stream), "steps" (AI-SDK wire concept), "tool calls" (implementation term).

- **Working phase**:
  The interval between the user's send and the first answer token, during which the activity feed is live and ticking. Begins immediately on send (no dead air) and ends when the answer starts streaming.

- **Receipt**:
  The collapsed one-line summary the activity settles into once the answer begins (e.g. "Explored schema · 2 queries"). Expands on demand to the full activity — the work is inspectable, not ambient.
  Since #5451 the collapsed row also carries the turn's **trust tier** chips (ADR-0036) — the distinct tiers the answer was grounded in, `warehouse` from a successful `executeSQL` and each row tier from `searchBrain`. They are on the collapsed row deliberately: every tool card that carries a tier lives in the expanded body, so chips shown only there would satisfy "a surface renders the tier" while leaving a finished answer reading exactly as it did when nothing rendered it — prose, and a summary line the reader has no reason to click.
  _Avoid_: "thinking layer", "collapsed section"; treating the tier chips as a receipt detail that may be collapsed with the rest (the invariant is that they are *not*).

- **Narration**:
  The agent's inter-step commentary ("the region column looks unpopulated, checking..."). Part of the activity, never part of the answer.
  _Avoid_: conflating with the answer — both are text on the wire; presentation must separate them.

- **Answer-bearing artifact**:
  A result table or chart that the answer itself presents — promoted out of the receipt to sit with the answer. At most one per turn by default; all other query results stay in the receipt.
  _Avoid_: "the last query's result" (answer-bearing is a semantic property, not a positional one).

- **Answer style**:
  The named editorial voice of the answer — `plain-english`, `analyst` (web default), `executive`, `conversational` (chat-platform default, ex-#2705). Resolves through the registry in `packages/api/src/lib/answer-styles.ts` (#4299): each style contributes exactly one prompt addendum to the system prompt; everything else (the `<suggestions>` contract, cross-source provenance guidance) is style-independent. Surfaces auto-select their default until the per-conversation picker lands (#4302).
  _Avoid_: "presentation mode" (the superseded #2705 binary — survives only as the chat-plugin boundary field, translated at the seam, and as the deliberately retained legacy heading inside the conversational addendum); any bare "mode" phrasing (deploy / content / routing collisions).

### Anti-confusions

- The **receipt** is not a "reasoning" or "thinking" display — model reasoning tokens are never surfaced in the transcript. The receipt contains activity (real executions and narration), not chain-of-thought.
- Answer-first presentation serves the **evaluating trial admin** too: their trust need is met by activity being *inspectable* (one click), not *ambient*. There is no persona toggle.
