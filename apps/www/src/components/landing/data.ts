/**
 * Shared copy and sample data for the landing page.
 *
 * Hoisted here so every surface that quotes the sentence, the demo command or
 * the NovaMart exchange reads from one source. The sentence is decided in
 * docs/prd/launch-cycle.md and renders verbatim; the exchange mirrors the
 * seeded demo corpus (packages/api/src/lib/brain/demo-corpus/corpus.ts), so
 * what the page shows is what the hosted demo answers.
 */

/** The launch cycle's sentence, verbatim (docs/prd/launch-cycle.md). */
export const SENTENCE =
  "Atlas is the company facts your AI agents can trust: every one carries its source, its date, and the name of the person who approved it. Open source, runs in your VPC.";

/** The one command every launch surface prints — no account, no email. */
export const MCP_DEMO_COMMAND = "bunx @useatlas/mcp init --hosted --demo --write";

/** The demo's one question. */
export const DEMO_QUESTION = "What is NovaMart's return window?";

/**
 * The demo exchange as the hosted NovaMart corpus answers it: the attested
 * claim with its speaker, channel and date, and the contradiction Atlas shows
 * beside it without picking a side. Dates and names are the corpus's own.
 */
export const DEMO_EXCHANGE = {
  attested: {
    claim: "30 days from delivery, for every category.",
    speaker: "Priya Natarajan",
    role: "Head of Finance",
    channel: "#finance",
    date: "14 Jul 2026",
  },
  contradiction: {
    claim: "14 days from delivery. Please stop quoting 30.",
    speaker: "Marcus Adeyemi",
    role: "Support",
    channel: "#support",
    date: "2 Aug 2026",
  },
} as const;

/**
 * The three kinds of thing that live in the Atlas, in the PRD's language
 * (docs/prd/company-atlas.md § What a person can trust). Every answer says
 * which one it is drawing on.
 */
export type TrustTier = {
  readonly name: string;
  readonly what: string;
  readonly why: string;
};

export const TRUST_TIERS: ReadonlyArray<TrustTier> = [
  {
    name: "Surveyed",
    what: "Drawn directly from the company's own data.",
    why: "True by construction — the answer re-reads the live rows. Nobody interpreted anything, so nothing can have been interpreted wrong, and it cannot go stale between readings.",
  },
  {
    name: "Attested",
    what: "Extracted from something someone wrote, then approved.",
    why: "A named person in your company read this claim and stood behind it. That person is on the record.",
  },
  {
    name: "On the record",
    what: "The raw source material itself.",
    why: "It is not a claim about what is true — it is what was actually said, unedited. Trustworthy as testimony, not as fact.",
  },
];

export type CategoryRow = {
  readonly category: string;
  readonly gmv: string;
  readonly orders: string;
};

/** Sample rows for the Surveyed pane in how-it-works. */
export const CATEGORY_ROWS: ReadonlyArray<CategoryRow> = [
  { category: "Bedding",     gmv: "$184,219", orders: "2,041" },
  { category: "Kitchen",     gmv: "$142,718", orders: "1,587" },
  { category: "Bath",        gmv: "$98,402",  orders: "1,103" },
  { category: "Outdoor",     gmv: "$71,288",  orders: "812"   },
  { category: "Accessories", gmv: "$54,011",  orders: "693"   },
];

/** The canonical analyst question, for the Surveyed pane. */
export const TOP_CATEGORY_QUESTION =
  "What's our top-performing category by GMV this month?";
