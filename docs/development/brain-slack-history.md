# The Slack chat-history brain source (#4770)

The first ingest source for the company brain (ADR-0036 §Ingestion &
connectors). It reads history from chosen Slack channels into `brain_episodes`
as immutable tier-3 evidence. Nothing it writes is a fact and nothing it writes
is published — the claims drawn from these episodes are #4771's, and they go
through the #4769 review gate before anything becomes authoritative.

## What is reused, and what is forked

ADR-0036 §T6 is a two-part instruction and both halves are load-bearing.

**Reused verbatim** — the ADR-0030 connector engine:

| Concern | Where it lives | Notes |
|---|---|---|
| Scheduling | `scheduler/knowledge-bundle-sync.ts` | The one fiber. There is no second scheduler. |
| Cycle walk + dispatch | `lib/knowledge/sync.ts` | Lists installs of every registered catalog id; routes each to its engine. |
| Incremental vs reconcile cadence | `connector-sync.ts::getKnowledgeSyncReconcileIntervalMs` | `ATLAS_KNOWLEDGE_SYNC_RECONCILE_INTERVAL_HOURS`, default weekly. ADR-0036 repurposes the cadence to re-run **extraction** (#4771); this source fetches identically in both modes — see below. |
| Overlap window | `connector-sync.ts::SYNC_OVERLAP_WINDOW_MS` | Reused by the Slack client as its safety lag. |
| 429 backoff | `connector-sync.ts::withRateLimitBackoff` | Client throws `ConnectorRateLimitError`; the engine waits and retries. |
| Per-sync caps | `billing/knowledge-limits::resolveIngestCaps` | Episodes count against the same `maxDocs` as documents. |
| Bookkeeping | `knowledge_sync_state` via `read/upsertConnectorSyncState` | Same table, same COALESCE-forward semantics. |

**Forked** — the ingest core only (`lib/brain/ingest/`):

| Knowledge documents | Brain episodes |
|---|---|
| identified by PATH | identified by SOURCE-ID |
| mutable — upsert-by-path | immutable — `ON CONFLICT DO NOTHING` |
| absent path on a full crawl → **archived** | absent record → simply absent; **nothing is ever archived** |
| content-mode registered (`draft`/`published`) | deliberately NOT registered — evidence is not review-gated |

The dispatch that chooses between them is `dispatchInstall` in
`lib/knowledge/sync.ts`, keyed on which registry owns the catalog id. Because
the brain arm never calls `ingestDocuments`, the subtractive-archive path is
structurally unreachable from it rather than merely switched off — pinned by
`__tests__/episode-sync-archive.test.ts`.

## The source-id contract

```
source_id = `<channelId>:<ts>`
```

Freshness for chat is "poll + reconcile, plus a webhook fast-path" (M3), and
the fast-path is **an alternate writer into the same idempotent episode
store**. Two writers that disagree about the id duplicate every message they
race on, and an append-only store has no upsert that would converge them later.
So the id is a contract, not an implementation detail:

- Slack's `ts` is the message's identity within a channel.
- It is channel-scoped, because Slack's `ts` is not globally unique.
- Thread replies carry their own `ts`, so a reply is its own episode.
- It survives an edit: `conversations.history` returns the message's original
  `ts` with the edit recorded in an `edited` sub-object, so an edited message
  re-ingests as a no-op.

⚠️ **The two writers read `ts` from different field paths.** "Just use `ts`" is
the trap this section exists for:

| writer | field |
|---|---|
| poll (`conversations.history`) | `message.ts` |
| webhook, plain `message` event | `event.ts` |
| webhook, `subtype: "message_changed"` | **`event.message.ts`** |

On a `message_changed` event, top-level `event.ts` is the *event's* timestamp
and `event.message.edited.ts` is the *edit's* — using either mints a new id for
a message already stored and duplicates every edited message. `message_changed`
never appears on the poll path; `conversations.history` serves a message's
current state, not its edit events.

**The format must never change.** It is a stored key: a reformat re-ingests
every message in every workspace as a new episode, and #4771 would re-extract
facts from all of them.

## Grants

Derived at ingest (ADR-0036 §T5), by `lib/brain/ingest/grant.ts`:

- **public channel → `[org]`** — everyone in the workspace can already read it
  at the source. The grant is explicit, never implicit, so a forgotten grant
  can't read as public.
- **private channel → `[audience:chat-channel:slack:<channelId>]`** —
  membership lives in `fact_audience_member` and is the live revocation path.

Membership is populated by #4801's audience sync (see *Audience membership*
below). The grant names the audience rather than the people, which is what makes
revocation live: dropping a membership row hides the facts on the next read,
with no re-ingest and no rewrite of a stored row.

