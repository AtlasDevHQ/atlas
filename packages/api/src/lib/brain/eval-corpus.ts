/**
 * The evaluation set's collection and labelling contract (#5338 AC 3).
 *
 * ## Why this exists at all
 *
 * #5338's recall denominator is *episodes yielding a published, non-retracted
 * fact* — a human review decision. Measured against prod on 2026-09-02, the
 * `us` region holds **36 episodes lifetime**, so the number of episodes a
 * reviewer could ever have decided about is 36 against a Wilson floor of 110.
 * That is a ceiling, not a running total: reviewing the outstanding drafts does
 * not move it, because they come from those same 36 episodes. The prod path
 * does not converge, and the issue's own answer applies — the number is set on
 * a labelled set and prod is the smoke test.
 *
 * So the set is **public text, labelled by a human**. This module is the part
 * that can be written before anyone labels anything: collect episodes
 * mechanically, hand a person a sheet, and turn a filled sheet into a fixture.
 *
 * ## ⛔ Corpus text and labels NEVER enter this repository
 *
 * `.claude/research/extractor-corpus-acquisition.md` lists under **Prohibited**:
 * *"**Committing any corpus text to this repository**, which is public and
 * AGPL; acquisition lands in private storage per the path plan."* Its path plan
 * is explicit about what git may hold: *"This repository carries only this
 * document, the acquisition scripts if any are written, and the manifests'
 * hashes if useful — **never corpus text, never labels**."*
 *
 * ADR-0044 permits an evaluation set at all only on this footing: *"Training
 * data ends up in the weights — that is the leak surface. Evaluation data is
 * **read once and discarded**."* A fixture versioned in git is neither read
 * once nor discarded.
 *
 * ⭐ The first draft of this module wrote sheets and fixtures into
 * `packages/api/scripts/heldout/fixtures/`, which is tracked — and did so in
 * the same directory whose README already argues that a manifest may live in
 * git *precisely because* it carries no bodies. So the rule is enforced rather
 * than documented: {@link assertOutsideRepo} refuses any output path inside the
 * working tree, and both CLIs route every write through it. What git keeps is
 * the scripts, the recorded measurement, and the fixture's **sha256** — which
 * the path plan explicitly allows and which is what makes a number traceable to
 * a set the repo does not hold.
 *
 * ## The denominator is a reviewer's judgement of the TEXT (#5338, amended 2026-09-02)
 *
 * AC 3 originally read *"episodes yielding a published, non-retracted fact"* —
 * the pipeline's outcome, which requires the extractor to have produced a
 * candidate AND a reviewer to have published it. On a prod cut the two are the
 * same thing, because there the only evidence a claim existed is that the
 * pipeline produced one. On a labelled corpus they come apart, and the
 * criterion now asks for the reviewer's judgement of the text alone.
 *
 * ⭐ The reason is that the outcome denominator **decays toward unsafe**: an
 * episode counts as a positive only if TODAY's extractor would have produced a
 * candidate, so a triage drop the extractor would have missed anyway scores as
 * free — until #5337 ships a better extractor and it is not free any more,
 * while the recorded measurement the gate treats as live still says it is. A
 * denominator that moves with extractor quality has to be re-cut on every
 * extractor change, which defeats the freeze this whole apparatus rests on. It
 * also carries a perverse gradient: an extractor REGRESSION would make triage's
 * recall go up, because fewer episodes qualify as positives.
 *
 * The cost, stated because it is real: this over-counts. It includes claims no
 * realistic extractor would catch, so the number runs pessimistic and triage
 * can be charged with a miss that would not have cost a published fact today.
 * The gap between the two denominators is reported rather than hidden — see
 * {@link SHEET_LABEL_GUIDE} and the README's "both numbers" step.
 *
 * ## What it is NOT allowed to do, and how that is enforced
 *
 * ⭐ **A sheet carries no triage information, ever.** If the labeller could see
 * which rule would fire, the labels are anchored to the thing under test and
 * the measurement is circular. That is why a sheet is its own file type rather
 * than a `MeasurementFixture` with null classes: {@link parseSheet} refuses any
 * key it does not declare, and nothing in this module imports `triage.ts`.
 *
 * ⭐ **Selection is mechanical, and the window refuses rather than truncates.**
 * `heldout-manifest.ts` makes this argument for prod cuts and it is the same
 * one: a set clipped at a cap is sampled by sort order, which is exactly the
 * authorship a mechanical window exists to remove. {@link checkSheetSize}
 * refuses an oversized window and tells the operator to narrow it.
 *
 * ## What pseudonymisation does and does not achieve
 *
 * ⚠️ Stated plainly because the reassuring version of this sentence is easy to
 * write: {@link pseudonymise} rewrites the MECHANICAL identifiers — `@handle`
 * mentions and email addresses — and **names in free text survive it**. A
 * comment reading "Marco said he'd take this" still reads that way afterwards.
 * The claim this module makes is that the set carries no handle you can
 * resolve to an account and no address you can mail, not that it is anonymous.
 * Anything stronger would need a different technique and a different claim.
 *
 * @see ./triage-measure-record.ts — what the fixture this produces may claim
 * @see ../../../.claude/research/extractor-corpus-acquisition.md — the corpora and their licences
 */
import { existsSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { HeldoutClass } from "@atlas/api/lib/brain/heldout-manifest";
import type { LabelledEpisode } from "@atlas/api/lib/brain/triage-measure";
import type {
  FixtureProvenance,
  MeasurementFixture,
} from "@atlas/api/lib/brain/triage-measure-record";

/**
 * The repository's working-tree root, found by walking up to the `.git` marker.
 *
 * Walked rather than counted in `../`s: the module's depth is a fact about
 * today's layout, and a file that moves one directory would silently start
 * approving writes into the repo — the failure mode being guarded against.
 * Returns null when no marker is found (a published tarball, say), and
 * {@link assertOutsideRepo} treats that as "not in a repo, nothing to protect".
 */
function repoRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 12; up += 1) {
    if (existsSync(resolve(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Refuse to write corpus text or labels anywhere inside the working tree.
 *
 * Returns null when the path is safe, or the refusal. The message quotes the
 * prohibition rather than paraphrasing it, because the reader is about to be
 * told "no" to something reasonable-looking and deserves the actual rule.
 *
 * ⚠️ The check is on the RESOLVED path, so `../../..` back into the repo is
 * caught, and it is a prefix test on a path segment boundary so a sibling
 * directory whose name merely starts with the repo's (`atlas-scratch` beside
 * `atlas`) is not swept up with it.
 */
export function assertOutsideRepo(outPath: string): string | null {
  const root = repoRoot();
  if (root === null) return null;
  const target = resolve(outPath);
  if (target !== root && !target.startsWith(root + sep)) return null;
  return (
    `Refusing to write ${target}: it is inside the repository working tree (${root}).\n` +
    `extractor-corpus-acquisition.md, Prohibited: "Committing any corpus text to this ` +
    `repository, which is public and AGPL; acquisition lands in private storage per the path ` +
    `plan." Its path plan: this repo carries "only this document, the acquisition scripts if ` +
    `any are written, and the manifests' hashes if useful — never corpus text, never labels."\n` +
    `ADR-0044 permits an evaluation set on the footing that "evaluation data is read once and ` +
    `discarded"; a fixture versioned in git is neither.\n` +
    `Write it outside the tree (set ${CORPUS_DIR_ENV}, or pass an absolute path elsewhere). ` +
    `What belongs in git is the recorded measurement and the fixture's sha256.`
  );
}

/** The env var naming where sheets and fixtures live. Outside the repo, always. */
export const CORPUS_DIR_ENV = "ATLAS_EVAL_CORPUS_DIR";

/**
 * The ceiling on one sheet, and the reason it is a refusal rather than a slice.
 *
 * Sized so a sheet is labellable in one sitting at the ~36% positive rate the
 * first prod cut observed — 110 positives needs roughly 300 episodes — with
 * room for a window that overshoots a little. Past it the operator narrows the
 * window; the tool does not choose which episodes to keep.
 */
export const SHEET_MAX_EPISODES = 400;

/** One row a human has to make a decision about. `class` null until they do. */
export interface SheetEpisode {
  /** Stable and PUBLIC — `<host>-<repo>-<commentId>`, so a row can be audited back to its source. */
  readonly id: string;
  /** The raw body, exactly as an ingested episode would store it. See {@link RAW_BODY_NOTE}. */
  readonly body: string;
  readonly class: HeldoutClass | null;
}

/**
 * ⚠️ Bodies are stored RAW — no quoted-reply strip, no truncation.
 *
 * Not an omission. Triage runs on `brain_episodes.body` (`deterministicTriager`
 * reads `episode.body`, and the drain selects `e.body`); the quoted-reply strip
 * and the 8k cap live in `extractionExcerpt`, which runs later and only for the
 * model call. A corpus that pre-stripped would hand triage a shape production
 * never gives it — and stage 0's rules are length- and shape-sensitive, so the
 * difference lands directly on the number.
 */
export const RAW_BODY_NOTE =
  "bodies are stored raw: triage reads the stored body, and the quoted-reply strip runs later, for the model call only";

/** A collected, unlabelled sheet. Deliberately NOT a `MeasurementFixture`. */
export interface EvalSheet {
  /**
   * The label definitions, written into the file so the labeller reads them
   * beside the rows rather than in a doc they have to go and find.
   *
   * ⚠️ On the TYPE and validated, not merely allow-listed. An unvalidated
   * free-form key is a place triage output can ride into a sheet — which is
   * the one thing this format exists to prevent — so `_guide` must be exactly
   * the shipped guide and `_note` exactly the shipped notes.
   */
  readonly _guide?: Readonly<Record<HeldoutClass, string>>;
  readonly _note?: readonly string[];
  /** Format marker. A sheet cannot be fed to the harness by renaming it. */
  readonly sheet: 1;
  /** Where the text came from, in enough detail to re-collect it. */
  readonly source: {
    readonly corpus: string;
    readonly repos: readonly string[];
    readonly from: string;
    readonly to: string;
  };
  readonly collectedAt: string;
  readonly episodes: readonly SheetEpisode[];
}

/**
 * The precedence a labeller applies when an episode fits more than one class.
 *
 * ⚠️ Stated because `heldout-manifest.ts` fixes it for prod cuts — an episode
 * yielding both a published and a retracted fact collapses to `positive` —
 * and a hand-labelled set that used a different rule would compute the number
 * over a differently-shaped population than the corpus it is meant to mirror.
 * The rule is the manifest's, verbatim: **positive beats rejected beats
 * negative.**
 */
export const SHEET_CLASS_PRECEDENCE: readonly HeldoutClass[] = [
  "positive",
  "rejected",
  "negative",
];

/** The classes a labeller may write, with what each one means. */
export const SHEET_LABEL_GUIDE: Readonly<Record<HeldoutClass, string>> = {
  positive:
    "This episode carries a claim about the world you would PUBLISH as a fact — ownership, status, a decision, a deprecation. Judge the TEXT: would you publish this if it were put in front of you? Do NOT ask whether the extractor would find it — that is a different question, answered separately and afterwards. The counterfactual the number rests on: if triage drops this, a claim you would have published is never proposed.",
  rejected:
    "This episode carries a claim you would look at and REJECT — it reads like an assertion but you would not publish it. Rejected rides the ungated diagnostic beside the gating number; it is not a positive.",
  negative:
    "Nothing here would ever have become a fact — a reaction, an acknowledgement, pure logistics, a code dump with no assertion. Triage dropping this is the tool working.",
};

/** Structural equality for the two pinned annotation blocks. */
function deepEquals(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The precedence sentence, carried into the sheet so a labeller reads it there. */
export const SHEET_PRECEDENCE_NOTE_TEXT =
  "If an episode fits more than one class, POSITIVE beats REJECTED beats NEGATIVE — the same collapse heldout-manifest.ts applies to prod cuts, so the two sets describe the same shape of population.";

/**
 * Everything the collector writes into `_note`, in order. Pinned by
 * {@link parseSheet}.
 *
 * ⚠️ Declared AFTER both members. A `const` referencing a later `const` is a
 * temporal-dead-zone throw at module load, not a hoisting convenience — and it
 * would fire on import, taking every consumer of this module down with it.
 */
export const SHEET_NOTES: readonly string[] = [RAW_BODY_NOTE, SHEET_PRECEDENCE_NOTE_TEXT];

/**
 * Refuse an oversized window, with the fix in the message.
 *
 * Returns null when the sheet is a legitimate size, or the refusal.
 */
export function checkSheetSize(count: number, max: number = SHEET_MAX_EPISODES): string | null {
  if (count <= max) return null;
  return (
    `The window yields ${count} episodes, above the ${max} a sheet may carry. Narrow the ` +
    `window and re-run — the tool will not choose which ${count - max} to drop, because a set ` +
    `clipped at a cap is sampled by sort order, and that is the authorship a mechanical window ` +
    `exists to remove.`
  );
}

/** A stable handle→pseudonym assignment, in first-seen order within one set. */
export type PseudonymMap = Map<string, string>;

const MENTION = /(?<![\w/])@([A-Za-z\d](?:[A-Za-z\d]|-(?=[A-Za-z\d])){0,38})\b/g;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/**
 * Rewrite the mechanical identifiers in one body.
 *
 * ⚠️ **What actually protects an address is the lookbehind, not the order.**
 * An earlier version of this comment claimed emails had to run first because
 * the mention pattern would otherwise eat the local-part-then-`@` of an
 * address. It cannot: `(?<![\w/])` already refuses to start a match after a
 * word character, so `dev@kafka.apache.org` is untouched by a mention-only
 * pass — measured, not reasoned. The order is harmless belt-and-braces and the
 * lookbehind is the load-bearing part; if anyone ever relaxes it, the
 * half-rewritten-address hazard becomes real for the first time.
 *
 * ⚠️ **The handle shape is GitHub's, and non-GitHub handles pass through.**
 * `[A-Za-z\d]` plus internal hyphens, max 39 — GitHub's own login rule. So
 * `@foo_bar` (underscores are not legal in a GitHub login) and any run past 39
 * characters are left verbatim. That is correct for a GitHub corpus, where
 * neither is a resolvable account, and it is a real gap for any other source —
 * which is why the corpus is named on the sheet.
 *
 * The map is shared across a whole sheet so that a handle appearing in three
 * episodes is the same pseudonym in all three — a set where "person-4" means
 * three different people cannot carry a coherent ownership claim, and ownership
 * claims are most of what makes an episode a positive.
 */
export function pseudonymise(body: string, map: PseudonymMap): string {
  const assign = (key: string): string => {
    const existing = map.get(key.toLowerCase());
    if (existing !== undefined) return existing;
    const minted = `person-${map.size + 1}`;
    map.set(key.toLowerCase(), minted);
    return minted;
  };
  return body
    .replace(EMAIL, (address) => `${assign(address)}@example.invalid`)
    .replace(MENTION, (_whole, handle: string) => `@${assign(handle)}`);
}

/** What {@link parseSheet} rejects, as a message rather than a boolean. */
export class SheetFormatError extends Error {
  constructor(message: string) {
    super(`eval sheet: ${message}`);
    this.name = "SheetFormatError";
  }
}

const CLASSES: readonly HeldoutClass[] = ["positive", "rejected", "negative"];

/**
 * Parse a sheet, refusing anything it does not declare.
 *
 * Strict about EXTRA keys, and that is the enforcement behind this module's
 * first rule: a sheet carrying a `verdict`, a `rule` or a `triage` field is a
 * sheet whose labeller could have been anchored by the thing under test, and it
 * is refused rather than stripped — stripping would let the anchored labels
 * through with the evidence removed.
 */
export function parseSheet(raw: unknown): EvalSheet {
  if (typeof raw !== "object" || raw === null) throw new SheetFormatError("not an object");
  const obj = raw as Record<string, unknown>;
  const allowed = new Set(["sheet", "source", "collectedAt", "episodes", "_guide", "_note"]);
  const extra = Object.keys(obj).filter((k) => !allowed.has(k));
  if (extra.length > 0) {
    throw new SheetFormatError(
      `carries undeclared key(s) ${extra.join(", ")}. A sheet may not hold triage output of any ` +
        `kind — a labeller who could see which rule fires is labelling the thing under test.`,
    );
  }
  // ⭐ The two annotation keys are CHECKED against what the collector writes,
  // not merely permitted. An allow-listed free-form field is a channel: a
  // `_note` carrying "gh-14 would be dropped by known_ack" anchors the labeller
  // to the layer under test just as effectively as a `triage` key would, and it
  // would have passed the key check above untouched.
  if (obj._guide !== undefined && !deepEquals(obj._guide, SHEET_LABEL_GUIDE)) {
    throw new SheetFormatError(
      "`_guide` is not the shipped label guide. It is written by the collector and read by a " +
        "human; an edited one is either stale guidance or a channel for triage output.",
    );
  }
  if (obj._note !== undefined && !deepEquals(obj._note, SHEET_NOTES)) {
    throw new SheetFormatError("`_note` is not the shipped note set — see `_guide` above.");
  }
  if (obj.sheet !== 1) throw new SheetFormatError("missing the `sheet: 1` format marker");
  const source = obj.source as EvalSheet["source"] | undefined;
  if (
    typeof source !== "object" ||
    source === null ||
    typeof source.corpus !== "string" ||
    !Array.isArray(source.repos) ||
    typeof source.from !== "string" ||
    typeof source.to !== "string"
  ) {
    throw new SheetFormatError("`source` must carry corpus, repos, from and to");
  }
  if (typeof obj.collectedAt !== "string") throw new SheetFormatError("`collectedAt` must be a string");
  if (!Array.isArray(obj.episodes)) throw new SheetFormatError("`episodes` must be an array");

  const episodes: SheetEpisode[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of (obj.episodes as unknown[]).entries()) {
    if (typeof entry !== "object" || entry === null) {
      throw new SheetFormatError(`episode ${index} is not an object`);
    }
    const row = entry as Record<string, unknown>;
    const rowExtra = Object.keys(row).filter((k) => k !== "id" && k !== "body" && k !== "class");
    if (rowExtra.length > 0) {
      throw new SheetFormatError(
        `episode ${index} carries undeclared key(s) ${rowExtra.join(", ")} — see above`,
      );
    }
    if (typeof row.id !== "string" || row.id === "") {
      throw new SheetFormatError(`episode ${index} has no id`);
    }
    if (seen.has(row.id)) {
      // A duplicate id would be counted twice by the harness, which inflates
      // whichever class it lands in — and the id is the only thing tying a row
      // back to its public source, so a collision is also an audit failure.
      throw new SheetFormatError(`episode id ${row.id} appears twice`);
    }
    seen.add(row.id);
    if (typeof row.body !== "string") throw new SheetFormatError(`episode ${row.id} has no body`);
    // A whitespace-only body is refused HERE because `parseMeasurementFixture`
    // refuses it later: accepting it would let a sheet label rows that the
    // harness will then reject, so the labeller's work is discarded at the far
    // end of the lane rather than at the near one. The collector already drops
    // empty bodies, so this catches a hand-edited sheet.
    if (row.body.trim() === "") {
      throw new SheetFormatError(
        `episode ${row.id} has a blank body — nothing was ingested, so there is nothing to triage`,
      );
    }
    const cls = row.class;
    if (cls !== null && !CLASSES.includes(cls as HeldoutClass)) {
      throw new SheetFormatError(
        `episode ${row.id} has class ${JSON.stringify(cls)} — expected null or one of ${CLASSES.join(", ")}`,
      );
    }
    episodes.push({ id: row.id, body: row.body, class: (cls ?? null) as HeldoutClass | null });
  }
  return {
    sheet: 1,
    source: { corpus: source.corpus, repos: [...source.repos] as string[], from: source.from, to: source.to },
    collectedAt: obj.collectedAt,
    episodes,
  };
}

/** How much of a sheet is done — what the builder reports before it refuses. */
export interface SheetProgress {
  readonly total: number;
  readonly labelled: number;
  readonly unlabelled: readonly string[];
  readonly byClass: Readonly<Record<HeldoutClass, number>>;
}

export function sheetProgress(sheet: EvalSheet): SheetProgress {
  const byClass: Record<HeldoutClass, number> = { positive: 0, rejected: 0, negative: 0 };
  const unlabelled: string[] = [];
  for (const episode of sheet.episodes) {
    if (episode.class === null) unlabelled.push(episode.id);
    else byClass[episode.class] += 1;
  }
  return {
    total: sheet.episodes.length,
    labelled: sheet.episodes.length - unlabelled.length,
    unlabelled,
    byClass,
  };
}

/**
 * Turn a fully-labelled sheet into the fixture the harness measures.
 *
 * ⭐ **A partly-labelled sheet is REFUSED, not filtered.** Dropping the
 * unlabelled rows would silently redefine the set as "the episodes somebody got
 * round to", which is a curated set wearing a mechanical one's provenance — and
 * it would do so most on the rows a labeller found hardest to call, which are
 * exactly the rows a triage layer is most likely to get wrong.
 */
/**
 * The sha256 of a fixture's serialised form — the ONE thing about a set that
 * may live in git.
 *
 * The path plan permits *"the manifests' hashes if useful"* while refusing text
 * and labels, and this is what makes it useful: a recorded measurement names a
 * `setId`, and a digest turns that name into something checkable against a
 * fixture held privately. Without it, "measured on apache-2026-06" is a string
 * anybody could type.
 */
export async function fixtureDigest(fixture: MeasurementFixture): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(fixture));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Merge sheets into one fixture, refusing an id that appears in two of them.
 *
 * ⭐ Needed because `SHEET_MAX_EPISODES` is a per-sheet refusal, not a per-set
 * one: clearing 110 positives takes roughly 300 episodes at the rate the first
 * prod cut observed, and a corpus whose positive rate runs lower needs more
 * than one sheet to get there. Without a merge the cap would be a ceiling on
 * the SET, which would make the threshold unreachable by construction — the
 * refusal would have quietly become the thing it was protecting against.
 *
 * A cross-sheet duplicate is refused rather than de-duplicated: the same
 * episode labelled twice may carry two different classes, and silently keeping
 * one of them picks a label nobody chose.
 */
export function sheetsToFixture(
  sheets: readonly EvalSheet[],
  provenance: FixtureProvenance,
): MeasurementFixture {
  if (sheets.length === 0) throw new SheetFormatError("no sheets given");
  const seen = new Map<string, number>();
  for (const [index, sheet] of sheets.entries()) {
    for (const episode of sheet.episodes) {
      const first = seen.get(episode.id);
      if (first !== undefined) {
        throw new SheetFormatError(
          `episode ${episode.id} appears in sheet ${first + 1} and sheet ${index + 1}. Refusing ` +
            `to merge: the same episode may carry two different labels, and keeping one picks a ` +
            `label nobody chose.`,
        );
      }
      seen.set(episode.id, index);
    }
  }
  const [first, ...rest] = sheets;
  // Narrowed by destructuring rather than `sheets[0]!` — the emptiness check
  // above proves it, but an assertion states a fact the compiler cannot see and
  // this spelling needs no assertion at all.
  if (first === undefined) throw new SheetFormatError("no sheets given");
  const merged = [...first.episodes, ...rest.flatMap((sheet) => sheet.episodes)];
  return sheetToFixture({ ...first, episodes: merged }, provenance);
}

export function sheetToFixture(sheet: EvalSheet, provenance: FixtureProvenance): MeasurementFixture {
  // ONE pass that both narrows and collects, rather than a check followed by a
  // map with a `?? "negative"` the type system needs and nothing can reach. A
  // default there would be unreachable AND would pick the class that flatters
  // triage — an episode dropped as negative costs the recall number nothing —
  // which is the worst available spelling of a branch that cannot fire.
  const episodes: LabelledEpisode[] = [];
  const unlabelled: string[] = [];
  for (const episode of sheet.episodes) {
    if (episode.class === null) unlabelled.push(episode.id);
    else episodes.push({ id: episode.id, class: episode.class, body: episode.body });
  }
  if (unlabelled.length > 0) {
    const shown = unlabelled.slice(0, 5).join(", ");
    const rest = unlabelled.length > 5 ? `, +${unlabelled.length - 5} more` : "";
    throw new SheetFormatError(
      `${unlabelled.length} of ${sheet.episodes.length} episodes are unlabelled (${shown}${rest}). ` +
        `Refusing to build: dropping them would redefine the set as "the ones somebody got round ` +
        `to", and the rows hardest to call are the ones this measurement is about.`,
    );
  }
  return { role: "evaluation", provenance, episodes };
}
