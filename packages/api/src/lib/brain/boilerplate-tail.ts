/**
 * How much of a mail body is a REPEATED TAIL — the measurement #5420 gates on.
 *
 * ## What this is for, and what it is emphatically not
 *
 * #5354 stripped quoted history and `--`-delimited signatures. It left one half
 * of its own criteria undone: an undelimited legal disclaimer survives into the
 * extractor's view, and `quoted-reply.ts` pins that as an expected-failure test
 * rather than fixing it. #5420 tracks the gap, and its FIRST criterion gates
 * every other one:
 *
 *   > The token share of disclaimer text in real extracted mail is MEASURED and
 *   > recorded, not estimated. If it is negligible, close as WONTFIX.
 *
 * This module is the instrument for that number and nothing else. It does not
 * strip, it is not wired into `strippedForExtraction`, and it must not become
 * so on the strength of its own output — that is the choice #5420's second
 * criterion reserves for a human, because the three candidate fixes (leave it,
 * a Talon sidecar, an admin-declared footer) differ in cost and blast radius,
 * not in detection quality. Wiring this into the extract path would make the
 * measurement's author the judge of the measurement, which is the one
 * structural rule in `docs/agents/practices.md`.
 *
 * ## Why "repeated tail" and not "disclaimer"
 *
 * #5420 forbids the obvious approach outright, and it is right to:
 *
 *   > Hand-rolled divider regexes […] a disclaimer has no delimiter to anchor
 *   > on, so a regex here would be matching English legal boilerplate. That is
 *   > the worst version of this: it silently drops real content the day someone
 *   > writes a sentence containing "confidential".
 *
 * So this matches no English at all. It uses the structural property the issue
 * itself names when it argues the cost is linear: a disclaimer is **a fixed
 * per-message tail**. Fixed and per-message is a testable shape — the same
 * trailing lines, verbatim, at the end of many messages from the same sender —
 * and it is one that a genuine claim does not have. "The Q3 migration finished
 * Tuesday" is not the last three lines of forty different messages.
 *
 * The consequence worth stating plainly: this measures REPEATED TAILS, of which
 * legal disclaimers are the interesting subset. A per-sender mail-client footer
 * ("Sent from my iPhone") is also a repeated tail and is also counted. That is
 * the honest reading of the number — it is an upper bound on what a perfect
 * disclaimer stripper could recover, which is exactly the bound a
 * WONTFIX/proceed decision needs.
 *
 * ## The method
 *
 * Per group (a sender, or a sender's domain — the caller decides), every
 * message's lines are reversed and inserted into a trie. A node at depth `d`
 * carrying `count` messages IS a `d`-line tail shared verbatim by `count`
 * messages. Counts fall monotonically with depth, so each message's maximal
 * repeated tail is the deepest node on its own path still at or above
 * {@link BoilerplateTailOptions.minRepeats} — one walk, no scoring heuristic,
 * no threshold to tune beyond `minRepeats` itself.
 *
 * Two guards, both of which exist because their absence would inflate the
 * number in the direction that argues for doing work:
 *
 *   1. A tail that consumes the WHOLE message is not a tail — it is a duplicate
 *      message (an automated notification, a re-sent bounce). Those are counted
 *      under {@link BoilerplateTailReport.wholeMessageRepeats} and contribute
 *      ZERO boilerplate chars, because stripping there would leave nothing and
 *      the honest fix is deduplication, not footer removal. This is the same
 *      asymmetry `hasNovelText` draws in `quoted-reply.ts`.
 *   2. Results are banded by tail line count. A share dominated by one-line
 *      tails is sign-offs, which the parser's signature handling already covers
 *      and which nobody filed an issue about; a share dominated by 4+ line
 *      tails is the legal boilerplate #5420 is actually about. One aggregate
 *      number that cannot tell those apart would be worse than no number.
 */

/** A mail body as the extractor would read it, with the group it belongs to. */
export interface TailSample {
  /**
   * The group whose messages are compared against each other — a sender
   * address or a sender domain. Tails are only ever matched WITHIN a group:
   * across an entire workspace, "Best regards" would repeat everywhere and the
   * number would measure politeness rather than boilerplate.
   */
  readonly group: string;
  /**
   * The text to measure — the post-strip, PRE-truncation extractor view (what
   * `strippedForExtraction` returns, before `extractionExcerpt` applies the
   * cap).
   *
   * ⚠️ The resulting share is therefore a share of STORED text, and on a
   * capped message it OVER-COUNTS: `extractionExcerpt` keeps a front slice, so
   * any tail lying beyond `MAX_BODY_CHARS` is never sent to the model and costs
   * nothing. Pre-truncation is still the right input — it keeps this module
   * free of the cap, and the per-message lengths in {@link SampleTail} let a
   * caller derive the cap-aware figure exactly — but a caller reporting a
   * single headline number should report the cap-aware one. See
   * `scripts/measure-disclaimer-share.ts`'s `CapInteraction`, which does, and
   * which carries the derivation.
   *
   * (An earlier version of this comment justified pre-truncation on the grounds
   * that measuring the truncated form "would hide the tails on exactly the
   * messages worst affected: the ones already at the cap". That was backwards —
   * on those messages the trailing tail is the part that is already free.)
   */
  readonly text: string;
}

