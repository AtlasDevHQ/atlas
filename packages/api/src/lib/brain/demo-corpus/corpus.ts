/**
 * The synthetic NovaMart company corpus — what the demo workspace's people
 * "said" to each other, written to be extracted from (#5603, launch cycle).
 *
 * ## What this is, and what it is not
 *
 * **Every word here is fiction.** NovaMart is the demo e-commerce company whose
 * SQL dataset ships with `create-atlas` (52 tables, ~480K rows); this file gives
 * that company a Slack, an all-hands recording and a mailbox, so the Company
 * Atlas has something to survey on the hosted demo. The people are invented,
 * the vendor ids are invented (every id carries the `NMD` marker so nothing can
 * mistake one for a real Slack/Zoom/Graph identifier), and the text was written
 * by hand for this purpose.
 *
 * It is therefore OUTSIDE both prohibitions that govern corpus text in this
 * repository, and it says so here rather than leaving a reader to work it out:
 *
 *   - `.claude/research/extractor-corpus-acquisition.md` forbids committing
 *     CUSTOMER text. This is not customer text; no tenant wrote it.
 *   - ADR-0044 forbids fact content entering model weights. This corpus is an
 *     INPUT to the ordinary extraction path (a model reads it and proposes
 *     claims), never a training example, and the seed writes no weights.
 *
 * ## What the corpus is designed to produce, on first load of the demo
 *
 * Six properties the demo shows, each traceable to specific episodes or
 * documents below:
 *
 *   1. **Approved claims with a name on them.** Every episode has a synthetic
 *      author whose directory identity the seed captures, so a claim renders as
 *      "Priya Natarajan, as of <date>" rather than an opaque handle.
 *   2. **One contradiction Atlas does not arbitrate.** Finance says the return
 *      window is 30 days (`#finance`); Support's macro says 14 (`#support`).
 *      Both are stated as NovaMart's return window so they land in one slot, and
 *      the seed declares that predicate `single` so the tension edge is minted.
 *      Nothing in the corpus resolves it — the all-hands transcript raises it and
 *      takes it offline, on purpose.
 *   3. **One department nobody has surveyed.** `#warehouse-ops` exists in the
 *      roster and has NO episodes, so the coverage page shows it as
 *      unsurveyed — the honest, most useful state (PRD "What a person can do" §7).
 *   4. **A claim that overlaps the warehouse.** Priya misremembers December
 *      2024 GMV in `#finance` — a month the NovaMart orders table actually
 *      covers (its rows run 2020 to early 2025), so the live rows can outrank
 *      her recollection (Surveyed beats Attested). Whether the AGENT does so is
 *      the recording's to show; the corpus only guarantees the overlap exists.
 *   5. **A document in the argument.** `DOCUMENTS` puts the NovaMart handbook
 *      in the Knowledge Base, and its returns page — the Terms page the
 *      all-hands names — still says 30 days. The return-window disagreement
 *      therefore has three sources across two stores, and the document is the
 *      oldest voice in it.
 *   6. **Facts old enough to say so.** Two `#engineering` episodes are dated
 *      into the `aging` and `stale` decay bands relative to
 *      {@link CORPUS_REFERENCE_DATE}, so a reader sees the system report an
 *      age rather than present every claim as equally current.
 *
 * ## Why the text reads the way it does
 *
 * The extractor is a real model call at temperature 0, not a fixture, so the
 * corpus states its claims plainly and names its subject each time ("NovaMart's
 * return window is…", not "it's 30 days"). That is a concession to extraction
 * reliability, not an attempt to script the extractor: `EXPECTED_CLAIMS` below
 * is what the seed REPORTS against, never what it writes. A claim the model
 * fails to find is reported missing, not inserted.
 */

// ---------------------------------------------------------------------------
// Identity — every id carries the `NMD` marker
// ---------------------------------------------------------------------------

/**
 * The marker every synthetic vendor id carries. Grep-able, and the seed's own
 * guard: an episode whose ids do not carry it is not this corpus's to approve.
 */
export const DEMO_ID_MARKER = "NMD" as const;

