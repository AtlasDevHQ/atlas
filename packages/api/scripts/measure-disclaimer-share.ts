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
 * ⚠️ `--limit` truncates in DIRECTORY-WALK ORDER, not at random. On a corpus
 * laid out per-sender (Enron's maildir is), a small limit can land entirely
 * inside one or two senders and report a share that says more about which
 * folder sorted first than about the corpus. It is a way to bound a first run,
 * not a sampling strategy — a number quoted into #5420 should come from a run
 * whose `messages` count is the whole corpus, or from one whose `groups` count
 * is large enough to be credible.
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

import { readdir, readFile, stat } from "node:fs/promises";
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
function groupOf(sender: string | null): string {
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
function parseRfc822(raw: string): { sender: string | null; body: string } | null {
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
}

async function readCorpus(dir: string, limit: number): Promise<CorpusRead> {
  const samples: TailSample[] = [];
  let filesSeen = 0;
  let unreadable = 0;

  const walk = async (current: string): Promise<void> => {
    if (samples.length >= limit) return;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (samples.length >= limit) return;
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
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
  return { samples, filesSeen, unreadable };
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
 * #5420: "It also eats into `MAX_BODY_CHARS` on exactly the messages already
 * closest to the cap."
 *
 * That claim is not answerable from an average, so it is computed per message:
 * of the messages the extractor truncates today, how many would fit whole if
 * their repeated tail came off? A truncated message is the one case where the
 * tail costs a CLAIM rather than only tokens — the tail sits at the end, the
 * cap cuts from the end, so the text pushed over the edge is real content.
 *
 * `sample.text.length` is the raw stripped length (what `extractionExcerpt`
 * actually compares against the cap), while `tail.chars` is measured on
 * normalised lines. Normalisation only ever shrinks, so `rescued` is a LOWER
 * bound — the honest direction for a number that argues for doing work.
 */
interface CapPressure {
  readonly cap: number;
  readonly overCap: number;
  readonly overCapRescuedByTail: number;
  readonly overCapTailChars: number;
}

function capPressure(
  samples: readonly TailSample[],
  tails: readonly { chars: number }[],
): CapPressure {
  let overCap = 0;
  let overCapRescuedByTail = 0;
  let overCapTailChars = 0;

  for (let i = 0; i < samples.length; i += 1) {
    const length = (samples[i] as TailSample).text.length;
    if (length <= MAX_BODY_CHARS) continue;
    overCap += 1;
    const chars = (tails[i]?.chars ?? 0) as number;
    overCapTailChars += chars;
    if (length - chars <= MAX_BODY_CHARS) overCapRescuedByTail += 1;
  }

  return { cap: MAX_BODY_CHARS, overCap, overCapRescuedByTail, overCapTailChars };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

interface Measurement {
  readonly lane: "corpus" | "workspace";
  readonly report: BoilerplateTailReport;
  readonly capPressure: CapPressure;
  readonly corpus?: { readonly filesSeen: number; readonly unreadable: number };
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
    capPressure: capPressure(samples, tails),
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
        corpus: { filesSeen: read.filesSeen, unreadable: read.unreadable },
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
