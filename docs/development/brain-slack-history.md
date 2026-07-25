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

Membership population is #4771's, so **until it lands, a private channel's
episodes are visible to nobody.** That is the fail-closed direction and it is
repairable with no rewrite: the grant names the audience, and filling the
membership table makes the existing rows visible.

The deriver emits only tokens `parseGrant` finds usable, and `episodes.ts`
re-checks with `isUsableGrant` before the INSERT. This matters more than it
looks: `chk_brain_episodes_grant_nonempty` admits `['everyone']`, which grants
nobody anything and — once episodes become facts — would be refused at every
publish forever by #4769's `GRANT_UNUSABLE` classifier, with no repair UI until
#4772. That refusal is meant to be defence in depth, not a live trap.

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
and `groups:history`. Two places must agree:

1. `SLACK_SCOPES` in `lib/integrations/install/slack-oauth-handler.ts` — that
   string *is* the OAuth `scope=` param, so without both scopes listed there no
   reconnect could ever grant them and the source would be uninstallable
   everywhere. #4770 adds them.
2. The **Slack app manifest**, which per CLAUDE.md's operational rule is changed
   on the **staging** app first and soaked there. Until an app's manifest
   carries the scopes, Slack refuses the consent screen for the *whole* install,
   not just this source — so manifest first, then a re-install.

A workspace whose token predates them fails `missing_scope`, surfaced at install
as a field error and at sync time as the source's error row; reconnecting is
what grants them.

**Installing.** Admin → Integrations → *Company Brain (Slack history)*. It
collects channel IDs and no secret: the connector reuses the workspace's
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