/** A fictional NovaMart employee. */
export interface DemoPerson {
  /** Synthetic Slack-shaped user id (`U` + marker + ordinal). */
  readonly slackId: string;
  /** Synthetic Zoom participant id. */
  readonly zoomId: string;
  /** Synthetic mailbox (the Graph "user object id" position). */
  readonly mailboxId: string;
  readonly displayName: string;
  readonly realName: string;
  readonly email: string;
  readonly title: string;
}

export const PEOPLE = Object.freeze({
  priya: {
    slackId: "UNMD0001",
    zoomId: "znmd-0001",
    mailboxId: "mnmd-0001",
    displayName: "priya",
    realName: "Priya Natarajan",
    email: "priya.natarajan@novamart.example",
    title: "Head of Finance",
  },
  marcus: {
    slackId: "UNMD0002",
    zoomId: "znmd-0002",
    mailboxId: "mnmd-0002",
    displayName: "marcus",
    realName: "Marcus Adeyemi",
    email: "marcus.adeyemi@novamart.example",
    title: "Support Lead",
  },
  dana: {
    slackId: "UNMD0003",
    zoomId: "znmd-0003",
    mailboxId: "mnmd-0003",
    displayName: "dana",
    realName: "Dana Okafor",
    email: "dana.okafor@novamart.example",
    title: "Data Engineering Lead",
  },
  sam: {
    slackId: "UNMD0004",
    zoomId: "znmd-0004",
    mailboxId: "mnmd-0004",
    displayName: "sam",
    realName: "Sam Whitfield",
    email: "sam.whitfield@novamart.example",
    title: "VP Engineering",
  },
  elena: {
    slackId: "UNMD0005",
    zoomId: "znmd-0005",
    mailboxId: "mnmd-0005",
    displayName: "elena",
    realName: "Elena Ruiz",
    email: "elena.ruiz@novamart.example",
    title: "COO",
  },
} as const satisfies Record<string, DemoPerson>);

export type DemoPersonKey = keyof typeof PEOPLE;

/**
 * The date the corpus was written to be read from — the anchor its decay bands
 * were chosen against, and what tests read those bands at rather than
 * wall-clock now. The header explains why the dates are absolute; the
 * consequence here is that the bands migrate as real time passes, which the
 * approve phase reports so an operator sees the drift.
 */
export const CORPUS_REFERENCE_DATE = "2026-09-04T00:00:00.000Z" as const;

/**
 * The person whose name a seeded fact carries as its APPROVER.
 *
 * Distinct from the operator who runs the seed, and deliberately not an author
 * of either return-window claim: a reviewer who is also the claimant answers
 * "who stood behind this" with the same name twice, which is the shape the
 * approval column exists to avoid.
 *
 * ⚠️ This names a PERSON in the fiction, not an account. The seed does not
 * create the Atlas user it maps to — see `seed.ts`, which takes that id as
 * `--reviewed-by` and refuses to invent one, on the same rule that keeps this
 * seed out of Better Auth's tables.
 *
 * ⚠️ Whoever this names must not AUTHOR a claim-bearing episode. Dana speaks
 * twice in the corpus and both are acknowledgements that assert nothing; the
 * two dated episodes are authored by Sam for exactly this reason, though the
 * retention one would read as naturally from the data lead. The end-to-end
 * check is in `demo-corpus-pg.test.ts`, over published facts rather than over
 * this list, because whether an episode yields a claim is the extractor's
 * answer and not one this file can assert.
 */
export const CORPUS_REVIEWER: DemoPersonKey = "dana";

// ---------------------------------------------------------------------------
// Channels — the chat class's survey units
// ---------------------------------------------------------------------------

export interface DemoChannel {
  /** Synthetic Slack-shaped channel id (`C` + marker + suffix). */
  readonly id: string;
  /** The `#name`, without the hash. */
  readonly name: string;
  readonly isPrivate: boolean;
}

/**
 * Five channels. Four carry episodes; `#warehouse-ops` deliberately carries
 * none — it is the unsurveyed department, and the seed puts it in the roster
 * with no evidence so the coverage page can say so.
 */
export const CHANNELS = Object.freeze({
  finance: { id: "CNMDFIN", name: "finance", isPrivate: false },
  support: { id: "CNMDSUP", name: "support", isPrivate: false },
  engineering: { id: "CNMDENG", name: "engineering", isPrivate: false },
  warehouseOps: { id: "CNMDWHS", name: "warehouse-ops", isPrivate: false },
  leadership: { id: "CNMDLEAD", name: "leadership", isPrivate: true },
} as const satisfies Record<string, DemoChannel>);