The deriver emits only tokens `parseGrant` finds usable, and `episodes.ts`
re-checks with `isUsableGrant` before the INSERT. This matters more than it
looks: `chk_brain_episodes_grant_nonempty` admits `['everyone']`, which grants
nobody anything and — once episodes become facts — would be refused at every
publish forever by #4769's `GRANT_UNUSABLE` classifier, with no repair UI until
#4772. That refusal is meant to be defence in depth, not a live trap.

## Publish scope (#4825)

**Publish is workspace-scoped. The review queue is reader-scoped. Both are
deliberate, and the pairing is the decision.**

`promoteBrainFacts(tx, orgId)` takes no reader and `DRAFT_FACTS_SQL` carries no
ACL clause, so publishing promotes every live draft in the workspace — including
ones the admin who pressed the button was never shown. `/admin/brain-facts`
composes `aclVisibilityClause` and shows only what that reader may see. So
`queue < what publish promotes` is the **correct** state, not a bug.

The 2026-07-26 staging soak read **26 / 32** — 26 reviewable drafts against 32
in the workspace, the delta being six facts from a private channel the admin was
not a resolved member of. Each number was right; together they were
inexplicable from the UI, which is what this section exists to fix.
`oversight-pg.test.ts` reproduces that split against a live database.

### Why not reader-scoped publish

It was considered and rejected. There is no free lunch here:

| | outcome |
|---|---|
| **unscoped publish** (today) | nothing strands; facts reach `published` without the admin having read them |
| **reader-scoped publish** | everything published was genuinely reviewed; a private channel's facts strand **permanently** whenever no member of it is an Atlas reviewer |

The second is worse. `role:platform_admin` is refused by the grant grammar
(`acl.ts`) and a platform role resolves to `role: null`, so there is no
escalation path that could ever clear the backlog — the drafts badge stays lit
forever. That is the unclearable-banner shape #4771 closed for grants,
reappearing through identity resolution.

### So the fix is disclosure, not scoping

- **Before the click.** `/api/v1/admin/publish-preview` returns brain-fact
  labels **ACL-scoped to the reader** — the label *is* the claim, and an
  unscoped one handed an admin exactly what the review queue had just withheld
  — plus `brainFactsWithheld`, the count of drafts publish will promote and this
  admin may not read. The publish modal folds that count into its button total
  and states the reason above it. The unscoped half comes from
  `brainFactsCountSql`, the same statement behind `/api/v1/mode`
  `draftCounts.brainFacts`, so `shown + withheld` equals the pending badge by
  construction.
- **Standing view.** `GET /api/v1/admin/brain-facts/oversight`
  (`lib/brain/oversight.ts`) reports per-audience counts by state — awaiting
  review, published, retracted, provisional, in tension — for the whole
  workspace, unscoped, **with no claim, evidence, provenance, or fact id**. It
  carries the reader's own reviewable total in the same *response*, so the
  hidden backlog cannot flicker between two client fetches. The statements are
  not transactionally consistent (a pool, no enclosing transaction), so a brief
  ingest race can invert them; `countsConsistent: false` says so rather than
  clamping the delta to a reassuring zero, and `distinctAudiences` carries the
  true cardinality even when the bucket list is capped.

  Note this is **not** ADR-0036's audit override. That is a reason-gated,
  owner/admin-only, logged bypass over *content*, and this path deliberately
  does not use it — no reason, no audit row, no `AclAuditOverride`. It is a
  narrower thing: an unscoped **count**.

An admin learns that facts exist they cannot see — a number, never content.

### The audience-labelling rule

Per-audience counts can leak by their *label*: the existence and activity level
of `#project-severance` is sensitive even with zero content attached. The rule,
stated now so M3's sources inherit it deliberately rather than by accident:

> **An audience the admin CONFIGURED may be named. An audience Atlas DISCOVERED
> gets an opaque handle.**

- **Configured → named.** The install config (`workspace_plugins.config` →
  `{"channels": [...]}`) is the record of what the admin typed into the form,
  and is already admin-readable. Showing a channel id back discloses nothing.
