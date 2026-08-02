# Brain M3 — Source Breadth: per-issue notes

> Working notes for [milestone #93](https://github.com/AtlasDevHQ/atlas/milestone/93), accumulating on **`milestone/brain-m3`**. The [`ROADMAP.md`](./ROADMAP.md) bullet tracks *shipped/open state only*; the per-issue detail — decisions, review-panel findings, and the traps worth carrying forward — lives here.
>
> This file exists because the M3 bullet reached ~14k characters against the ROADMAP's ~240-char line-item cap. At M3 closeout, ROADMAP's section collapses to one line and moves to [`ROADMAP-archive.md`](./ROADMAP-archive.md); this file is the detail layer that survives it.
>
> **Arc conventions** (the #91/#92 pattern): CI fires per #4795, CodeQL is deferred to the eventual `milestone/brain-m3` → `main` PR — deferred, not waived — and `Closes #N` won't auto-close, so issues are closed by hand after merge.
>
> **Scope**: ADR-0036's T6 class expansion, deliberately *after* trust. Scoped to the seam + two classes — `docs/wiki/code/drive` is deferred, since M2 was planned at 7 issues and grew to 19 under review.
>
> **Vendors were deliberately undecided, and both were confirmed with the maintainer rather than inferred** — #4965 recommended Zoom and got it; #4966 recommended Gmail and got **Outlook / Microsoft Graph** instead.

---

## #4963 — generalize the connector seam (foundation, blocked all)

✅ **shipped 2026-08-01** ([PR #4970](https://github.com/AtlasDevHQ/atlas/pull/4970), `9eccdda66`)

Issue was stale, the contract/registry/engine-reuse already landed in #4770/#4938; the real work was the class/vendor split. `EPISODE_SOURCE_SPECS` declares each member's class+vendor, `isWarehouseDerived` reads the CLASS, `findBrainSourceConnectors` resolves both axes, `episodeSourceClassOf` is the total reader for stored rows.

⚠️ **`architecture-wins.md` has no entry for this** — flagged on the issue during the 2026-08-02 `/tidy`. The seam proof is empirical and worth capturing: #4965 and #4966 each added a whole source class with `episode-sync.ts`, `episodes.ts`, and `ingest/types.ts` untouched, and #4966 extended `grant.ts` additively with a third deriver rather than branching an existing one.

---

## #4965 — transcripts class

✅ **shipped** — **vendor confirmed: Zoom** ([PR #4972](https://github.com/AtlasDevHQ/atlas/pull/4972), `d21aec0e8`)

New CLASS `transcript` + vendor `zoom`, built ON the seam (`episode-sync.ts`/`episodes.ts`/`ingest/types.ts` all untouched — the seam proof). `deriveMeetingParticipantGrant` has NO public arm, so `[org]` is unreachable by construction rather than by rule; block-vs-flag is structural — the connector resolves the AUDIENCE only and resolves no entities, so it has no path that could turn an unrecognised speaker into a block. Membership is written at ingest from the roster that licensed the grant and re-verified via a new registry seam in `audience/sync.ts` (a meeting's participant list is frozen, but its RESOLUTION to Atlas users is not, and `acl.ts` suppresses any audience past `ATLAS_BRAIN_AUDIENCE_MAX_STALENESS_HOURS`).

**Two review-panel rounds, and round 1's own fixes shipped two criticals** — the cursor (not the high-water mark) is this connector's real resume point, and a new size guard became an outage. 29 mutations across three passes, one file per `bun test` process.

---

## #4966 — email class

✅ **shipped** — **vendor confirmed: Outlook / Microsoft Graph** ([PR #4976](https://github.com/AtlasDevHQ/atlas/pull/4976), `9d1998993`), chosen by the maintainer over the issue's own Gmail recommendation (Atlas already ships a Teams adapter).

Third CLASS `email` + vendor `outlook`, second connector built ON the seam (`episode-sync.ts`/`episodes.ts`/`ingest/types.ts` untouched again; `grant.ts` extended additively with a THIRD deriver rather than a branch).

**The class where the audience stops being enumerable** — BCC is invisible to recipients and forwarding leaves no trace on the original, so the derived grant is knowingly a LOWER BOUND. **Posture: From+To+Cc, Bcc ignored even on the sender's copy that exposes it** — and the reason is DETERMINISM rather than safety: episodes dedupe cross-mailbox on the RFC 5322 Message-ID, so which copy wins is undetermined and `bccRecipients` exists only on the sender's. The source-id contract and the ACL posture are load-bearing on each other and must move together.

One episode per MESSAGE, never a thread (a thread grows and episodes are immutable; a late-added recipient would inherit access to earlier messages), keyed on the Message-ID and never Graph's `message.id`, which is per-mailbox AND re-minted on folder moves.

A second split beside block-vs-flag: RETRYABLE conditions freeze the resume point, PERMANENT ones are counted skips that let it advance — conflating them is how #4965's size guard became an outage. Mailboxes are REQUIRED and non-empty, inverting Zoom's optional host list, because Graph's application `Mail.Read` is tenant-wide with no narrower scope.

**Two review-panel rounds, and round 1 found three criticals** — every mailbox the pass did not WALK had its watermark deleted (`slack/client.ts` already carried that fix *with a post-mortem*; this reintroduced it, and a single-mailbox test harness hid it); a Message-ID is sender-controlled and leaks in every reply's `References:`, so the audience id was a pure function of two attacker-supplied values and a forged mail could revoke the real recipients while the evidence survived — the id now binds a digest of the participant set; and `JSON.parse`'s error message echoes its input, which was the decrypted client secret. A flagship ⭐ test was also VACUOUS (a variable read before it was assigned, so the assertion held under either ordering). 85 mutations across four passes, one deliberate documented survivor.

**Inherited #4971's re-verifier starvation** — registered through the existing `audience/reverify.ts` seam rather than shipping a second copy of the fix, so both connectors inherited the fix when it landed. Email made the starvation worse than Zoom (a revoked mailbox fails every one of its audiences at once, where Zoom's retention expiry arrives gradually). Also registered `ATLAS_BRAIN_TRANSCRIPT_BACKFILL_DAYS`, which #4965 read but never added to the settings registry.

**Arch backlog filed**: [#4975](https://github.com/AtlasDevHQ/atlas/issues/4975) — whether hand-rolling every vendor HTTP client is right, or the shared half should be extracted.

---

## #4971 — re-verifier starvation

✅ **shipped** ([PR #4977](https://github.com/AtlasDevHQ/atlas/pull/4977), `e3648b0c6`)

The only M3 item that degraded ALREADY-SHIPPED code, and it had two inheritors rather than one. Both re-verifier scans ordered on `MIN(fact_audience_member.synced_at)`, which only a SUCCESSFUL reconcile advances, so an audience that aborted every cycle held a scan slot forever; past the 200-slot cap nothing else was re-verified, everything crossed `ATLAS_BRAIN_AUDIENCE_MAX_STALENESS_HOURS`, and `acl.ts` suppressed the grants — facts stored and invisible while the cycle reported `degraded` at worst. Both sources reach that state routinely (Zoom's past-meeting report ages out of retention; one Exchange admin action fails every Outlook audience from a mailbox at once).

**The fix is a separate TABLE, not a column** — 0186's `brain_audience_reverify_attempt`, stamped for every audience the scan hands back BEFORE any vendor call and for every outcome including the aborts. A member-less audience has no membership row to stamp, and `synced_at` is evidence `acl.ts` reads, so a stamp advancing on an abort would fake a verification and keep a revoked grant alive past the bound. Stamped ON SELECTION rather than per outcome, which makes the omission unrepresentable: the two connectors have TEN branches that end without a reconcile, and the `catch` arms are the ones that get forgotten.

The scan itself MOVED into `audience/reverify.ts` — the per-source copies differed only in a token prefix and a source kind, so those stayed parameters and the ordering did not. Also closed the second residual (`has_members DESC` as an absolute priority deferred member-less audiences forever, so the "someone joined Atlas later" repair never ran — a tenth of each cycle is now reserved for them) and the `-pg` gap both copies declared in their own docstrings.

**THREE review-panel rounds, and round 1's own fix shipped a regression round 2 reverted** — hoisting `resolveToken` above the scan made an enabled install with zero audiences resolve an uncached token every cycle and stand the cycle permanently `degraded` over a workspace with nothing to verify. Round 1 also found two `-pg` tests that passed against mutations restoring the bug (three scans only exercise the stamp's INSERT arm; a fixture token won the reserve on the alphabet rather than on the reserve). Round 2 found both LEFT JOINs' `workspace_id` predicates deletable with everything green — the second is #4971 rebuilt ACROSS tenants — and round 3 found `redactAudienceDigest` applied at six call sites none of which a test could see, which then surfaced a routine-path digest leak in `client.ts` from #4966.

---

## #4967 — webhook fast-path for chat

✅ **shipped** ([PR #4978](https://github.com/AtlasDevHQ/atlas/pull/4978), `d17324999`)

The only M3 item crossing the plugin boundary, and it needed **no new transport**: `message.channels`/`message.groups` have been subscribed since the 2026-07-30 reinstall, so the fast-path is a tee off the event stream the chat pillar already receives, through a new `ChatPluginConfig.observeMessage` seam.

**The safety argument is structural rather than documentary** — the webhook does not re-derive the source-id, it builds the poll's own `SlackHistoryMessage` and calls the poll's own `toEpisode`, so `slackEpisodeSourceId` has ONE caller for both writers and the skip rules come along for free. What the webhook owns alone is *which field the `ts` is read from*, and that is the whole trap: `event_ts` sits beside `ts` on every event, and a `message_changed` envelope carries three candidate timestamps of which only `event.message.ts` is the message's identity.

**The edit decision is deliberate and reverses the general rule**: `episodes.ts` says an edited message is a NEW episode, but the clause it defers to is "*a new `source_id` is the source's business*", and Slack's contract mints no new id for an edit — so an edit COLLAPSES onto the stored episode, matching the poll exactly.

**Three arms, not one**: `Chat.dispatchToHandlers` is a router with early returns, so the pattern arm the proactive listener uses would have silently missed every @-mention and every subscribed-thread follow-up — the highest-value messages in the channel.

**Grant derivation takes no round-trip** — `channel_type` instead of `conversations.info`, blocking on anything unrecognised, because an episode's grant is frozen at insert and the poll's later correct grant arrives too late to replace a wrong one.

Knob `ATLAS_BRAIN_CHAT_WEBHOOK_ENABLED` defaults **OFF** and off is a supported steady state: the tee drops messages by design (the SDK's default `drop` concurrency strategy discards a message whose thread lock is held; the adapter filters `message_changed` before dispatch) and every one is stored by the next cycle. Corroboration non-inflation is asserted **directly and in both directions** — one message delivered twice earns ONE provenance edge, two distinct messages earn two, so the assertion cannot pass because the edge writer is inert.

⚠️ **The backstop claim is narrower than it reads, and the panel caught it**: the SDK's lock key is `slack:<channel>:<thread_ts || ts>`, so a top-level message never contends and **only thread replies can be dropped by lock contention** — exactly the messages `conversations.history` never returns. "Anything we drop, the poll stores" is therefore FALSE for the one class this path uniquely covers, so not-stored outcomes carry `pollBackstopped` and the observer warns on an unbacked loss instead of reciting the reassurance. (Narrowed further by #4969's panel — see below: `conversations.history` *does* return `thread_broadcast` copies, so the absolute was wrong in the alarming direction.)

**One review-panel round, three real defects in round 1** — that claim; a fault arm folding every throw into `unparseable_event`, which also carries steady-state `app_mention` refusals (so a DB outage and normal traffic produced the same counter); and an observer with NO deadline, running first and inline while the SDK holds the thread lock, wired to uncached DB round trips whose 10s connect timeout ×3 exceeds the 30s lock TTL. Also fixed: a swallowed install-config parse error, and a registration that could be deleted outright with every test still green. Two comments asserted things the SDK source contradicts.

15 mutations, all red where expected — the seven id/grant/scope guards, plus the fault arm, the backstop flag, the unreadable-config reason, pattern-arm-only registration, adding the DM arm, registering the raw callback, removing the deadline, and dropping the defensive normalisation. **One mutation initially SURVIVED and the mutation was the thing at fault** — it added a no-op racer rather than removing the deadline; the faithful version made the suite HANG rather than fail, so the test was reshaped to report `expected "settled", got "hung"`.

---

## #4964 — out-of-vocabulary episode source (M2 fail-open lane)

✅ **shipped 2026-08-01** ([PR #4973](https://github.com/AtlasDevHQ/atlas/pull/4973), `f34f8d33d`)

Surfaced by the M2 closeout; #4965's `zoom` made it live rather than latent.

**Resolution: quarantine, not refuse.** The import still restores verbatim: 0180 leaves `brain_episodes.source` plain `text` with NO CHECK, so refusing would be stricter than the database is at rest, and all-or-nothing bundle validation would strand a whole workspace at cutover. Restoring evidence is not a new arbitration — correcting it is, so `correction.ts` refuses there instead, under its own reason rather than by pretending the fact is warehouse-derived.

**Two conditions, because `isEpisodeSource` requires a string:** `UNRECOGNIZED_SOURCE_KIND` heals when a release admits the kind, `MALFORMED_SOURCE_KIND` never can and says so — the gate also blocks `retract`, the GDPR-erasure verb, so a false "wait for a deploy" was the round-1 defect. Round 1 also shipped a `String(source)` that **throws** on `{"toString":1,"valueOf":2}` — a JSON-reachable shape — turning the designed 409 into a 500 and losing the log that names the value.

**Two panel rounds, round 1's own fixes shipped both defects.** 11 mutations; a literal re-derivation of the vocabulary is behaviourally identical today, so only a source-text pin sees it. Promotion deliberately NOT gated and the absent-key carve-out deliberately kept — both documented in-source.

---

## #4969 — docs: source classes, audience limits, connector authoring, webhook setup

✅ **shipped 2026-08-02** ([PR #4979](https://github.com/AtlasDevHQ/atlas/pull/4979), `f52e9c3bc`)

Three new shared guides wired into **both** audience navs, plus the brain knobs the env reference and `.env.example` were both missing:

- **`brain-sources`** — the class/vendor split; why the connector order (chat → transcripts → email → docs) tracks **ACL difficulty** rather than volume; per-class audience derivation with honest limits. The email under-grant caveat is in the **docs**, not only the source, and `visible_to` is never a disclosure record. Extraction lag (`tier: raw-episode, extraction: pending`) documented as committed behaviour, not a bug.
- **`brain-chat-webhook`** — setup, and that **poll remains the correctness floor**, with the one exception named rather than glossed.
- **`brain-connector-authoring`** — the `BrainSourceConnector` contract, the **stable source-id obligation** with all three shipped ids as worked examples, and the class-vs-vendor storage grain in operator language.

**A five-reviewer panel caught claims that were false, not merely vague:**

- "Connectors run at different cadences" — there are none; one shared cycle at `ATLAS_KNOWLEDGE_SYNC_INTERVAL_HOURS` (default 24h). That wrong explanation displaced the number operators need: extraction drains **25 episodes / 5 min, process-wide, no knob**.
- The Observability section promised **reason counters that do not exist**, and backstopped skips log at `debug` while `ATLAS_LOG_LEVEL` defaults to `info` — so `channel_not_configured`, the likeliest cause of "enabled but storing nothing", emitted nothing by default.
- "The install probe exercises both" — it checks `Mail.Read` on the **first mailbox only**.
- "`conversations.history` never returns thread replies" — it returns `thread_broadcast` copies, so the absolute was wrong in the *alarming* direction. **This narrows #4967's `pollBackstopped` framing above.**

Two safety caveats the pages were vaguer about than the source: the email grant **token** is not copy-independent (only the resolved people are), so a mailbox later losing `Mail.Read` silently retires facts other recipients can still read; and email's per-message grain has a **~67,000-audience ceiling** past which email facts stop being readable — fail-closed but unobservable.

⚠️ **The nav trap is now mechanical rather than a manual check.** A shared page omitted from one mount's `meta.json` was still routable and still passed `check-docs-links.ts` — verified by deleting an entry and watching the gate stay green — it simply vanished from that audience's sidebar. Three tests in `source-partition.test.ts` derive their scope from disk, so a *new* hand-maintained nav pair is covered the day it is added.

Adjacent code rot fixed (comment/description strings only): three `settings.ts` descriptions calling these knobs chat-only post-M3; `types.ts`'s "no production caller today" (the webhook is one); `sources.ts`'s vendor list missing `outlook`; `grant.ts`'s "Derivable →" example omitting the participants digest; and 11 dead part-file links in `.claude/commands/audit-docs.md`.

---

## #4968 — e2e multi-source proof (the arc proof that closes M3)

✅ **shipped 2026-08-02** ([PR #4980](https://github.com/AtlasDevHQ/atlas/pull/4980), `ce2a3a3d9`)

`multi-source-pg.test.ts`, the third arc proof after #4775 (one source) and #4917 (one timeline). One `it`, three source classes alive in one workspace, nine steps, **119 assertions, 31 mutations**. CI shard 1/4 confirms it EXECUTES there (6.3s) rather than skipping — the api-tests job sets `TEST_DATABASE_URL`, the local `/ci` wrapper does not.

**What it proves that the per-connector suites structurally cannot**, each of them having exactly one class to look at:

- **Cross-class corroboration.** `CORROBORATION_LOOKUP_SQL` is source-blind by design, so a claim said in a Zoom meeting and repeated in an Outlook mail strengthens ONE row with two provenance edges. Asserted as a row TOTAL rather than only "one Q3 row" — a lookup that narrowed by source mints a duplicate, one that widened swallows an unrelated claim, and only a total catches both.
- **#4823's grant widening AT A CLASS BOUNDARY**, with its read-side companion: the claim was granted to a meeting, corroborated by a mail, published with the UNION — so the mail reader gains the claim and, matching none of `pre_widening_visible_to`, is NOT told it was said in a meeting he was not in. Widening and attribution-narrowing live in different files and this is the only place they meet.
- **Cross-class contradiction.** The counterpart carries its OWN class's provenance on both surfaces, with the classes swapping sides between them — a projection reusing the owner's provenance is green everywhere else. The withheld arm is the same claim from the other side: the meeting reader is told a contradiction exists in a class she cannot read, and nothing about it.
- **Per-class ACL isolation** across four readers whose grant sets differ by exactly one token each (`org` / `+meeting` / `+email` / all), at BOTH tiers — facts and episodes are gated by separate clauses over separate tables, and a separate mutation pins each.
- **Extraction lag** (§T7): a labelled `pending` episode, ACL-gated like any other, in a response that still serves every fact.

**The three arc changes since the issue was written, all reflected:**

- The **email lower bound** is an equality at the deriver AND at `fact_audience_member`, with the narratively-BCC'd reader named. Worth recording: the bound is STRUCTURAL rather than posed — `OutlookMessage` has no bcc field and `$select` never asks for one, so the fixture *could not* put a BCC'd recipient on a message.
- **Staleness suppression** (#4971 / 0186) would fake every ACL negative in the file, because "suppressed as stale" and "correctly denied" are indistinguishable from the reader's side. Freshness is a pinned premise through `acl.ts`'s own `AUDIENCE_MEMBERSHIP_SQL`; forcing the flag false is one of the 31 mutations; and `brain_audience_reverify_attempt` is asserted EMPTY so freshness is provably the ingest-time reconcile's, not a re-verification's — a future change that wires the scan in has to confront that rather than inherit a green file.
- Nothing asserts #4967's absolute backstop claim (#4969's panel narrowed it), so chat appears only as the poll.

**Two consequences the test PRODUCED rather than confirmed:**

- ⭐ **Supersession is grant-blind ACROSS A CLASS BOUNDARY.** The collision join never reads `visible_to`, so a mail nobody in the meeting can read retires the meeting's belief for them: the meeting reader's answer does not become the mail's, it simply ENDS. #4917 pinned the same-class version; no ADR states the cross-class one.
- ⭐ **A principal context is a SNAPSHOT, and email is where that bites.** Chat and transcript audiences are per-container and per-meeting, so a reader's set grows slowly; email's grain is per MESSAGE, so every mail a reader receives invalidates their held context. Two readers had to be re-resolved mid-loop, and the premise is asserted in BOTH directions — one ACL negative would otherwise hold by staleness rather than by exclusion.

**The two #4917 vacuity traps, handled structurally.** The file defines no `AS_OF` constant at all: every fact here has `valid_from NULL`, which #4916 admits at any instant, so the only point reads bracket the gate's own stamp at ±1ms (microseconds put equality out of `parseBrainAsOf`'s reach). Removing the `valid_to` upper-bound predicate is the mutation that arm exists for, and the only one it catches.

**Mutation discipline.** Every mutation REMOVES behaviour; none adds a no-op — the shape that makes a survivor look like a test gap. **One assertion has no faithful mutation and is documented in-source rather than dropped** ("the same call still served the facts" pins the ABSENCE of a degradation path, so failing it would mean ADDING one), as are two COMPOSITION guards whose predicates another assertion already pins (the `asOf` reads' isolation, the queue's counterpart class).

**Two fixture premises the run itself corrected**, both worth carrying: the `duplicate` counts are a statement about the cursor-less premise (no `workspace_plugins` row ⇒ `knowledge_sync_state` stays empty ⇒ every pass re-walks its backfill), now asserted per sync on BOTH tables — the first draft asserted only the install table and got the counts wrong; and audience membership is sorted in JS with an explicit code-unit comparator, so the equalities are not a statement about the test database's collation (and `require-array-sort-compare` is a type-aware lint ERROR, not a warning).

⚠️ **Not reviewed by the review panel** — that gate was not run for this PR.

**Also carried**: a one-line `bun.lock` catch-up. #4965 bumped `packages/types` to 0.8.0 without it and the lockfile still said 0.7.0; local `bun install` reconciled it. CI never caught this because the api install deliberately runs without `--frozen-lockfile`.

---

## #4962 — the tension module's own test file (M2 debt, last item in M3)

✅ **shipped 2026-08-02** ([PR #4981](https://github.com/AtlasDevHQ/atlas/pull/4981), `b87de758d`)

`tensions.test.ts` — 26 tests, 72 assertions, **38 mutations, zero survivors**. Unit-level over an injected `db.query` rather than a `-pg` suite: every invariant is a decision the module makes in TypeScript, and the database half is already pinned twice, by `acl-visibility-pg.test.ts` (the predicate against real `&&`) and by `search-pg.test.ts` / `multi-source-pg.test.ts` (the integrated walk).

**What the two caller suites structurally could not reach**, each of them having exactly one surface to ask with:

- **The walk is surface-invariant.** One fixture through `review` and through `search` must yield byte-identical clusters, SQL and params — the claim #4913 was made for, and invisible from either caller. Only the log prefix and the error's `surface` may differ. Three mutations pin it: a surface-branched early return, a surface-dropped SELECT column, a surface-dependent cap probe.
- **The deny-all THROW.** Both callers already threw on the same decision against the same table, so this module's throw is reachable only from here — and it is the guard against FABRICATED ACL WITHHOLDING: delete it and every rival comes back unresolved, i.e. reported as withheld, which no reviewer and no agent can tell from the real thing.
- **The cap is the CALLER's.** Each caller suite has exactly one cap constant, so a module-level default overriding one of them goes unnoticed there.

**The negative criterion, stated at the layer this module owns.** Nothing deletes an `in-tension-with` edge and neither retirement verb writes `status`, so a settled rival arrives looking *exactly* like a live one. Four rivals identical in every column but their stamps — live · superseded · retracted · scheduled-to-close (FUTURE `valid_to`, which is still LIVE) — asserted in both directions: strip the two stamps and settled is byte-identical to live; keep them and it is not. The id-bearing form of that second assertion would have passed on the id alone.

⭐ **The fixture is an EVALUATOR, not a script.** `store()` evaluates the emitted counterpart statement — overlap against the tokens the module ACTUALLY BOUND, containment against the workspace it bound, and **projection down to the columns its SELECT names**. That last part is what gives "both temporal stamps are SELECTED" a faithful mutation at all: with a canned fixture, deleting `f.valid_to` from `COUNTERPART_COLUMNS` leaves every assertion in the file green. Reader contexts resolve through `resolvePrincipalContext` for the same reason — a hand-written `BrainPrincipalContext` makes each ACL assertion a statement about the literal.

**Both #4968 ACL traps carried forward.** Freshness is a pinned premise through `AUDIENCE_MEMBERSHIP_SQL`, and the suppression is asserted in BOTH directions at this surface: same rival, same grant, same reader — visible when the membership is fresh, **WITHHELD (not dropped)** once it ages past the bound. Three `acl.ts` mutations prove the negatives depend on the real suppression rather than on the fixture's idea of which audiences survived.

⭐ **Method: the shadow-lift loop is worth scripting.** Apply mutation → run → NOOP-out the failing assertion → re-run until green, so each mutation yields EVERY assertion it reaches rather than only the first. It moved verified coverage from 53/72 to 63/72 and produced four extra mutations aimed at assertions the first pass never reached. Without it the battery would have read "37/37 killed" while a fifth of the file was unverified.

⚠️ **`git checkout --` restores the INDEX, and that bit.** The lift loop reverted the test file via git while a staged copy predated an in-flight edit — silently undoing real work and running a whole battery against the wrong file. Caught only because line numbers didn't move after an edit that added ten lines. The loop now snapshots the file verbatim. This is the sharper edge of the known "`git checkout --` cannot revert an UNTRACKED file" trap: tracking the file is necessary but **not sufficient** — the index has to be current too. Prefer a content snapshot over git for any revert inside a mutation loop.

**Three assertions have no faithful mutation and are documented in-source** rather than dropped: `edges.length === 0`'s early return is SHADOWED by the `pairs.length === 0` one (so the test claims the observable property — an empty edge set never reaches the ACL'd statement — which removing *both* does turn red); the empty-result SHAPE has no degradation path, only a value to corrupt; and two assertions are owned elsewhere (an absence pin, and `aclVisibilityClause`'s own tenant containment, which `acl.test.ts` and `acl-visibility-pg.test.ts` pin).

⚠️ **Not reviewed by the review panel** — that gate was not run for this PR.

---

## Open

Nothing — M3 is 9/9 and ready for closeout.