export interface BoilerplateTailOptions {
  /**
   * How many distinct messages in a group must share a tail before it counts.
   *
   * Three, by default, and the default is doing real work: at two, any pair of
   * messages that happen to end on the same sentence forms a "tail", and the
   * number stops being about boilerplate. Raising it is the conservative
   * direction — the measured share falls — so a caller unsure of its data
   * should raise rather than lower it, and {@link BoilerplateTailReport} echoes
   * the value so a recorded number can never be read without it.
   */
  readonly minRepeats?: number;
}

/** Messages whose maximal repeated tail was this many lines. */
export interface TailBand {
  /** Inclusive lower bound on tail lines; the top band has no upper bound. */
  readonly minLines: number;
  /** Inclusive upper bound, or `null` for the open-ended top band. */
  readonly maxLines: number | null;
  /** Messages falling in this band. */
  readonly messages: number;
  /** Characters those messages' tails account for. */
  readonly chars: number;
}

export interface BoilerplateTailReport {
  /** Echoed so a recorded number cannot be read without its threshold. */
  readonly minRepeats: number;
  readonly messages: number;
  readonly groups: number;
  /** Total characters across every sample's text. The denominator. */
  readonly totalChars: number;
  /** Characters attributed to repeated tails. The numerator. */
  readonly tailChars: number;
  /** `tailChars / totalChars`, or 0 when there is nothing to measure. */
  readonly share: number;
  /** Messages carrying a repeated tail at all. */
  readonly messagesWithTail: number;
  /**
   * Messages whose repeated tail would have consumed the entire message, and
   * which therefore contribute nothing — see guard 1 in the module header.
   */
  readonly wholeMessageRepeats: number;
  /** The share broken out by tail size, so sign-offs cannot pass as legal text. */
  readonly bands: readonly TailBand[];
}

/** Band edges, in tail lines. Chosen to separate sign-offs from legal blocks. */
const BAND_EDGES: readonly (readonly [number, number | null])[] = [
  [1, 1],
  [2, 3],
  [4, 8],
  [9, null],
];

/**
 * Lines, normalised for comparison.
 *
 * CRLF is folded and trailing whitespace is dropped per line, because a mail
 * client that pads its own footer differently between two sends would otherwise
 * defeat the match and under-report. Trailing blank lines go too: they are not
 * part of a tail and their presence or absence would split one footer into two
 * trie paths.
 *
 * Interior content is NOT touched — no case folding, no punctuation stripping.
 * Every normalisation here is one a mail transport can perform on its own; a
 * normalisation the transport cannot perform would be this module quietly
 * deciding two different texts are the same.
 */
function normalisedLines(text: string): string[] {
  const lines = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd());
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end -= 1;
  return lines.slice(0, end);
}

/** A line's cost in the body, including the newline that follows it. */
function lineChars(line: string): number {
  return line.length + 1;
}

/**
 * The threshold, resolved once so the two entry points cannot disagree.
 *
 * Two is the floor the method itself imposes — a "tail" shared by one message
 * is that message. Clamping rather than throwing keeps a misconfigured operator
 * flag from ending a long read-only scan at the last step.
 *
 * `Number.isFinite` is not belt-and-braces. `Math.max(2, NaN)` is NaN, which
 * makes `next.count < minRepeats` false at EVERY depth, so every walk runs to
 * the message's full length and every message is classified as a whole-message
 * duplicate — `share: 0`, silently, with the echoed threshold serialising as
 * `null`. A recorded zero meaning "the argument was garbage" is
 * indistinguishable from one meaning "there is no boilerplate", and this issue
 * turns on precisely that distinction.
 *
 * Shared rather than inlined twice: {@link boilerplateTailOf} computes the tails
 * and {@link measureBoilerplateTails} echoes the threshold into the report, so
 * two copies would eventually report a number taken at a different threshold
 * than the one printed beside it.
 */
function resolveMinRepeats(options: BoilerplateTailOptions): number {
  const requested = options.minRepeats;
  return typeof requested === "number" && Number.isFinite(requested)
    ? Math.max(2, requested)
    : 3;
}

interface TrieNode {
  count: number;
  children: Map<string, TrieNode>;
}

function emptyNode(): TrieNode {
  return { count: 0, children: new Map() };
}

/**
 * The maximal repeated tail of each message in one group, in lines.
 *
 * Returned parallel to `messages`. Zero means "no tail repeated often enough",
 * and a value equal to the message's own line count means the whole message
 * repeated — the caller applies guard 1, not this function, so that the guard
 * is visible where the number is assembled.
 */