export type DemoChannelKey = keyof typeof CHANNELS;

/** The channel the demo shows as unsurveyed. Pinned so a test can name it. */
export const UNSURVEYED_CHANNEL: DemoChannelKey = "warehouseOps";

// ---------------------------------------------------------------------------
// Episodes
// ---------------------------------------------------------------------------

/** One Slack message. `ts` is Slack-shaped (`seconds.micros`) and unique per channel. */
export interface DemoChatMessage {
  readonly kind: "chat";
  readonly channel: DemoChannelKey;
  readonly author: DemoPersonKey;
  /** Slack-shaped message timestamp; doubles as the second half of `source_id`. */
  readonly ts: string;
  readonly occurredAt: string;
  readonly body: string;
}

/** One recorded meeting's transcript. */
export interface DemoTranscript {
  readonly kind: "transcript";
  /** Synthetic meeting instance id. */
  readonly meetingId: string;
  readonly title: string;
  readonly host: DemoPersonKey;
  readonly occurredAt: string;
  readonly body: string;
}

/** One mail message, as read from the sender's mailbox. */
export interface DemoMail {
  readonly kind: "email";
  /** Synthetic RFC 5322 Message-ID, already normalised (no angle brackets). */
  readonly messageId: string;
  readonly from: DemoPersonKey;
  readonly subject: string;
  readonly occurredAt: string;
  readonly body: string;
}

export type DemoEpisode = DemoChatMessage | DemoTranscript | DemoMail;

const chat = (
  channel: DemoChannelKey,
  author: DemoPersonKey,
  ts: string,
  occurredAt: string,
  body: string,
): DemoChatMessage => ({ kind: "chat", channel, author, ts, occurredAt, body });

/**
 * The corpus, in the order it happened. Thirteen episodes: eleven chat
 * messages across four channels, one all-hands transcript, one company-wide
 * mail. `#warehouse-ops` appears nowhere below — that absence is the point.
 */