- **Discovered → opaque.** Anything else: an audience in a namespace
  `parseChatChannelAudienceId` cannot read, a channel absent from the config, a
  `user:` grant (Atlas resolved that person from a source roster; no admin named
  them), or a token outside the grammar. Rendered as `discovered-N` — a
  positional handle, deliberately **not** a hash of the id, since a ten-character
  Slack channel id salted with a workspace id the admin already holds is a
  brute-force range rather than a one-way function.
- **`org` and `role:*` → named, policy `intrinsic`.** A fixed public vocabulary
  naming no channel and no person. A third arm rather than stretching
  "configured", so the rule stays sharp where it matters.

The fail-closed direction is built in: a source whose audience ids this module
cannot parse gets opaque handles without anyone deciding, and an install-config
read fault withholds every label while leaving the counts intact.
### The corroboration rule — the grant a REPEATED claim ends up with

A company Slack restates the same claim across channels constantly, and the two
stages treat that differently on purpose:

- **At ingest / reconcile — nothing happens.** A second episode asserting a
  claim Atlas already holds corroborates it: one more `provenance` edge, and
  the fact itself is untouched. Its grant is still the one inherited verbatim
  from the *first* episode, whether the new episode is narrower or wider.
  ADR-0036 §T5 admits widening only at the review gate, so an unattended pass
  is precisely where it must not change.