function tailLineCounts(messages: readonly (readonly string[])[], minRepeats: number): number[] {
  const root = emptyNode();
  for (const lines of messages) {
    let node = root;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const key = lines[i] as string;
      let next = node.children.get(key);
      if (next === undefined) {
        next = emptyNode();
        node.children.set(key, next);
      }
      next.count += 1;
      node = next;
    }
  }

  return messages.map((lines) => {
    let node = root;
    let depth = 0;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const next = node.children.get(lines[i] as string);
      // Counts fall monotonically with depth, so the first node below the
      // threshold ends the tail — there is nothing deeper that could qualify.
      if (next === undefined || next.count < minRepeats) break;
      node = next;
      depth += 1;
    }
    return depth;
  });
}

function bandFor(lines: number): number {
  for (let i = 0; i < BAND_EDGES.length; i += 1) {
    const [min, max] = BAND_EDGES[i] as readonly [number, number | null];
    if (lines >= min && (max === null || lines <= max)) return i;
  }
  return -1;
}

/** What one message contributed, positionally parallel to the input samples. */
export interface SampleTail {
  /** Lines of repeated tail attributed to this message; 0 when none counted. */
  readonly lines: number;
  /** Characters those lines cost, newlines included; 0 when none counted. */
  readonly chars: number;
  /**
   * The repeated tail would have consumed the whole message — guard 1. Reported
   * rather than silently folded into "no tail", because the two mean different
   * things and only one of them argues for a footer stripper.
   */
  readonly wholeMessage: boolean;
  /** The message's own size, the denominator's per-message contribution. */
  readonly totalChars: number;
}

/**
 * Per-message repeated tails.
 *
 * Exposed alongside {@link measureBoilerplateTails} because the aggregate share
 * cannot answer the second question #5420 raises — "it eats into
 * `MAX_BODY_CHARS` on exactly the messages already closest to the cap". That is
 * a per-message question (how many capped messages would fit if their tail
 * came off), and answering it from an average would be exactly the estimate the
 * issue's first criterion rules out.
 *
 * Returns lengths and counts only. No caller can recover message text from
 * this, which is what lets the operator script report on tenant mail without
 * becoming an export path — see `scripts/measure-disclaimer-share.ts`.
 */
export function boilerplateTailOf(
  samples: readonly TailSample[],
  options: BoilerplateTailOptions = {},
): readonly SampleTail[] {
  const minRepeats = resolveMinRepeats(options);

  // Group, remembering each sample's original index so the result can be
  // returned in input order — the script joins it back against episode ids.
  const byGroup = new Map<string, { index: number; lines: string[] }[]>();
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i] as TailSample;
    const entry = { index: i, lines: normalisedLines(sample.text) };
    const existing = byGroup.get(sample.group);
    if (existing === undefined) byGroup.set(sample.group, [entry]);
    else existing.push(entry);
  }

  const out = new Array<SampleTail>(samples.length);
  for (const entries of byGroup.values()) {
    const tails = tailLineCounts(
      entries.map((e) => e.lines),
      minRepeats,
    );
    for (let m = 0; m < entries.length; m += 1) {
      const { index, lines } = entries[m] as { index: number; lines: string[] };
      const totalChars = lines.reduce((sum, line) => sum + lineChars(line), 0);
      const tail = tails[m] as number;

      if (tail === 0) {
        out[index] = { lines: 0, chars: 0, wholeMessage: false, totalChars };
        continue;
      }
      if (tail >= lines.length) {
        // Guard 1: the whole message repeated. Not a tail — a duplicate.
        out[index] = { lines: 0, chars: 0, wholeMessage: true, totalChars };
        continue;
      }
      const chars = lines
        .slice(lines.length - tail)
        .reduce((sum, line) => sum + lineChars(line), 0);
      out[index] = { lines: tail, chars, wholeMessage: false, totalChars };
    }
  }
  return out;
}

/**
 * Measure the repeated-tail share of a set of mail bodies.
 *
 * Pure and synchronous: it holds no database handle and reads no environment,
 * so the number it produces is reproducible from the same input by anyone,
 * which is what "measured and recorded, not estimated" asks of the instrument
 * as much as of the reading.
 */
export function measureBoilerplateTails(
  samples: readonly TailSample[],
  options: BoilerplateTailOptions = {},
): BoilerplateTailReport {
  const minRepeats = resolveMinRepeats(options);
  const tails = boilerplateTailOf(samples, options);

  let totalChars = 0;
  let tailChars = 0;
  let messagesWithTail = 0;
  let wholeMessageRepeats = 0;
  const bands = BAND_EDGES.map(([minLines, maxLines]) => ({
    minLines,
    maxLines,
    messages: 0,
    chars: 0,
  }));

  for (const tail of tails) {
    totalChars += tail.totalChars;
    if (tail.wholeMessage) {
      wholeMessageRepeats += 1;
      continue;
    }
    if (tail.lines === 0) continue;

    messagesWithTail += 1;
    tailChars += tail.chars;
    const band = bands[bandFor(tail.lines)];
    if (band !== undefined) {
      band.messages += 1;
      band.chars += tail.chars;
    }
  }

  const groups = new Set(samples.map((s) => s.group)).size;
  return {
    minRepeats,
    messages: samples.length,
    groups,
    totalChars,
    tailChars,
    share: totalChars === 0 ? 0 : tailChars / totalChars,
    messagesWithTail,
    wholeMessageRepeats,
    bands,
  };
}