export const EPISODES: readonly DemoEpisode[] = Object.freeze([
  // ── #finance ─────────────────────────────────────────────────────────────
  chat(
    "finance",
    "priya",
    "1752494400.000100",
    "2026-07-14T12:00:00.000Z",
    "Reminder for anyone fielding customer questions: NovaMart's return window is 30 days from delivery, for every category. That has been the policy since the 2025 relaunch and it is what the Terms page says.",
  ),
  chat(
    "finance",
    "elena",
    "1752494700.000200",
    "2026-07-14T12:05:00.000Z",
    "Thanks Priya. Pinning this.",
  ),
  chat(
    "finance",
    "priya",
    "1754308800.000300",
    "2026-08-04T12:00:00.000Z",
    "Quick sanity check before the board deck goes out: NovaMart's GMV for December 2024 was about $1.9M by my count — I want to quote it as the holiday baseline. Dana, shout if the warehouse says otherwise; I am going from memory.",
  ),
  chat(
    "finance",
    "dana",
    "1754310600.000400",
    "2026-08-04T12:30:00.000Z",
    "Will pull the number from the orders table rather than guess. Do not put $1.9M in the deck until I have.",
  ),

  // ── #support ─────────────────────────────────────────────────────────────
  chat(
    "support",
    "marcus",
    "1754121600.000100",
    "2026-08-02T08:00:00.000Z",
    "Updated macro is live. When a customer asks about returns: NovaMart's return window is 14 days from delivery. Please stop quoting 30 — that is the old page and it keeps generating escalations.",
  ),
  chat(
    "support",
    "marcus",
    "1754125200.000200",
    "2026-08-02T09:00:00.000Z",
    "Also: refunds go back to the original payment method within 5 business days of the item arriving at the warehouse. That part has not changed.",
  ),

  // ── #engineering ─────────────────────────────────────────────────────────
  chat(
    "engineering",
    "sam",
    "1753776000.000100",
    "2026-07-29T08:00:00.000Z",
    "Decision from this morning's platform sync: the nightly ETL moves to 02:00 UTC starting 1 August. The 23:00 slot was colliding with the EU order batch. Dana Okafor owns the nightly ETL going forward, including the on-call rota for it.",
  ),
  chat(
    "engineering",
    "dana",
    "1753779600.000200",
    "2026-07-29T09:00:00.000Z",
    "Ack. Runbook updated; the new schedule is in the scheduler config and I have moved the alert threshold to 03:30 UTC so a slow run does not page anyone at 2am for nothing.",
  ),
  chat(
    "engineering",
    "sam",
    "1755000000.000300",
    "2026-08-12T12:00:00.000Z",
    "FYI the analytics warehouse is Postgres 16 and will stay on Postgres through at least the end of 2026. We are not migrating to a managed warehouse this year; the numbers do not justify it.",
  ),
  // The two episodes below are dated to land in the `aging` and `stale` decay
  // bands (see CORPUS_REFERENCE_DATE). Both state a claim an agent would
  // otherwise repeat with a straight face, which is what makes an age worth
  // showing; neither touches the return-window slot.
  chat(
    "engineering",
    "sam",
    "1737374400.000400",
    "2026-01-20T12:00:00.000Z",
    "For the record now that the migration is done: NovaMart's primary payment processor is Stripe. We moved off Braintree during the 2025 relaunch and the old credentials are revoked.",
  ),
  chat(
    "engineering",
    "sam",
    "1750852800.000500",
    "2026-06-25T12:00:00.000Z",
    "Retention change is live: NovaMart's raw event logs are kept for 90 days, down from 400. Aggregates are unaffected and keep their full history.",
  ),

  // ── #leadership (private) ────────────────────────────────────────────────
  chat(
    "leadership",
    "elena",
    "1755518400.000100",
    "2026-08-18T12:00:00.000Z",
    "Leadership only for now: NovaMart's free-shipping threshold moves from $50 to $75 for Q4 2026. Finance has modelled it; we announce in the September newsletter. Please do not share outside this channel until then.",
  ),
  chat(
    "leadership",
    "priya",
    "1755520200.000200",
    "2026-08-18T12:30:00.000Z",
    "Model is in the shared drive. Net effect is roughly +2.1 points of contribution margin on orders under $75, assuming a 6% drop in those orders.",
  ),

  // ── All-hands recording ──────────────────────────────────────────────────
  {
    kind: "transcript",
    // base64 of "NMD-allhands-20260805" — Zoom meeting uuids are base64 and the
    // real source-id builder refuses anything else; the marker survives decoding.
    meetingId: "Tk1ELWFsbGhhbmRzLTIwMjYwODA1",
    title: "NovaMart All-Hands — 5 August 2026",
    host: "elena",
    occurredAt: "2026-08-05T15:00:00.000Z",
    body: [
      "Elena Ruiz: Welcome everyone. Three things today: hiring, the returns question, and the holiday plan.",
      "Elena Ruiz: On hiring — NovaMart's support team grows by two people in Q4 2026. Marcus has the reqs open now.",
      "Marcus Adeyemi: Thanks Elena. Both roles are tier-one support, remote, and we want them in seat before Black Friday.",
      "Elena Ruiz: On returns. There is a live disagreement between the Terms page and the support macro about whether the return window is 30 days or 14. Priya and Marcus, I want you two to take that offline and come back with one number and one page. Until then, do not change anything customer-facing.",
      "Priya Natarajan: Understood. We will bring a recommendation to the next ops review.",
      "Marcus Adeyemi: Agreed.",
      "Elena Ruiz: Last thing — the holiday shipping cutoffs. Priya is sending those to everyone by email this month so nobody has to ask.",
      "Elena Ruiz: That is all. Thank you.",
    ].join("\n"),
  },

  // ── Company-wide mail ────────────────────────────────────────────────────
  {
    kind: "email",
    messageId: "nmd-holiday-cutoffs-2026@novamart.example",
    from: "priya",
    subject: "Holiday 2026 shipping cutoffs — please read",
    occurredAt: "2026-08-20T09:00:00.000Z",
    body: [
      "All,",
      "",
      "The holiday shipping cutoffs for 2026 are confirmed with our carriers:",
      "",
      "- NovaMart's holiday cutoff for standard shipping is 18 December 2026.",
      "- NovaMart's holiday cutoff for express shipping is 21 December 2026.",
      "",
      "Orders placed after those dates are not guaranteed to arrive before 25 December. Support has the customer-facing wording; please point people at the help centre rather than paraphrasing.",
      "",
      "Priya Natarajan",
      "Head of Finance, NovaMart",
    ].join("\n"),
  },
]);

