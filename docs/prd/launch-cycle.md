# The Launch Cycle — the sentence, the buyer, the demo, the gate

**Status:** Decided 2026-09-03, pending the maintainer's sign-off below. **Owner:** maintainer.
**Scope:** milestone [`v0.2.x — The Launch Cycle`](https://github.com/AtlasDevHQ/atlas/milestone/103) (#5602 – #5613). Five weeks, one gate that can fail.

Read alongside:

- [`company-atlas.md`](./company-atlas.md) — the destination. The sentence below is that page's claim, said to a buyer. Where the two disagree, the destination is right and this page is amended
- [ADR-0038](../adr/0038-the-atlas-is-the-product-the-brain-is-the-category.md) — *brain* is the category, *Atlas* is the product. Every surface in the cycle is written in that split
- [`.claude/research/ROADMAP.md`](../../.claude/research/ROADMAP.md) — where the gate's verdict is written when it is read

**Why this page exists.** Every later issue in the milestone renders the same three things — a sentence, a buyer, a demo — and one number decides whether the cycle continues. Written once here, before any surface moves, so that the landing page (#5606), the README (#5607), the docs (#5608), the launch post (#5610) and the Show HN (#5612) cannot drift from each other, and so that the number in week five is **read from a named source, not recalled.** An issue is not where a person checks a number six weeks later; this page is.

**The discipline**, inherited from the destination: no mechanisms in the sentence. If it names a table, a tool, a column or a vendor, it does not belong. The gate section is the one deliberate exception — a gate that does not name its query is a gate that cannot be read.

---

## The sentence

> **Atlas is the company facts your AI agents can trust: every one carries its source, its date, and the name of the person who approved it. Open source, runs in your VPC.**

**Checked against the destination.** The claim in `company-atlas.md` promises source, date and the name of the person who stood behind each fact, and that the unsurveyed parts are visible as unsurveyed. The sentence carries the first three word for word. The fourth is not in the sentence — it is what the demo shows, because "we mark what we do not know" is believed when seen and discounted when said. The sentence violates none of the eight things the Atlas will not do, and leans on three of them: it will not guess (1), it will not decide who is right (2), it will not learn behind your back (3) — *approved* is the word that carries all three. *Open source, runs in your VPC* is commitment 6 said in the buyer's register.

**Checked against the discipline.** No table, tool, column or vendor. *VPC* was the one word tested: it names a deployment boundary, not a mechanism, and the buyer below reads it as "self-host" faster than "infrastructure you control". Kept.

**What it replaces.** The live headline is *"Ask your data anything. Trust the answer."* over the subhead *"Atlas is the AI data analyst you can run anywhere…"* — both in `apps/www/src/components/landing/hero.tsx`, with the same copy in the site's meta description and Open Graph tags in `apps/www/src/app/layout.tsx`. (#5602 named `landing/data.ts` as the sentence's home; that file holds the demo question and the sample rows, not the sentence — the fold is in `hero.tsx`.) The April draft Show HN and blog intro in `.claude/research/launch/` describe a text-to-SQL product under an MIT license; both are superseded by this page and must not be reused.

**Where it renders, verbatim.** The H1, meta description, OG tags and WebMCP descriptor (#5606). The first line of the README and the repository *About* text (#5607). The first line of `llms.txt` (#5608). The launch post's opening (#5610). The Show HN body (#5612), whose title is the same sentence in HN's register: *Show HN: Atlas – company facts your AI agents can trust, with a human's name on every one*. The comparison pages (#5609) argue from it: the trust axis — who approved it, is it stale, can you self-host it, does it show what it does not know — not feature count.

---

## The buyer

**The engineering or data lead at a 50–500 person company who already runs Claude Code or Cursor at work and is tired of agents confidently inventing company facts.**

Why this buyer and not another:

- **The pull is already coming from them.** `@useatlas/mcp` outpaces `create-atlas` roughly 14:1 on npm downloads (#5602's figure, read from the npm download counts for the two packages) — the MCP front door is where strangers arrive, so the cycle meets them there rather than at a signup form
- **They read Hacker News**, which is the one distribution channel the cycle uses (#5612)
- **They have the problem in the sentence.** An agent stated the return window was 30 days; it was 14; nobody knows who told it that. The launch post (#5610) opens on exactly this

Who the buyer is **not**, so the surfaces do not drift toward them: the enterprise-search buyer, who wants breadth and will be better served by a vendor that indexes everything (commitment 5 concedes this on purpose); and the BI buyer, for whom text-to-SQL is the product. In this cycle the analyst is *the tier that cannot be wrong* — one screen down, never the headline.

**What the buyer says, in their own words**, is appended to the log at the end of this page, dated, one verbatim sentence per conversation (#5611). At least one landing-page copy change must trace to a quote there, or the conversations were decoration.

---

## The demo

Claude Desktop or Cursor, one command, one question, one answer with a name on it, one contradiction, one region shown as unsurveyed. Under sixty seconds (#5605). Recorded once, against the live hosted demo, embedded in the README, the hero, the launch post and the Show HN.

In order, and nothing else:

1. **One command** into Claude Desktop, against the hosted NovaMart demo, with no account and no email. Today the command is `bunx @useatlas/mcp init --hosted`; the anonymous demo form of it lands with #5604 and becomes the command every surface prints.
2. **One question:** *What is NovaMart's return window?*
3. **The answer, attested.** Who said it — Priya Natarajan, Head of Finance, in `#finance`, on a date — and who approved it. The approver is the real person who ran the seed, never a fictional colleague: finish condition 2 admits no exception for seeds, and the corpus records that deviation from #5603's wording deliberately.
4. **The contradiction, surfaced and not arbitrated.** Finance says 30 days; Support's macro says 14. Both claims, both sources, both names. Atlas has picked neither, and the all-hands transcript that raised it took it offline on purpose.
5. **The coverage page, with `#warehouse-ops` marked unsurveyed.** The channel exists in the company and nobody has surveyed it. The page is honest exactly where it is empty.

The demo is the sentence's three commitments, shown: it does not guess (5), it does not decide who is right (4), nothing is authoritative without a person's name on it (3). No admin console, no plugin list, no six chat platforms. The corpus also holds a warehouse-overlapping claim — a misremembered December 2024 GMV that the live rows outrank — which is available to the conversations and the docs but is not in the sixty seconds; five beats are enough, and Surveyed-outranks-Attested is the second screen's argument, not the first.

**What produces it.** The synthetic NovaMart corpus (#5603; the corpus and its seed landed in #5614 and #5616, and #5603 tracks what remains) — fictional people, fictional company, marked so nothing can mistake it for a customer's — seeded through the same intake, extraction and review seams a customer's data takes. Re-seeding is idempotent and a pg-backed test asserts the four first-load properties, so the demo cannot silently decay between the recording and the day.

---

## The gate

**Read two weeks after the Show HN posts.** The read date is the post's timestamp (recorded in the day's log below, #5612) plus fourteen days. Read on that date, not when convenient; a gate read late is a gate read with hindsight.

Each measure names the exact source that produces its number. The person reading it in week five runs the query and writes the result — they do not estimate, remember, or round.

| Measure | Continue | Rethink | Source, exactly |
|---|---|---|---|
| **GitHub stars** | 300+ | under 100 | `gh api repos/AtlasDevHQ/atlas --jq .stargazers_count` — the count on the read date, not the delta; the count on the post date is recorded in the day's log so the delta is derivable |
| **Anonymous MCP demo sessions** | 100+ | under 30 | Against the `us` region's internal DB (the only serving region — `eu` and `apac` are parked): `SELECT count(*) FROM demo_anonymous_sessions WHERE created_at >= '<post timestamp>' AND created_at < '<read timestamp>';` — the table lands with #5604, and the day's log (#5612) reads referrers from the same table so it can say where the sessions came from |
| **Real conversations held** | 10+ | under 3 | The maintainer's Google Calendar, on a dedicated calendar named **`Atlas launch conversations`** — one event per conversation, titled with the person's name and company, in the window from the post timestamp to the read date. The count is the number of events in that window. Each is mirrored in the log below with a dated verbatim sentence; the calendar is the count, the log is the record |
| **Design partners committed** | 2+ | 0 | A countersigned design-partner agreement, filed in the private repository **`AtlasDevHQ/design-partners`**, one directory per partner named for the company, holding the signed PDF and a `README.md` stating the next step and its date. The count is the number of directories holding a countersigned agreement. A verbal yes, an email, or an intent to sign is zero |

**Both columns close the milestone.** The milestone `v0.2.x — The Launch Cycle` closes on #5613 whichever column the gate lands in. A rethink verdict is a finding — a different buyer, or a different sentence, never a feature — and it closes the milestone as surely as a continue. A held-open issue is not how a failed cycle is tracked.

**The verdict is one word**, *continue* or *rethink*, decided as follows:

- **Rethink** if two or more measures land in the Rethink column
- **Continue** if three or more land in the Continue column and none in Rethink
- **Otherwise the maintainer decides**, and the ROADMAP entry says why, with the numbers beside the reasoning. The gap between the columns is where judgement is allowed in; the columns are where it is not

**Where it is written.** In [`.claude/research/ROADMAP.md`](../../.claude/research/ROADMAP.md) under `## Next`, as a dated entry in the record's style: the four numbers, each with its source query and the date and time it was read, the column each landed in, the one-word verdict, and what did not hold. The same four lines are appended to the log at the end of this page. **If continue:** the next milestone is design-partner-driven, and finish conditions 1 and 3 of the destination are its first two issues. **If rethink:** the HN thread and the conversations log say which of the buyer or the sentence was wrong, and the next entry on this page is a new sentence or a new buyer, dated.

---

## What this page does not decide

- **The recording's take.** #5605 owns it; a re-take after the corpus changes replaces it everywhere in one commit
- **The price.** The conversations (#5611) ask what a buyer would pay and to whom the invoice goes; the answer is appended to the log and decided after the gate, not before
- **Anything beyond the milestone.** Finish conditions, the arc's order and the eight commitments belong to the destination

---

## Sign-off

This is a decision, and the actor who proposed the check is not its only judge.

**Maintainer (Matt Sywulak):** _______________ **Date:** _______________

---

## Log

Append-only, dated. Nothing above this line changes after sign-off except by a dated amendment here.

### Conversations (#5611)

*None yet.* One entry per conversation: date, who (role and company size, no name unless they agreed), what they do today when an agent states a company fact, one verbatim sentence, what the demo failed to show them, and whether they asked to be a design partner.

### The day (#5612)

*Not yet posted.* The Show HN text as posted, the post timestamp, the star count at posting, the directories listed by end of day, and where the demo sessions came from, read from the referrers.

### The reading (#5613)

*Not yet read.* The read date, the four numbers with the query each came from, the column each landed in, and the verdict.
