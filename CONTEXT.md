# Atlas Domain Context

Canonical terminology for Atlas. This document is a glossary, not a spec — implementation details belong in code, ADRs, or `architecture-wins.md`.

When you find yourself reaching for one of these words, use the canonical form. When you see a term used loosely in conversation or code, sharpen it back to one of these.

> **This file is the UN-SPLIT REMAINDER, not the whole domain.** Atlas uses the
> multi-context layout ([CONTEXT-MAP.md](CONTEXT-MAP.md)); thirteen of its eighteen contexts
> have been extracted and are **not** in this file (#5302):
>
> | Context | Now lives in |
> | --- | --- |
> | Company Atlas | [docs/contexts/company-atlas/CONTEXT.md](docs/contexts/company-atlas/CONTEXT.md) |
> | Deployment posture | [docs/contexts/deployment-posture/CONTEXT.md](docs/contexts/deployment-posture/CONTEXT.md) — ⚠️ marked stale 2026-08-17 |
> | Notebooks (retired) | [docs/contexts/notebooks/CONTEXT.md](docs/contexts/notebooks/CONTEXT.md) — history only |
> | Pillars | [docs/contexts/pillars/CONTEXT.md](docs/contexts/pillars/CONTEXT.md) |
> | Chat Platform mechanics | [docs/contexts/chat-platform-mechanics/CONTEXT.md](docs/contexts/chat-platform-mechanics/CONTEXT.md) |
> | Knowledge Base mechanics | [docs/contexts/knowledge-base-mechanics/CONTEXT.md](docs/contexts/knowledge-base-mechanics/CONTEXT.md) |
> | Plugin lifecycle | [docs/contexts/plugin-lifecycle/CONTEXT.md](docs/contexts/plugin-lifecycle/CONTEXT.md) |
> | Install models | [docs/contexts/install-models/CONTEXT.md](docs/contexts/install-models/CONTEXT.md) |
> | Operator vs Customer | [docs/contexts/operator-vs-customer/CONTEXT.md](docs/contexts/operator-vs-customer/CONTEXT.md) |
> | Conversation scope | [docs/contexts/conversation-scope/CONTEXT.md](docs/contexts/conversation-scope/CONTEXT.md) |
> | Semantic layer scoping | [docs/contexts/semantic-layer-scoping/CONTEXT.md](docs/contexts/semantic-layer-scoping/CONTEXT.md) |
> | Semantic improvement | [docs/contexts/semantic-improvement/CONTEXT.md](docs/contexts/semantic-improvement/CONTEXT.md) |
> | Learned query patterns | [docs/contexts/learned-query-patterns/CONTEXT.md](docs/contexts/learned-query-patterns/CONTEXT.md) |
>
> They were moved, not copied: no section below duplicates them. The remaining five
> sections are still governed here, and the map says so per row.

## Chat turn presentation

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

## Dashboard editing

How a dashboard is edited and made visible to a team. **Target-state vocabulary** — pinned during the dashboard elevation grill (2026-07-04, audit `.claude/research/dashboard-audit-2026-07-04.md`); the draft-first model below is the design contract, not yet shipped behavior (today direct manipulation commits live and only the agent path drafts).

- **Dashboard**:
  A persistent, shareable grid of **cards** with an optional top-level **parameter bar**. The unit that is created, shared, and published.
  _Avoid_: "board" (informal only), "report" (a distinct point-in-time deliverable with no current home — see docs/contexts/notebooks/CONTEXT.md).

- **Card**:
  The unit on the grid. A **chart card** carries a SQL query + visualization; a **text card** carries markdown (section headers, explainers) and no data.
  _Avoid_: "tile" for the persisted unit — a *tile* is the rendered presentation of a card on the **canvas**; "widget".

- **Canvas**:
  The dashboard grid surface a user looks at. Renders the caller's **draft** when they have one, the **published** state otherwise — so a user always sees the version they are editing, never a stale published copy while they work.
  _Avoid_: "grid" for the concept (the grid is the layout mechanism); "the dashboard view".

- **Draft**:
  The caller's private, per-user working copy of a dashboard. **Every** edit — direct manipulation (drag, rename, delete) and agent/chat edits alike — lands in the draft; it is invisible to teammates until **published**. One draft per (user, dashboard).
  _Avoid_: conflating with the content-mode `draft` status enum (a dashboard row is not content-mode gated); "staged change" (the retired **stage tracker**'s pending-destructive-op concept — decided 2026-07-10: destructive bound-editor ops land directly in the draft like every other edit, with inline undo; there is no second pending-changes store, and publish can no longer strand an unaccepted change).

- **Draft cache**:
  A draft card's own cached data, private to the **draft** it lives in — pinned during the second dashboard elevation grill (2026-07-10). Executing a card while holding a draft (refresh, parameter change, retry, first load of a never-published card) reads and writes the draft cache, never the **published** card's cached data and never the **Query Cache**. Every tile affordance — refresh, staleness, age, retry — works identically whether the card's data comes from the draft cache or the published cached data; a draft-only card is fully operable before **first publish**.
  _Avoid_: "the cache" unqualified on the dashboard surface (three distinct stores: draft cache, published cached data, Query Cache); treating a draft-only card as un-runnable until publish (the 404-until-published behavior is the defect this term retires).

- **Published**:
  The shared, org-visible state of a dashboard — the card set + metadata that teammates and shared links see. The merge target of **publish**.
  _Avoid_: treating "published" as a full content-mode status enum (there is no draft/published/**archived** tier on the dashboard row); conflating the one-time **first publish** visibility transition with the ongoing edit-gating.

- **First publish**:
  The one-time transition that makes a never-published dashboard visible to the rest of the org. Before it, a dashboard is **private to its creator** (a single "has ever been published" gate, not a content-mode status); after it, the dashboard stays org-visible permanently and subsequent **publish**es gate only the *edits*.
  _Avoid_: modeling this as a reversible status (it is a one-way gate — there is no "unpublish"/archive in this design).

- **Publish**:
  The single gated transition that three-way-merges the caller's **draft** into the **published** dashboard (409 on a stale baseline or a same-card conflict). The only path from private edit to teammate-visible.
  _Avoid_: "save" (editing continuously auto-persists to the draft; publish is the *promotion*, not the save).

- **Bound editor**:
  The dashboard-scoped chat drawer through which the agent builds and edits a dashboard. Its edits land in the caller's **draft**; the **canvas** — cards materializing and updating live — is the turn's **answer-bearing artifact**, so the drawer shows conversation + a collapsed **receipt** (per *Chat turn presentation*), not inline card previews. It is also the dashboards surface's own **creation instrument** (pinned 2026-07-10): creating a dashboard from the surface opens the bound editor on the empty canvas — the surface is a first-class creation origin, not a viewer that bounces new users back to main chat.
  _Avoid_: "bound chat" for the surface (say bound editor); rendering the build as full-weight inline tool cards (that is the divergent pre-convergence renderer being retired).

- **View / Edit (canvas modes)**:
  The two interaction modes of the **canvas**, pinned 2026-07-10: **View** is strictly read-only for the dashboard's *definition* — it offers only non-mutating affordances (refresh, fullscreen, CSV export, parameter/filter changes) and can never fork or touch a **draft**; **Edit** is where every definition mutation (remove, rename, duplicate, drag, SQL/config change) lives, all landing in the caller's draft. A browsing gesture must never create a draft.
  _Avoid_: exposing mutating tile controls in View (the pre-2026-07-10 defect); "read-only" to mean no-refresh (refreshing data is a View affordance — read-only gates the *definition*, not the data's freshness).

- **Tile**:
  The rendered presentation of a single **card** on the **canvas**, and the **unit of trust**: a tile carries its own status — loading, fresh, **stale**, errored, empty, not-filtered — surfaced *on the tile*, rather than deferring failures to a page-level banner.
  _Avoid_: using "tile" for the persisted unit (that is a **card**); collapsing *errored* (the query failed), *empty* (the query returned zero rows), and *never-run* (no cached data yet) into one "No cached data" state — they are three distinct tile states.

- **Stale (tile)**:
  A tile whose displayed data predates the current **card** definition (its SQL/config) or the active parameter/filter values — a first-class, *visible-but-quiet* state (a color-shifting age caption — muted → amber → red — plus a subtle body dim and a one-click retry, never a banner). A tile that fails to update stays labeled with its data's age and offers retry; it never silently substitutes old data for a failed new render.
  _Avoid_: "cached" as a synonym (all tile data is cached — staleness is *cache older than the current definition/params*, not the mere fact of caching).

- **Shared view**:
  The read-only, **data-only snapshot presentation** of a **published** dashboard reached through a share token. Exposes title/description + per-card title/kind/chart-config/annotations/cached data/layout — and *nothing else*. Never the raw SQL, connection/owner/org identifiers, refresh cron, or parameter definitions. Uniform across **public** (no-auth) and **org** (authenticated-teammate) share modes.
  Reached as a standalone page or as an **embed** (an iframe-framable presentation of the same shared view — decided 2026-07-10, mirroring the conversation embed): same token, same snapshot, same revocation/expiry; the embed is a frame around the shared view, never a second sharing surface.
  _Avoid_: treating the shared view as a live or inspectable dashboard (query inspection happens in-app, where auth gates it); "public dashboard" (the *dashboard* isn't public — a *token* grants snapshot access); modeling the embed as a new access mode (the token is the access control, framed or not).

### Anti-confusions

- The **draft** is a per-user *working copy*, not a content-mode visibility tier. Two editors have two independent drafts of the same published dashboard; publish merges, never overwrites (except last-writer-wins on title/description).
- **Publish** is not **refresh**. Publish promotes *definitions* (SQL, layout, config); refresh re-executes a card's SQL to update its *cached data*. A publish that changes SQL must trigger a refresh or the **shared view** shows new definitions over stale data.
- The **shared view** is data-only by construction, not by redaction-after-the-fact — the public projection is built from a minimal DTO, so a field can't leak by being forgotten. Raw SQL never reaches the wire on this surface.
- The **shared view** has a single **as-of** instant (decided 2026-07-10): every piece of temporal framing a share viewer sees — parameter chips, "data as of" captions — derives from the shown data's capture instant, never from view time or dashboard creation time. When a refresh updates the rows, all framing moves with them; the page can never contradict itself about what window the numbers cover.

## MCP & agent governance

The MCP server runs the same agent tools as the chat app, so the same governance (RBAC, approval rules, audit) must apply. These terms pin *who* is acting and *through what channel*.

- **MCP actor** — the identity an MCP request is attributed to and authorized as. Three kinds: *governed* (bound to a real user + org via `ATLAS_MCP_USER_ID` / `ATLAS_MCP_ORG_ID`), *trusted* (synthetic `system:mcp`, carrying no real identity), and *hosted* (resolved per OAuth bearer).
  _Avoid_: "MCP user" (the trusted actor is not a user).

- **Anonymous onboarding caller** — the identity-less entry point for self-serve signup over MCP. It is **not** an MCP actor (it carries no identity, governed/trusted/hosted) and is structurally incapable of reaching the dispatch gate pipeline. It can invoke exactly one tool (`start_trial`) on a separate, pre-auth registration path; that call *produces* a real user + Workspace, after which a normal *hosted* actor takes over via the OAuth/DCR connect. The single, audited pre-actor carve-out — never a fourth actor kind, never a `system:mcp` (*trusted*) fallback.
  _Avoid_: modeling it as a degenerate *trusted* actor (`system:mcp` is the operator's own process, a different boundary); "anonymous actor" (it is precisely *not* an actor).

- **Claim (an unclaimed Workspace)** — a Workspace provisioned over MCP by the *anonymous onboarding caller* exists **unclaimed** until a human comes to the web and completes the OTP interstitial (verify email via emailOTP — Atlas never uses magic links — set a credential/passkey, accept ToS). Claiming flips the trial from **metered** (token spend withheld so the agent won't answer data questions on Atlas's tokens; setup — datasource connect, semantic layer — is fully allowed) to **full** (normal `trial` token budget). The meter is a clamp on the token budget keyed on `emailVerified`, not a plan tier. Distinct from **solvency** (Gate 0): an *expired* trial is blocked on every surface including MCP by Gate 0, regardless of claim state or token budget. Both axes have one code home — `packages/api/src/lib/billing/trial-state.ts` (#4127: composite `deriveTrialState`; Gate 0 and the reaper's SQL consume its primitives/fragments) — and the Gate-0-before-claim ordering on the headless Atlas-token path is encoded in `checkAgentQueryGates` (`billing/agent-query-gates.ts`, #4128).
  _Avoid_: conflating *metered/full* (pre/post-claim token clamp) with *trial-expired/solvent* (Gate 0); calling an unclaimed Workspace a "draft" (that term is the content-mode status enum).

- **Agent origin** — the invocation channel a query or mutation reached the agent through: `chat` / `mcp` / `scheduler` / `slack`. Approval rules match on it and the audit log records it. See [ADR-0015](./docs/adr/0015-agent-origin-not-surface.md).
  _Avoid_: "approval surface" and bare "surface" (reserved for the pillar admin page); "source" (a deprecated alias for Connection group); conflating with **Lead source** below — agent origin is about *agent traffic* (approval/audit), lead source is about *CRM acquisition* (marketing attribution). Both can say "mcp"; they are different concepts.

## Query Cache

- **Query Cache** — the per-region, in-process store of `executeSQL` result rows (`lib/cache/`), keyed by (SQL, Datasource connection, Workspace, user claims, **resolved RLS config**) so entries are tenant-isolated by construction. One per API process, shared by every Workspace in the region. Distinct from the chat-SDK state store (`chat_cache:*` keys — Workspace Connection credentials, not query results) and from a dashboard card's **cached data** (persisted per-card snapshots, refreshed by publish/cron — see "Dashboard editing").
  _Avoid_: bare "cache" in cross-subsystem prose (say Query Cache); "chat cache" for this concept (`chat_cache` is credential storage).

- **CacheBackend contract** — the async interface (`get`/`set`/`delete`/`flush`/`flushByOrg`/`stats`, all `Promise`-returning) a Query Cache backend satisfies (`lib/cache/types.ts`). The default in-process LRU implements it; a plugin can supply an external one (Redis, Memcached), validated on registration (`validateCacheBackend`) — a shape-invalid backend **fails that plugin's init** (red + sticky in plugin health) while the cache degrades to the LRU so queries keep working. Async-by-contract is what kills the phantom-hit failure mode: an unawaited Promise is truthy, so a sync-shaped `get()` would read as a hit for every query.
  _Avoid_: a synchronous backend method (the contract is Promise-returning end to end); silently falling back to the LRU on a bad backend without failing the plugin.

- **Scope tags / scoped invalidation** — every `set()` carries a `CacheScope` (`{ orgId?, connectionId }`); the LRU keeps an `orgId → keys` side index (consistent across set / delete / capacity-eviction / TTL-expiry / flush) so `flushByOrg(orgId)` purges exactly one Workspace's entries. Org deletion and residency migration purge **per-org**, never fleet-wide — a co-tenant's warm entries survive one Workspace's teardown. The connection tag is retained so a future per-connection invalidation can filter an org's entries by it (no reader does yet). Fleet-wide `flush()` stays for config reload + the admin flush button.
  _Avoid_: nuclear `flush()` for a single-Workspace event (use `flushByOrg`); an `orgId` in the scope tag that differs from the `orgId` in the cache key (they must be the same Workspace or `flushByOrg` misses).

- **Org-bucketed cache stats** — the per-Workspace hit/miss accounting the admin cache page reports (#4549): each Workspace's bucket carries a since-labeled **lifetime rate** plus a sliding **last-hour rate** (two-generation window — current + previous hour's counters, the previous decaying linearly as the hour progresses; no ring buffer). Lives in a module-level registry (`lib/cache/stats-registry.ts`) ABOVE the backend, recorded at the single agent read site in `lib/tools/sql.ts` — `CacheBackend.get(key)` structurally cannot attribute a **miss** to a Workspace (the key isn't in the backend), so the backend's own `stats()` counters remain its global self-report and the registry is the additional app-maintained per-org layer. Counters therefore survive backend resize/plugin swap. Responses are per-caller: workspace admins see only their bucket; fleet totals are platform-admin-only. There is no admin-facing reset verb (the only reset export, `resetCacheStatsRegistry`, is test-isolation-only) — a flush "moves the window" emergently (post-flush misses drag the last-hour rate down).
  _Avoid_: recording hits/misses inside a backend (miss attribution is impossible there); treating the backend's `stats()` hits/misses and the registry as the same numbers (they are two deliberate layers); a bypassed read as a miss (it consulted no cache).

- **Query Cache governance principle** — ADR-0033: *the cache key captures every input that determined an entry's rows; anything that can veto a query runs before the cache check; and the hit path re-applies every layer that transforms rows on the way out.* Concretely: the **resolved RLS config** hashes into the key alongside claims (`lib/cache/keys.ts`) so tightening RLS orphans pre-change entries by construction — no flush choreography (closes audit H3); plugin **`beforeQuery`** dispatch sits *above* the cache check (`lib/tools/sql.ts`) so a rejection blocks warm hits and a rewrite lands in the key (closes M11's governance half; the metrics half is the documented live-only carve-out below); and masking + the current row limit re-apply on every hit. The **live-path-only** carve-out: `afterQuery` + connection SLA/`recordQuery` metrics observe *executions*, so a hit — which doesn't execute — never fires them. The **L9 invariant**: when both Workspace (org) and claims are absent, an entry rests solely on the Datasource connection; that is correct only for single-tenant-per-connection deployments, so any per-tenant discriminator MUST surface through org or claims, never left implicit.
  _Avoid_: "flush the cache on RLS change" (the rejected event-based alternative — key-hashing is invariant-based); treating a cache hit as an execution (it has no datasource round-trip to observe).

## Lead source (CRM acquisition)

- **Lead source** — *how a prospect/lead first reached Atlas*, as recorded in the CRM. Carried on the `LeadEvent` discriminated union's `source` field (`demo` / `signup` / `conversion` / …) — defined once in `plugins/twenty/src/lead-normalizer.ts` (`LeadEventSchema`, the SSOT for the `crm_outbox` payload wire shape; the `SaasCrm.upsertLead` contract aliases it as `SaasCrmLeadInput`) and mapped by the Twenty normalizer onto two Person fields: **`atlasFirstSource`** (sticky first-touch — never overwritten once set) and **`atlasLastSource`** (last-touch — updated each event). A self-serve trial signup emits a `signup` lead through `SaasCrm.upsertLead`; a Stripe-paid conversion stamps `conversion`. A signup arriving over MCP is the **same lead-source concept reached by a different method** — it flows through the identical `upsertLead` → `crm_outbox` → Twenty pipeline, distinguished (if at all) by its `source` value, never by a new pipeline.
  _Avoid_: treating it as **Agent origin** (that governs agent traffic); inventing a parallel "acquisition channel" concept (this is it); putting CRM provenance on the trial grant (the grant carries runtime entitlement state like the trial meter, not marketing attribution).

- **MCP admin tool** — an MCP tool that *configures* Atlas (creates a Datasource, connects an integration, raises a policy) rather than reading data — as opposed to the read-only query tools (`executeSQL`, `explore`, the semantic-layer tools).
  _Avoid_: "configuration surface" (bare "surface" is the pillar admin page).

- **MCP action policy** — the per-workspace, customer-admin allow/deny over MCP action *categories* (e.g. "no datasource creation via MCP at all"). Evaluated first in the dispatch gate order and short-circuits before scope / RBAC / approval. Distinct from the **origin ceiling** — the non-configurable product invariant that MCP may never *lower* governance (disable RLS, the table whitelist, an approval rule, etc.). See [ADR-0016](./docs/adr/0016-mcp-v2-security-model.md).
  _Avoid_: conflating it with the origin ceiling — the action policy is customer-configurable; the ceiling is not.

- **Query shape** — *who authors the SQL* that answers a data question, across every surface (chat, MCP, CLI, REST). Two shapes:
  - **NL-agent query** — the caller sends a natural-language *question* and **Atlas's own agent** writes and runs the SQL (chat, CLI `atlas query`, the synchronous query API). Token-metered. The recommended **happy path**.
  - **Raw query** — the caller sends a *query they authored themselves* (a `SELECT` via the `executeSQL` tool / CLI `atlas sql`, driven by the caller's own LLM or a human/CI script). Atlas validates and executes but authors nothing. Runs no Atlas LLM → solvency-gated, not token-metered. The **advanced** surface.
  The distinction is load-bearing for *trust*: a raw query's author is **external and untrusted**, so the 4-layer validation pipeline + read-only connection is the **sole** boundary (a member reaches exactly the agent-loop's whitelist/RLS reach — no escalation). See [ADR-0027](./docs/adr/0027-executesql-over-rest-security.md).
  _Avoid_: calling raw query "the chat route" (chat is NL-agent); implying a **sandbox** contains SQL — SQL runs in the customer's database and is never sandboxed; only `explore`/`python` (untrusted code on Atlas's host) are.