// ---------------------------------------------------------------------------
// Documents — the Knowledge Base class
// ---------------------------------------------------------------------------

/**
 * The collection every corpus document is ingested into (an `okf-upload`
 * install, so the slug is the `workspace_plugins.install_id`).
 */
export const DEMO_COLLECTION_SLUG = "novamart-handbook" as const;

/**
 * One hosted knowledge document. Rendered to OKF at seed time by
 * `renderOkfDocument` rather than written as raw frontmatter here, so the wire
 * format stays single-homed in `@atlas/okf-bundle` and this file stays prose.
 */
export interface DemoDocument {
  /** Path inside the collection; the document's stable identity across re-seeds. */
  readonly path: string;
  readonly title: string;
  readonly description: string;
  readonly tags: readonly string[];
  /** ISO date the page itself claims it was last reviewed. */
  readonly timestamp: string;
  readonly body: string;
}

/**
 * Three pages of the NovaMart handbook.
 *
 * `returns-and-refunds` is the Terms page the all-hands transcript names, and
 * it still says 30 days. That is the point of including it: the return-window
 * disagreement has three sources, not two — a document, a finance message and
 * a support message — and a reader can see that the document is the stalest
 * voice in the argument while still being the one a customer would be shown.
 *
 * These are third-party descriptive content in the tool's sense — never
 * instructions — and, like every episode above, they are extraction INPUT and
 * never a training example (ADR-0044; the header states this for the corpus as
 * a whole and it holds here without exception).
 */
export const DOCUMENTS: readonly DemoDocument[] = Object.freeze([
  {
    path: "policies/returns-and-refunds.md",
    title: "Returns and Refunds",
    description: "The customer-facing returns policy, as published on the Terms page.",
    tags: ["policy", "returns", "customer-facing"],
    timestamp: "2025-11-03",
    body: [
      "## Return window",
      "",
      "NovaMart's return window is 30 days from delivery, for every category. This is the wording published on the Terms page and it is what customer-facing copy should match.",
      "",
      "## Refunds",
      "",
      "Refunds are returned to the original payment method within 5 business days of the item arriving at the warehouse.",
      "",
      "## Exceptions",
      "",
      "Final-sale items and gift cards are not returnable. Items damaged in transit are replaced rather than refunded, and do not count against the return window.",
    ].join("\n"),
  },
  {
    path: "runbooks/support-escalation.md",
    title: "Support Escalation Runbook",
    description: "When a tier-one agent escalates, and to whom.",
    tags: ["runbook", "support"],
    timestamp: "2026-02-17",
    body: [
      "## When to escalate",
      "",
      "Escalate to the Support Lead when a customer disputes a policy rather than a transaction, when a refund exceeds $500, or when the same order has been contacted about three times.",
      "",
      "## Who owns what",
      "",
      "The Support Lead owns the macro library and is the only person who edits a customer-facing macro. Policy wording itself is owned by Finance.",
      "",
      "## Response targets",
      "",
      "First response within 4 business hours. Resolution or a named owner within 2 business days.",
    ].join("\n"),
  },
  {
    path: "runbooks/analytics-access.md",
    title: "Getting Access to the Analytics Warehouse",
    description: "How an engineer or analyst gets read access, and what the warehouse is.",
    tags: ["runbook", "engineering", "data"],
    timestamp: "2026-05-12",
    body: [
      "## What the warehouse is",
      "",
      "The NovaMart analytics warehouse is Postgres 16. Access is read-only for everyone outside the data team.",
      "",
      "## Requesting access",
      "",
      "Ask in #engineering and tag the Data Engineering Lead, who owns the nightly ETL and the access rota. Access is granted per-schema, never per-table.",
      "",
      "## What not to do",
      "",
      "Do not query the warehouse from a customer-facing path, and do not copy rows into a spreadsheet that leaves the company drive.",
    ].join("\n"),
  },
]);