- **At publish — the grants are unioned.** `promoteBrainFacts` reads every
  episode on a `provenance` edge to the draft and publishes it with its own
  grant plus every grammar-valid principal theirs name
  (`widenGrantFromEvidence`, #4823). So the claim posted in `#atlas-founders`
  and then repeated in `#general` is published `{audience:…, org}` rather than
  staying locked to the private channel it was seen in first.

The union is append-only — no token is ever removed, so this cannot narrow a
grant — and it only ever adds a principal some episode's grant *already* named,
so a reader who gains the fact had already been told the claim. Once a fact is
published its grant is sealed: later evidence does not re-open it.

One thing it *would* newly disclose, and no longer does: provenance rides the
fact's grant, and a fact's provenance names its **first** episode — for Slack,
`<channelId>:<ts>` plus the actor. So a fact widened out of `#atlas-founders`
would tell its new readers that the claim was first made there, and when.
[#4823](https://github.com/AtlasDevHQ/atlas/issues/4823) accepted that as the
price of the fix; [#4836](https://github.com/AtlasDevHQ/atlas/issues/4836)
narrowed it instead. The attribution triple (`sourceId`, `actor`, `occurredAt`)
is now withheld from any reader who reaches the fact *only* because it widened,
and kept intact for anyone entitled to the grant it had beforehand — so
enabling private-channel ingest does not leak channel membership through the
fact layer. See ADR-0036 §T5, `Amendment (2026-07-27, #4836)`.

Before that landed, a publicly-restated private claim stayed private. That was
fail-closed and never a leak, but it made org-wide information invisible to the
org — and unreportably so, since nobody can flag a fact they cannot read.

## The per-channel cursor

Slack pages `conversations.history` newest → oldest. A pass that runs out of
budget has covered the *top* of its window and left a hole at the *bottom* — and
in an append-only store "absent" and "not yet fetched" look identical. So the
per-channel mark (persisted opaquely in `knowledge_sync_state.sync_cursor`) is a
**discriminated union**, not a bag of optional fields:

```json
{"v":1,"channels":{
  "C01ABCDEF": {"ts":"…"},                          // contiguous
  "C02GHIJKL": {"ts":"…","top":"…","resume":"…"}    // backfilling
}}
```

- `ts` — covered contiguously up to here. Advances only when a window is
  covered end to end.
- `top` — the ceiling of an in-progress backfill, set when a pass truncates.
- `resume` — where the next pass continues walking downward.

That makes truncation **convergent** (each cycle fills more of the same window)
and **gapless** (the mark never jumps over an unfetched range). A single value
can have one property or the other, not both.

Gaplessness is a property of the whole pass, not just the mark, so two more
rules hold it up:

- **A channel the pass never reached keeps the mark it came in with.** The
  cursor is written as a whole-object replacement and the state upsert only
  COALESCEs a *null* cursor forward, so a channel missing from the new cursor is
  a channel whose mark is deleted — which restarts it at the floor. This is
  handled once, after the channel loop, so no future early exit can reintroduce
  it. (An early cut handled it per-branch and the rate-limit `break` lost every
  channel after the throttled one.)
- **A truncated pass with no resumable window keeps its incoming mark too.**
  Degrading an in-flight backfill to `contiguous` would discard a window whose
  bottom is unfetched, and since the next pass would then walk from `now`, hit
  the same obstacle and degrade again, that is a fixed point rather than a
  delay.

The union matters because `resume` **without** `top` is unsound in a silent way:
the pass would walk `[ts, resume]`, complete, take the ordinary completion
branch, and advance the mark to `now` — claiming coverage of `(resume, now]` it
never fetched. Both the parser and the walk refuse to construct a half or
out-of-order pair (`ts < resume ≤ top`), degrading to `contiguous`, which
over-crawls: more work, no gap.

A channel whose window is covered end to end advances to
`max(its old mark, the newest message seen, now − SAFETY_LAG)`
(= the engine's overlap window, reused because five minutes is the right order
of magnitude for both — not because they are the same mechanism). That is what
keeps a quiet channel's window from growing without bound while still not racing
messages in flight.

### Two budgets

`maxEpisodes` (the workspace's effective per-sync ingest cap) is a **hard
contract**: the engine refuses any batch over it, and because an error attempt
COALESCEs the old cursor forward, an over-cap batch would be recomputed and
refused identically every cycle, forever. So the walk checks the budget before
keeping each record and records `resume` at the last message it **walked**
(kept or skipped — resuming above a skipped one would re-read it forever), so an
over-large window becomes an ordinary truncation instead of a wedge. (The
250-record trial/starter tiers are where a between-pages-only check bit.)

A page budget (`HISTORY_MAX_PAGES_PER_PASS`) bounds vendor calls separately,
because kept episodes are not the only cost: a channel of pure join/leave noise
keeps zero episodes while still spending a Slack call per page. The
"not read this cycle" warning names whichever budget actually ran out — blaming
the record cap when the page budget bound would send an operator to raise a plan
limit that was never the constraint.

**The starting channel rotates each pass**, and the offset rides in the cursor.
A fixed order plus one shared budget is deterministic starvation: on the
250-record tiers one busy channel takes the whole cap every cycle and the
channels after it are never read — not slowly, never.

### `mode` does not change what this source fetches

ADR-0036 repurposes the reconcile cadence to **re-run extraction** (#4771), not
to re-crawl the source. There is nothing for a re-crawl to accomplish here:
episodes are append-only, so a reconciliation cannot archive absences, and a
channel added since the last pass has no mark and already backfills from the
floor on an ordinary cycle. An earlier cut had reconciliation rewind every
channel to the floor; combined with "an incomplete pass holds the reconcile
clock", that re-walked the same week every cycle and could not converge.

## Operating it

**Scopes are a staging-first change.** Reading history needs `channels:history`
and `groups:history`; resolving a private channel's audience (#4801, below) also
needs `users:read` and `users:read.email`. Two places must agree:

1. `SLACK_SCOPES` in `lib/integrations/install/slack-oauth-handler.ts` — that
   string *is* the OAuth `scope=` param, so without both scopes listed there no
   reconnect could ever grant them and the source would be uninstallable
   everywhere. #4770 added the history pair; #4801 added the directory pair.
2. The **Slack app manifest**, which per CLAUDE.md's operational rule is changed
   on the **staging** app first and soaked there. Until an app's manifest
   carries the scopes, Slack refuses the consent screen for the *whole* install,
   not just this source — so manifest first, then a re-install.

A workspace whose token predates them fails `missing_scope`, and the two pairs
surface in **different places**. The *history* scopes surface at install as a
field error and at sync time as the source's error row. The *directory* scopes
surface only in the audience-sync log and its span (`workspaces_failed`) —
there is no source error row for them, which is itself the argument for the
alert described under "Reading the cycle" below. Reconnecting grants either.

Note the asymmetry between the two additions. The channel **roster** read
(`conversations.members`) rides on `channels:read`/`groups:read`, which the chat
adapter's token already carries — so it costs no re-consent. Only the
**directory** read (`users.list`, for member emails) needs new scopes, which is
why the privacy decision #4801 records is narrowly *"may Atlas read Slack member
emails"* rather than *"may Atlas read Slack"*.

⚠️ **`users:read` without `users:read.email` is the dangerous half-grant.**
Slack does not error — `users.list` returns 200 with every `profile.email`
simply absent. Read naively that is "no member matched an Atlas account", which
reconciles to a **full revocation of every audience** while the cycle reports
success. `loadDirectory` detects that shape explicitly and skips the workspace,
but if you are editing scope handling, this is the failure to keep in mind.

## Audience membership (#4801)

A private channel's episodes carry `audience:chat-channel:slack:<id>` rather
than a principal list, so who can read them is answered *live* out of
`fact_audience_member` on every request. The `brain_audience_sync` fiber keeps
that table honest:

- **Cadence** — its own fiber, default every 30 min
  (`ATLAS_BRAIN_AUDIENCE_SYNC_INTERVAL_MINUTES`). That interval is the floor of
  the delay between someone leaving a channel and losing access to facts drawn
  from it — the number to quote when a workspace asks. Deliberately not
  folded into the history pass: a quiet channel would then never re-read its
  roster, and a quiet channel is where a stale roster survives longest.
- **Ceiling** — `ATLAS_BRAIN_AUDIENCE_MAX_STALENESS_HOURS`, platform-scoped,
  default **168 (7 days)**; `0` disables it. The cadence above is the floor of
  the revocation delay *when the roster reads succeed*; this is the bound on
  what happens when they don't. `fact_audience_member.synced_at` records when
  each membership was last **verified** — stamped on every successful reconcile
  including the no-op case, and left untouched by every abort — and past this
  bound `acl.ts` stops expanding those audiences into reader tokens. So a
  channel Atlas was removed from can no longer keep granting access forever
  (#4808). Suppressed grants are logged with their audience ids and counted;
  they are never dropped silently, which is what keeps the bound consistent
  with that module's refusal to downgrade a reader without saying so.

  ⚠️ The trade is real and points **both** ways. Fail-closed means a workspace
  whose Slack connection lapses eventually loses its own private-channel facts
  — a support incident. It was chosen anyway because that failure is *loud and
  diagnosable* (the counters below name the workspace) while unbounded stale
  access is *silent*, and because the blast radius is narrow: only `audience:`
  grants are affected, so `[org]` and per-user grants keep serving. Raise or
  zero the setting to restore reads without a redeploy — it hot-reloads.
- **Switch** — `ATLAS_BRAIN_AUDIENCE_SYNC_ENABLED`, workspace-scoped, **default
  ON** (unlike `ATLAS_BRAIN_EXTRACTION_ENABLED`, which spends model budget and
  defaults off). Read with no workspace it resolves to the platform value, which
  is the operator's process-wide off switch.
- **Identity** — channel members are matched to Atlas users by email, narrowed
  to the workspace's DNS-verified SSO domain when it has one. Atlas never
  creates a user, stores an address, or persists the roster; an unmatched member
  is reported (counts + a bounded per-reason sample, one line per pass) and
  gets no row. Full rationale: the ADR-0036 §T5 amendment.
- **Revocation** — the sync reconciles (adds *and* deletes). Dropping a row
  hides the facts on the reader's next read, with no re-ingest.

**Reading the cycle.** The `atlas.scheduler.brain_audience_sync` span carries
the counters, each prefixed `atlas.brain.audience.` (so the one to alert on is
`atlas.brain.audience.members_revoked`); `members_revoked` is the alertable one, since a spike is either a
real offboarding wave or a resolver that stopped resolving. `audiences_failed`
means a channel's roster could not be read *completely* — the sync then leaves
that audience's membership untouched rather than revoking the members it failed
to fetch, so a persistent non-zero count is stale-access risk, not data loss.

That risk is now **bounded and measured**. `stale_audiences` / `stale_workspaces`
count what has aged past `ATLAS_BRAIN_AUDIENCE_MAX_STALENESS_HOURS`, and
`oldest_verified_age_seconds` says how far past — which turns "some roster read
is failing" into "and it has been failing for eleven days", i.e. into a thing
with a deadline, since past the bound those grants stop being served. All three
report `-1` when the sweep itself could not run (span attributes have no null,
and `0` would be indistinguishable from all-clear). They are swept even when
there are no installs left to sync, because an install someone *disabled* stops
being reconciled while its membership rows stay.

`reads_throttled` versus `reads_throttle_exhausted` is the #4809 pair: the first
counts reads that hit a 429, backed off, and **got through** — healthy; the
second counts reads that gave up and aborted their scope. Before the backoff
existed every 429 was simply an abort, so "Slack throttles us occasionally" and
"this workspace has not reconciled in a week" were the same signal. A rising
`reads_throttle_exhausted` is the early warning for `stale_audiences`.

`principals_unresolved` is normal and non-zero in most workspaces (guests,
contractors, anyone without an Atlas account); the per-cycle log breaks it into
no-email / outside-verified-domain / no-Atlas-account, because those three need
three different operator actions.

**Installing.** Admin → **Knowledge Base → New collection** →
*Company Brain (Slack history)* — **not** Admin → Integrations, which buckets
only the `chat` and `action` pillars (`catalog-section.tsx`; `datasource` is
dropped explicitly and `knowledge` falls through both branches), so no
knowledge-pillar row ever renders there. The picker is data-driven from
`/api/v1/integrations/catalog?pillar=knowledge`; this source is pinned last in
`KNOWLEDGE_DISPLAY_ORDER` and its tile shows the full catalog name, because
`shortConnectorLabel` only strips a `Knowledge Base (…)` prefix and this row is
a `Company Brain (…)`.

It collects channel IDs and no secret: the connector reuses the workspace's
existing Slack OAuth install (`chat_cache`), exactly as `salesforce-knowledge`
reuses the Salesforce one (ADR-0030 amendment #4397).

Install-time verification probes every channel **twice**, and the second probe
is not redundant: `conversations.info` is gated on `channels:read`/`groups:read`
— which the chat adapter's token already has — so a one-message
`conversations.history` read is the only thing that can tell whether the token
carries the *history* scopes. Between them, "the bot isn't in that channel",
"that id doesn't exist" and "the token can't read history" are all 400s on the
form rather than a sync error a week later.

**Backfill.** `ATLAS_BRAIN_CHAT_BACKFILL_DAYS` (settings registry, default 7)
is how far back a channel with no stored mark reads. It is the lever when a
first sync reports that a channel has more history than one cycle can read.

**Known warts, and why they are not bugs.** The install is a
`pillar='knowledge'` row — that is what lets it reuse the install spine, the
bookkeeping, and the one cycle walk verbatim — so it appears on
/admin/knowledge as a collection with **zero documents** (its rows land in
`brain_episodes`) and it **consumes one of the workspace's plan-capped
knowledge-collection slots**. "Sync now" works and routes to the episode engine;
the sync row is where this source reports itself until the brain's own surface
lands in #4772.

A sync that succeeded but deferred work reports `coverageIncomplete` on the
collection list and renders as an amber **"Partially synced"** rather than the
green "Synced", so a source that is quietly achieving nothing — a channel the
bot was removed from, a budget that never clears — is visibly different from one
that is working.

**Re-adding a removed channel starts from the backfill floor.** The cursor keeps
marks only for currently-configured channels, so removing a channel and adding
it back later skips anything older than the floor at that moment. Widen
`ATLAS_BRAIN_CHAT_BACKFILL_DAYS` before re-adding if that history matters.

## Not ingested

Bot/app messages (`bot_id`) and membership noise (`channel_join`, topic
changes, …). Atlas's own Slack answers carry a `bot_id`, and ingesting them
would make the brain cite itself as evidence — the self-echo ADR-0036 §T9
neutralises on the write-back path for the same reason. The subtype filter is a
**denylist**: an unknown subtype is a message Slack added that probably does
carry content, and defaulting those to "drop" would silently lose evidence.

Messages with empty `text` are also skipped, because
`chk_brain_episodes_body_xor_locator` refuses `''` outright. That drops
attachment- and blocks-only posts whose content lives outside `text` — richer
extraction is M3's. Every skip is **counted**, and a pass that read messages but
stored none says so in its warnings, so "read 500, stored 0" never looks like an
empty channel.

1:1 DMs (`D…` ids) are refused at install: their audience is two people, and
ADR-0036 puts source-principal-resolution failure on the block side. Legacy
multi-person DMs carry `G…` ids and *are* admitted, ingested as private channels
with a channel-scoped `audience:` grant — fail-closed, just broader than "no
DMs" suggests.

**Thread replies are not fetched at all.** `conversations.history` returns
top-level messages and `thread_broadcast` copies; replies need
`conversations.replies`, which M1 does not call. So a thread-heavy channel
ingests only its top-level posts, and — unlike every other omission here —
replies are absent from the skip tallies too, because they are never read. The
source-id contract states the reply rule anyway, so the writer that does fetch
them agrees with this one.
