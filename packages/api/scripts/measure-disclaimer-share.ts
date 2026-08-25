/**
 * #5420 criterion 1 — what share of extracted mail is a repeated tail?
 *
 * #5354 stripped quoted history and delimited signatures. It left an
 * undelimited legal disclaimer surviving into the extractor's view, pinned as
 * an expected-failure test in `lib/brain/__tests__/quoted-reply.test.ts`. #5420
 * tracks that gap, and its first criterion gates every other one:
 *
 *   > The token share of disclaimer text in real extracted mail is MEASURED and
 *   > recorded, not estimated. This gates everything below — if it is
 *   > negligible, close as WONTFIX and say so in `quoted-reply.ts`.
 *
 * This script is that measurement. It chooses nothing and changes nothing: the
 * choice between the issue's three options (leave it, a Talon sidecar, an
 * admin-declared footer) is reserved for a human reading this output, because
 * they differ in cost and blast radius rather than in detection quality.
 *
 * The detector is `lib/brain/boilerplate-tail.ts`, which matches no English —
 * #5420 rules out hand-rolled boilerplate regexes outright, so this keys on the
 * structural property the issue names instead: a disclaimer is a FIXED
 * PER-MESSAGE TAIL, the same trailing lines repeated verbatim across many
 * messages from one sender. Read the result as an UPPER BOUND on what a perfect
 * disclaimer stripper could recover: mail-client footers repeat the same way
 * and are counted the same way.
 *
 * ## Which number to read — and a correction to the issue
 *
 * TWO shares are printed and they answer different questions:
 *
 *   `report.share`             boilerplate as a fraction of STORED text.
 *   `capInteraction.sentShare` boilerplate as a fraction of what the model
 *                              actually READS. **This is the one #5420 asks
 *                              for.**
 *
 * They differ because `extractionExcerpt` caps at a FRONT slice: tail lying
 * beyond `MAX_BODY_CHARS` was never sent and is therefore already free, so
 * `report.share` over-counts on capped messages.
 *
 * ⚠️ The same fact corrects the issue's second claim. #5420 says the disclaimer
 * *"eats into `MAX_BODY_CHARS` on exactly the messages already closest to the
 * cap"*, which reads as though a footer pushes real content off the end. It
 * cannot: the cap cuts from the FRONT and the tail is at the BACK, so real
 * content delivered is `min(cap, L - T)` both before and after a strip —
 * identical. **A trailing tail costs tokens only, never a claim.** See
 * {@link CapInteraction} for the derivation. That removes the strongest
 * argument in the issue for doing this work, which is exactly why it is stated
 * up front rather than left in a field nobody reads.
 *
 * ## Two input lanes, because the obvious one is empty
 *
 *   --corpus <dir>      RFC822 files on this machine. ADR-0044 settles what may
 *                       go here: "Enron as a local development fixture — yes.
 *                       Enron as extractor training data — no. And under no
 *                       circumstances committed to this repository." Nothing
 *                       read here is written anywhere; only aggregates are
 *                       printed. This is the lane that can produce a number
 *                       TODAY — no workspace in this repo has mail in it.
 *
 *   --workspace <id>    `brain_episodes` for one workspace via `DATABASE_URL`.
 *                       The number #5420 actually wants, once a workspace has
 *                       ingested mail.
 *
 * ## Why this is not an export
 *
 * #5335 requires that anything lifting tenant content out of a region be an
 * explicit, audited operator act. This is deliberately built so as not to be
 * one: it emits COUNTS AND LENGTHS ONLY — never a line of message text, never a
 * sender address, never an episode id. `boilerplateTailOf` returns lengths by
 * construction, so there is no code path here that could print a body. That is
 * the same posture `audit-plugin-config-residue.ts` takes (row ids, never
 * values), and it is what makes a read-only run against a production replica
 * defensible.
 *
 * ## Usage
 *
 *   bun run packages/api/scripts/measure-disclaimer-share.ts --corpus ~/enron/maildir
 *   DATABASE_URL=… bun run packages/api/scripts/measure-disclaimer-share.ts --workspace ws_123
 *
 *   --min-repeats N   messages that must share a tail before it counts (default 3)
 *   --limit N         stop after N messages (default 20000)
 *
 * ⚠️ `--limit` IS NOT A SAMPLING STRATEGY, in either lane, and both lanes are
 * biased in a way that inflates the share:
 *
 *   corpus     truncates in DIRECTORY-WALK ORDER. On a per-sender maildir
 *              (Enron's is) a small limit can land entirely inside one or two
 *              senders — and a single sender's mail shares a footer far more
 *              often than a workspace's does.
 *   workspace  `ORDER BY ingested_at DESC` takes the most RECENT episodes,
 *              which can land inside one burst or one high-volume automated
 *              sender. This is the lane #5420 actually wants a number from, so
 *              the caveat matters more here, not less.
 *
 * A number quoted into #5420 should come from a run whose `messages` count is
 * the whole corpus or mailbox, or whose `groups` count is large enough to be
 * credible on its face.
 *
 * Exit codes:
 *   0 — measured. A single line of JSON on stdout.
 *   2 — NOTHING to measure: no readable messages in the corpus, or no mail
 *       episodes for that workspace. Distinct from 0 on purpose. "the share is
 *       zero" and "there was nothing to take a share of" are the two answers
 *       this issue is most likely to confuse, and they must not share an exit
 *       code or a JSON shape.
 *   1 — the script failed (bad flags, unreadable directory, DB error).
 */