// ---------------------------------------------------------------------------
// What the seed reports against
// ---------------------------------------------------------------------------

/**
 * A claim the corpus was written to yield. Matched loosely against extracted
 * drafts (case-folded substring on subject AND predicate, any of `objectHints`
 * on the object), because the extractor's surface wording is its own.
 *
 * This is a REPORTING contract, not a writing one: the seed never inserts a
 * claim from this list. A row here that no draft matches is printed as
 * `missing`, and the corpus or the extractor is what gets fixed.
 */
export interface ExpectedClaim {
  readonly key: string;
  readonly subjectHint: string;
  readonly predicateHint: string;
  readonly objectHints: readonly string[];
}

/**
 * The two contradiction claims share a subject and predicate ON PURPOSE:
 * that is what puts them in one slot so `single` cardinality mints the edge.
 */
export const CONTRADICTION_PREDICATE_SURFACE = "return window" as const;

/**
 * The two expected claims that ARE the contradiction. The seed's approve phase
 * reads the `predicate_key` off the published rows these match and declares
 * that key `single` (#5620), because the extractor's phrasing — not the
 * literal surface above — is what the rows carry and what the sweep and the
 * write-time anchor gate look up.
 */
export const CONTRADICTION_CLAIMS: readonly [ExpectedClaim, ExpectedClaim] = Object.freeze([
  {
    key: "return-window-30",
    subjectHint: "novamart",
    predicateHint: CONTRADICTION_PREDICATE_SURFACE,
    objectHints: ["30 day"],
  },
  {
    key: "return-window-14",
    subjectHint: "novamart",
    predicateHint: CONTRADICTION_PREDICATE_SURFACE,
    objectHints: ["14 day"],
  },
] as const);

export const EXPECTED_CLAIMS: readonly ExpectedClaim[] = Object.freeze([
  ...CONTRADICTION_CLAIMS,
  {
    key: "gmv-december-2024",
    subjectHint: "novamart",
    predicateHint: "gmv",
    objectHints: ["1.9"],
  },
  {
    key: "etl-schedule",
    subjectHint: "etl",
    predicateHint: "",
    objectHints: ["02:00", "2:00", "2am"],
  },
  {
    // The live extractor phrases ownership from the OWNER's side ("Dana Okafor
    // owns nightly ETL"), the fixture from the ETL's; the hints admit both.
    key: "etl-owner",
    subjectHint: "",
    predicateHint: "own",
    objectHints: ["dana", "nightly etl"],
  },
  {
    key: "support-headcount-q4",
    subjectHint: "support",
    predicateHint: "",
    objectHints: ["two", "2"],
  },
  {
    key: "holiday-cutoff-standard",
    subjectHint: "",
    predicateHint: "standard",
    objectHints: ["18 december", "december 18", "2026-12-18"],
  },
  {
    key: "holiday-cutoff-express",
    subjectHint: "",
    predicateHint: "express",
    objectHints: ["21 december", "december 21", "2026-12-21"],
  },
  {
    key: "free-shipping-threshold-q4",
    subjectHint: "",
    predicateHint: "free",
    objectHints: ["75"],
  },
  {
    key: "payment-processor",
    subjectHint: "novamart",
    predicateHint: "processor",
    objectHints: ["stripe"],
  },
  {
    // The live extractor keeps the episode's own verb ("raw event logs are
    // kept for 90 days"); "retention" is the message's framing word, not its
    // predicate. The subject is the stable part, so the hint keys on it.
    key: "event-log-retention",
    subjectHint: "event log",
    predicateHint: "",
    objectHints: ["90 day", "90"],
  },
]);

/**
 * Loose match of one extracted draft against one expected claim.
 * Exported so the seed and its test agree on what "found" means.
 */
export function matchesExpectedClaim(
  draft: { readonly subject: string; readonly predicate: string; readonly object: string },
  expected: ExpectedClaim,
): boolean {
  const s = draft.subject.toLowerCase();
  const p = draft.predicate.toLowerCase();
  const o = draft.object.toLowerCase();
  if (expected.subjectHint !== "" && !s.includes(expected.subjectHint)) return false;
  if (expected.predicateHint !== "" && !p.includes(expected.predicateHint)) return false;
  return expected.objectHints.some((hint) => o.includes(hint));
}