// ⚠️ MUST STAY FIRST. Pins the app logger to fd 2 so this script's stdout is a
// clean machine channel; see that module's header for why there is no runtime
// substitute. Anything imported above it can construct the logger first.
import "./measure-log-destination";

import { readdir, readFile, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { createLogger } from "@atlas/api/lib/logger";
import { strippedForExtraction } from "@atlas/api/lib/brain/quoted-reply";
import { MAX_BODY_CHARS } from "@atlas/api/lib/brain/extract-contract";
import {
  EMAIL_CLASS,
  EPISODE_SOURCES,
  OUTLOOK_SOURCE,
  episodeSourceClassOf,
} from "@atlas/api/lib/brain/sources";
import {
  boilerplateTailOf,
  measureBoilerplateTails,
  type BoilerplateTailReport,
  type SampleTail,
  type TailSample,
} from "@atlas/api/lib/brain/boilerplate-tail";

const log = createLogger("measure-disclaimer-share");

/**
 * Every stored source in the email class, derived rather than spelled.
 *
 * `quoted-reply.ts` gates on CLASS and never on `=== "outlook"`, precisely so a
 * second mail vendor inherits the strip with no code change. A measurement that
 * hard-coded `outlook` would silently stop covering the thing it measures on
 * the day that happens, and would report a smaller share while doing it.
 */
const EMAIL_SOURCES: readonly string[] = EPISODE_SOURCES.filter(
  (source) => episodeSourceClassOf(source) === EMAIL_CLASS,
);

const DEFAULT_LIMIT = 20_000;

interface Options {
  readonly corpus: string | null;
  readonly workspace: string | null;
  readonly minRepeats: number;
  readonly limit: number;
}

function parseArgs(argv: readonly string[]): Options {
  let corpus: string | null = null;
  let workspace: string | null = null;
  let minRepeats = 3;
  let limit = DEFAULT_LIMIT;

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    const requireValue = (): string => {
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${flag} requires a value`);
      }
      i += 1;
      return value;
    };
    const requireNumber = (): number => {
      const raw = requireValue();
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error(`${flag} expects a positive number, got ${JSON.stringify(raw)}`);
      }
      return Math.floor(parsed);
    };

    switch (flag) {
      case "--corpus":
        corpus = requireValue();
        break;
      case "--workspace":
        workspace = requireValue();
        break;
      case "--min-repeats":
        minRepeats = requireNumber();
        break;
      case "--limit":
        limit = requireNumber();
        break;
      default:
        throw new Error(`Unknown flag ${JSON.stringify(flag)}`);
    }
  }

  if ((corpus === null) === (workspace === null)) {
    throw new Error("Pass exactly one of --corpus <dir> or --workspace <id>");
  }
  return { corpus, workspace, minRepeats, limit };
}

// ---------------------------------------------------------------------------
// The grouping key
// ---------------------------------------------------------------------------

/**
 * The sender's domain, or the raw sender when it has none.
 *
 * DOMAIN rather than address, deliberately: a legal disclaimer is appended by
 * the org's mail gateway, so it repeats across every one of that org's senders
 * and would need `minRepeats` messages from each individual person to be seen
 * at address grain. Domain is also the grain at which the issue's option 3 (a
 * per-workspace configured footer) would operate, so the number this produces
 * is the number that option's payoff would be judged against.
 *
 * Lowercased, because a domain is case-insensitive and two casings of one
 * sender would split a group and under-report.
 */
export function groupOf(sender: string | null): string {
  if (sender === null) return "(unknown)";
  const angled = /<([^>]*)>/.exec(sender);
  const address = (angled?.[1] ?? sender).trim().toLowerCase();
  const at = address.lastIndexOf("@");
  return at === -1 || at === address.length - 1 ? address : address.slice(at + 1);
}

// ---------------------------------------------------------------------------
// Corpus lane — RFC822 files on this machine
// ---------------------------------------------------------------------------

/** Headers this reads back out, matching what `composeEmailBody` writes. */
const COMPOSED_HEADERS = ["Subject", "From", "To", "Cc", "Date"] as const;

/**
 * One RFC822 file → the body shape production would have stored.
 *
 * The point is FIDELITY to `composeEmailBody` (`ingest/outlook/client.ts`),
 * which stores `Subject/From/To/Cc/Date`, a blank line, then the plain-text
 * body — and deliberately no `Bcc`. A raw corpus file carries dozens of other
 * headers (`Message-ID`, `X-Folder`, …) that production never stores, and
 * measuring those would inflate the denominator with text the extractor never
 * sees. So the headers are read, filtered to the five, and recomposed.
 *
 * Continuation lines are unfolded per RFC 5322 §2.2.3. MIME is NOT decoded:
 * a multipart message contributes its raw first part, which is why the report
 * carries `unreadable` — a corpus where that count is large is the wrong corpus
 * for this measurement, and the number should not be quoted from it.
 */
export function parseRfc822(raw: string): { sender: string | null; body: string } | null {
  const text = raw.replace(/\r\n/g, "\n");
  const split = text.indexOf("\n\n");
  if (split === -1) return null;

  const headerBlock = text.slice(0, split);
  const body = text.slice(split + 2).trim();
  if (body === "") return null;

  // Unfold: a line starting with whitespace continues the one before it.
  const unfolded: string[] = [];
  for (const line of headerBlock.split("\n")) {
    if (/^[ \t]/.test(line) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] = `${unfolded[unfolded.length - 1]} ${line.trim()}`;
    } else {
      unfolded.push(line);
    }
  }

  const found = new Map<string, string>();
  for (const line of unfolded) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const match = COMPOSED_HEADERS.find((h) => h.toLowerCase() === name);
    // First wins — a duplicated header in a corpus file is the trace of a relay,
    // and the topmost is the one the client would have shown.
    if (match !== undefined && !found.has(match)) found.set(match, line.slice(colon + 1).trim());
  }

  const headers = COMPOSED_HEADERS.filter((h) => found.has(h)).map((h) => `${h}: ${found.get(h)}`);
  if (headers.length === 0) return null;
  return { sender: found.get("From") ?? null, body: `${headers.join("\n")}\n\n${body}` };
}

interface CorpusRead {
  readonly samples: readonly TailSample[];
  readonly filesSeen: number;
  readonly unreadable: number;
  readonly unreadableDirs: number;
  readonly symlinksSkipped: number;
}

async function readCorpus(dir: string, limit: number): Promise<CorpusRead> {
  const samples: TailSample[] = [];
  let filesSeen = 0;
  let unreadable = 0;
  let unreadableDirs = 0;
  let symlinksSkipped = 0;

  const walk = async (current: string): Promise<void> => {
    if (samples.length >= limit) return;

    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (err) {
      // One permission hole must not discard the whole scan. An earlier version
      // let this throw all the way to `main`: a single unreadable sub-directory
      // ended the run at exit 1 with every message already read thrown away —
      // and the handler printed the path, which in a maildir is
      // `maildir/<lastname-f>/…`, i.e. a person's name. Counted, never named.
      log.debug(
        { err: err instanceof Error ? err.message : String(err) },
        "corpus directory unreadable — skipping its subtree",
      );
      unreadableDirs += 1;
      return;
    }

    for (const entry of entries) {
      if (samples.length >= limit) return;
      const path = join(current, entry.name);

      // `withFileTypes` reports the LINK, not its target, so a symlink is
      // neither `isFile()` nor `isDirectory()`. Left unhandled, symlinked mail
      // files and whole symlinked subtrees vanish from the scan while being
      // counted in NEITHER `filesSeen` NOR `unreadable` — a clean-looking report
      // that silently dropped most of the corpus. Since the header tells the
      // reader to judge corpus fitness by these counts, a silent omission
      // defeats the only signal on offer. Resolved with `stat`, which follows.
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const target = await stat(path);
          isDir = target.isDirectory();
          isFile = target.isFile();
        } catch (err) {
          // A dangling symlink is normal in an unpacked archive.
          log.debug(
            { err: err instanceof Error ? err.message : String(err) },
            "corpus symlink does not resolve — skipping",
          );
          symlinksSkipped += 1;
          continue;
        }
      }

      if (isDir) {
        await walk(path);
        continue;
      }
      if (!isFile) {
        // A socket, fifo or device node. Not mail, and not a failure to read
        // mail, so it is counted apart from both.
        symlinksSkipped += 1;
        continue;
      }
      filesSeen += 1;

      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch (err) {
        // A corpus is somebody's unpacked archive — broken symlinks and
        // permission holes are normal. Counted, not fatal, and never named:
        // the path of a mail file is itself a locator into private mail.
        log.debug(
          { err: err instanceof Error ? err.message : String(err) },
          "corpus file unreadable — skipping",
        );
        unreadable += 1;
        continue;
      }

      const parsed = parseRfc822(raw);
      if (parsed === null) {
        unreadable += 1;
        continue;
      }
      samples.push({
        group: groupOf(parsed.sender),
        // Through the real strip, so the corpus lane and the workspace lane
        // measure the same thing: what the extractor would actually read.
        text: strippedForExtraction(OUTLOOK_SOURCE, parsed.body, {
          workspaceId: "(corpus)",
          episodeId: "(corpus)",
        }),
      });
    }
  };

  await walk(dir);
  return { samples, filesSeen, unreadable, unreadableDirs, symlinksSkipped };
}

// ---------------------------------------------------------------------------
// Workspace lane — brain_episodes over DATABASE_URL
// ---------------------------------------------------------------------------

interface EpisodeBodyRow extends Record<string, unknown> {
  source: string;
  source_actor: string | null;
  body: string | null;
}

/**
 * Mail episodes for one workspace, as the extractor would read them.
 *
 * Read-only, one statement, no transaction — safe against a replica. Bodies are
 * turned into `TailSample`s and dropped; nothing retains them and nothing
 * prints them.
 */
export async function readWorkspaceSamples(
  client: { query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> },
  workspaceId: string,
  limit: number,
): Promise<readonly TailSample[]> {
  const result = await client.query<EpisodeBodyRow>(
    `SELECT source, source_actor, body
       FROM brain_episodes
      WHERE workspace_id = $1
        AND source = ANY($2)
        AND body IS NOT NULL
      ORDER BY ingested_at DESC
      LIMIT $3`,
    [workspaceId, EMAIL_SOURCES, limit],
  );

  return result.rows
    .filter((row): row is EpisodeBodyRow & { body: string } => typeof row.body === "string")
    .map((row) => ({
      group: groupOf(row.source_actor),
      text: strippedForExtraction(row.source, row.body, {
        workspaceId,
        // The measurement never reports per-episode rows, so it has no reason
        // to carry an id. The strip's own fallback logging is what would print
        // one, and a placeholder keeps this run out of that lane's output.
        episodeId: "(measurement)",
      }),
    }));
}

// ---------------------------------------------------------------------------
// Cap pressure
// ---------------------------------------------------------------------------

/**
 * How the cap and the tail actually interact — and the correction to #5420's
 * second claim.
 *
 * ⚠️ THE ISSUE'S PREMISE IS WRONG, AND SO WAS THIS FUNCTION'S FIRST VERSION.
 * #5420 says the disclaimer *"eats into `MAX_BODY_CHARS` on exactly the messages
 * already closest to the cap"*, which reads as though a trailing footer pushes
 * real content off the end. It cannot. `extractionExcerpt` takes a FRONT slice
 * — `text.slice(0, MAX_BODY_CHARS)` — and the tail is at the BACK. Write `L` for
 * the message length and `T` for its tail:
 *
 *     real content delivered  =  min(cap, L - T)      … before stripping
 *     real content delivered  =  min(cap, L - T)      … after stripping
 *
 * The two are identical, for every `L` and every `T`. Removing a trailing tail
 * can never recover a single character of real content from a front slice, so
 * **the tail costs TOKENS ONLY — never a claim.** The first version of this
 * function counted `L - T <= cap` as messages "rescued by" stripping; that
 * predicate is true precisely when the cut at `cap` lands *inside* the tail,
 * i.e. when nothing but boilerplate was discarded. It reported its own
 * best-case as a saving. It is gone rather than fixed, because the quantity it
 * named does not exist.
 *
 * What IS true, and is what this reports: a tail lying beyond the cap is
 * already free. It was never sent, so a stripper cannot save it. Only the part
 * of the tail inside the first `cap` characters is a real cost:
 *
 *     tail actually sent  =  max(0, min(cap, L) - (L - T))
 *
 * That makes {@link CapInteraction.sentShare} the number #5420 actually asked
 * for — the share of what the model READS that is boilerplate — while the
 * report's headline `share` is the share of stored text, which over-counts on
 * capped messages. Both are printed, and the difference between them IS the
 * finding for anyone deciding this.
 *
 * Lengths are the NORMALISED ones from `boilerplateTailOf` (trailing whitespace
 * and blank lines removed) so the tail and the total are measured the same way;
 * `extractionExcerpt` compares the raw length against the cap, and the gap
 * between the two is trailing whitespace only.
 */
interface CapInteraction {
  readonly cap: number;
  /** Messages the extractor truncates today. */
  readonly overCap: number;
  /** Characters actually sent to the model, summed. The honest denominator. */
  readonly charsSent: number;
  /** Of those, characters that are repeated tail. The honest numerator. */
  readonly tailCharsSent: number;
  /** Tail beyond the cap — never sent, already free, unrecoverable by a strip. */
  readonly tailCharsBeyondCap: number;
  /** `tailCharsSent / charsSent` — boilerplate share of what the model reads. */
  readonly sentShare: number;
  /**
   * Always 0, and stated rather than omitted.
   *
   * A reader who knows #5420's text will look for the "messages a strip would
   * un-truncate" number. It is identically zero for the reason derived above,
   * and a silently absent field would read as an oversight rather than as a
   * result.
   */
  readonly claimsRecoverableByStripping: 0;
}

function capInteraction(tails: readonly SampleTail[], cap: number): CapInteraction {
  let overCap = 0;
  let charsSent = 0;
  let tailCharsSent = 0;
  let tailCharsBeyondCap = 0;

  for (const tail of tails) {
    const length = tail.totalChars;
    if (length > cap) overCap += 1;

    const sent = Math.min(cap, length);
    charsSent += sent;

    // Where the tail begins. `tail.chars` is 0 for a message with no counted
    // tail, which makes this the message's own length and the arm below zero.
    const tailStart = length - tail.chars;
    const sentTail = Math.max(0, sent - tailStart);
    tailCharsSent += sentTail;
    tailCharsBeyondCap += tail.chars - sentTail;
  }

  return {
    cap,
    overCap,
    charsSent,
    tailCharsSent,
    tailCharsBeyondCap,
    sentShare: charsSent === 0 ? 0 : tailCharsSent / charsSent,
    claimsRecoverableByStripping: 0,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

interface Measurement {
  readonly lane: "corpus" | "workspace";
  readonly report: BoilerplateTailReport;
  readonly capInteraction: CapInteraction;
  readonly corpus?: {
    readonly filesSeen: number;
    readonly unreadable: number;
    readonly unreadableDirs: number;
    readonly symlinksSkipped: number;
  };
}

export function measure(
  lane: "corpus" | "workspace",
  samples: readonly TailSample[],
  minRepeats: number,
): Measurement {
  const tails = boilerplateTailOf(samples, { minRepeats });
  return {
    lane,
    report: measureBoilerplateTails(samples, { minRepeats }),
    capInteraction: capInteraction(tails, MAX_BODY_CHARS),
  };
}

async function main(): Promise<void> {
  let options: Options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "bad arguments");
    process.exit(1);
  }

  let exitCode: number;
  let pool: Pool | null = null;
  try {
    let measurement: Measurement;

    if (options.corpus !== null) {
      const dir = options.corpus;
      const info = await stat(dir);
      if (!info.isDirectory()) throw new Error(`${dir} is not a directory`);
      const read = await readCorpus(dir, options.limit);
      measurement = {
        ...measure("corpus", read.samples, options.minRepeats),
        corpus: {
          filesSeen: read.filesSeen,
          unreadable: read.unreadable,
          unreadableDirs: read.unreadableDirs,
          symlinksSkipped: read.symlinksSkipped,
        },
      };
    } else {
      const databaseUrl = process.env.DATABASE_URL;
      if (databaseUrl === undefined || databaseUrl === "") {
        throw new Error("DATABASE_URL is not set — the workspace lane has nothing to read");
      }
      pool = new Pool({ connectionString: databaseUrl, max: 1 });
      const samples = await readWorkspaceSamples(
        pool,
        options.workspace as string,
        options.limit,
      );
      measurement = measure("workspace", samples, options.minRepeats);
    }

    if (measurement.report.messages === 0) {
      // Exit 2, NOT a zero share. See the exit-code contract in the header.
      log.error(
        { lane: measurement.lane },
        "nothing to measure — no readable mail messages were found, so no share was computed",
      );
      exitCode = 2;
    } else {
      process.stdout.write(`${JSON.stringify(measurement)}\n`);
      exitCode = 0;
    }
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "disclaimer-share measurement failed",
    );
    exitCode = 1;
  }

  if (pool !== null) await pool.end();
  process.exit(exitCode);
}

if (import.meta.main) {
  main().catch((err) => {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "measurement threw");
    process.exit(1);
  });
}
