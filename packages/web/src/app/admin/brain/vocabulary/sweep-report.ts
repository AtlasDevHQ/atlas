import { serverMessage, type FetchError } from "@/ui/lib/fetch-error";

/**
 * What the operator reads after a tension sweep — the copy decisions, held apart
 * from the panel that renders them (#5447).
 *
 * ## Why a module rather than JSX inline
 *
 * Every sentence here is an assertion about what did or did not happen to the
 * corpus, and each one has a state it must NOT be reachable from. `tension-state.ts`
 * in the sibling `facts/` pane is its own module for the same reason: pinning the
 * boundary cases should not require mounting a page, and a copy decision that can
 * only be tested through a render is a copy decision nobody re-checks.
 *
 * ## The two facts this module exists to keep apart
 *
 * `POST /tension-sweep`'s own 200 description is the specification:
 *
 * > `0` does not identify a cause: it is returned when the corpus has converged,
 * > when there are no live facts, AND when no predicate in this workspace is
 * > curated `single` and approved — which is the commonest reason on a workspace
 * > that has just started curating, since a pending proposal does not arm the
 * > sweep. Check the vocabulary before reading `0` as done.
 *
 * So `{minted: 0}` is **three facts wearing one number**, and the route text
 * anticipates an operator being told which. A panel that rendered "Nothing to
 * flag" would be the confident false all-clear this whole admin area is built to
 * refuse — and it would be wrong most often on exactly the workspace the sweep
 * was built for: one that has just authored its first `single` entry and has a
 * PENDING proposal rather than an approved one.
 */

/** The three contentions `POST /tension-sweep` names in its 409 body's `error`. */
export const SWEEP_CONTENTIONS = ["reconcile-lock", "conflicting-lock", "unfinished"] as const;

export type SweepContention = (typeof SWEEP_CONTENTIONS)[number];

/** Is this 409's `error` code one of the three arms the route documents? */
export function isSweepContention(code: string | undefined): code is SweepContention {
  return code !== undefined && (SWEEP_CONTENTIONS as readonly string[]).includes(code);
}

/**
 * The refusal sentence for a sweep that did not run.
 *
 * ## The server's prose wins, and the fallback is not a second spelling of it
 *
 * `contentionMessage` in `lib/brain/tension-sweep.ts` owns these three
 * sentences, and the route sends them — so this renders the server's copy
 * verbatim, exactly as `onAuthor` does one file over. A client that mapped a
 * code to its own sentence would be a second spelling of a rule the server
 * owns, and the two would drift.
 *
 * The per-code map below is therefore NOT that second spelling. It fires only
 * when the 409 arrived with no prose at all — a proxy-generated body, a
 * truncated response — where there is nothing to drift from and the alternative
 * is `friendlyError`'s status line, which collapses all three arms into "the
 * server rejected the request (409)". The acceptance bar is that each arm reads
 * as itself; a shared status line fails it in exactly the state where an
 * operator most needs to know whether to retry.
 *
 * ⚠️ **The unrecognised arm does not say "nothing was changed".** All three
 * documented contentions guarantee it, and the temptation is to hoist that
 * clause out as the one thing true of every refusal. It is true of every
 * refusal *this page knows about*. A 409 carrying a fourth code is an API newer
 * than this bundle, and asserting the corpus is untouched on its behalf is a
 * claim about a code path that did not exist when this sentence was written —
 * the `structurallyEmptyCopy` default arm's rule, applied to a write.
 */
export function sweepRefusal(error: FetchError): string {
  const authored = serverMessage(error);
  if (authored !== undefined) return authored;
  if (isSweepContention(error.code)) return CONTENTION_FALLBACK[error.code];
  if (error.status === 409) {
    return (
      "The sweep refused to run, for a reason this page does not recognise" +
      (error.code === undefined ? "" : ` (“${error.code}”)`) +
      ". Do not assume the corpus is unchanged — this page cannot tell you either way. " +
      "The API is likely newer than this page; reload, and check the API service logs before retrying."
    );
  }
  return (
    "The sweep could not be run and the server explained nothing, so whether anything was " +
    "changed is unknown. Reload before retrying, and check the API service logs if it persists."
  );
}

/**
 * The client-side stand-in for each arm, used ONLY when the 409 carried no prose.
 *
 * Deliberately shorter than the server's own sentences rather than a copy of
 * them: each says what is known (which bound bit, that nothing changed) and what
 * to do, and nothing about causes the SQLSTATE does not carry. `unfinished` in
 * particular must not blame the size of the corpus — it covers a timeout AND a
 * cancellation, and Postgres does not distinguish them, so an operator whose
 * statement was merely cancelled would be sent hunting a problem that does not
 * exist with the one correct remedy ruled out.
 */
const CONTENTION_FALLBACK: Record<SweepContention, string> = {
  "reconcile-lock":
    "The sweep could not start: another operation holds this workspace's reconcile lock — an " +
    "ingest pass, or a sweep already running. Nothing was changed. Retry in a few seconds.",
  "conflicting-lock":
    "The sweep could not finish: another operation holds a conflicting lock on this workspace's " +
    "facts, most often a publish or a correction. Nothing was changed. Retry in a few seconds, " +
    "and check whether maintenance is running if it persists.",
  unfinished:
    "The sweep's statement did not complete — either it expired or it was cancelled, and Postgres " +
    "does not distinguish the two. Nothing was changed. Retry once, and escalate to an operator " +
    "with the API service logs if it repeats.",
};

/** One outcome sentence plus the clauses that qualify it. */
export interface SweepOutcomeCopy {
  /** The headline: what the run did, in the operator's terms. */
  readonly headline: string;
  /**
   * The follow-on clauses, in the order they should be read.
   *
   * A list rather than one joined string so the panel can render each as its own
   * paragraph and a test can assert one arrived without matching across the
   * others.
   */
  readonly clauses: readonly string[];
  /**
   * Whether this run leaves work behind — `truncated`, or a `0` whose cause is
   * unidentified. Drives the panel's tone, and it is never `false` for a `0`.
   */
  readonly unresolved: boolean;
}

/**
 * The three causes of `{minted: 0}`, ordered by what an operator will have hit.
 *
 * The commonest first, and it is first because the route says so: a workspace
 * that has just started curating has a PENDING cardinality proposal, and a
 * pending proposal does not arm the sweep. That is the state the demonstration
 * of finish condition 4 was actually in, and a panel that listed "the corpus has
 * converged" first would send the operator to the wrong page.
 */
const ZERO_CAUSES: readonly string[] = [
  "No predicate in this workspace is curated single-valued AND approved. This is the commonest " +
    "reason, and a pending proposal does not count — check the Pending queue above and the " +
    "curated predicates in the In-force pane before reading this run as done.",
  "The corpus has already converged: every pair that today's vocabulary puts in one slot is " +
    "already flagged, so there was nothing left to mint.",
  "There are no live facts to compare — nothing retracted or superseded, nothing at all.",
];

/**
 * What to say about a run that completed.
 *
 * ⚠️ `minted: 0` is never phrased as an all-clear, and `unresolved` is `true` for
 * it. The number is genuine and the run genuinely happened; what is unknown is
 * WHICH of three facts produced it, and the sweep cannot tell you. Rendering
 * "nothing to flag" would answer a question the server explicitly declined to.
 */
export function sweepOutcome(report: {
  readonly minted: number;
  readonly truncated: boolean;
}): SweepOutcomeCopy {
  const clauses: string[] = [];

  if (report.minted === 0) {
    clauses.push(
      "A zero does not identify a cause. It is any of three things, and this run cannot tell you " +
        "which:",
      ...ZERO_CAUSES,
    );
    // Reachable: the run cap can bite on a sweep that wrote nothing, because the
    // cap counts what was CONSIDERED against the bound as well as what landed.
    // Rendered rather than assumed away, since "run it again" is the one
    // instruction that changes what a second run does.
    if (report.truncated) clauses.push(TRUNCATED_CLAUSE);
    return {
      headline: "The sweep ran and minted no new tension edges.",
      clauses,
      unresolved: true,
    };
  }

  clauses.push(
    "The write is additive and advisory: nothing was superseded, retracted, invalidated or " +
      "reordered, and no fact row was touched. Running it again does not duplicate these edges.",
    "To see WHAT was flagged, read the fact queue with its tension filter — this response " +
      "carries counts only, because the sweep is workspace-wide where every read on that " +
      "router is scoped to your own grants.",
  );
  if (report.truncated) clauses.push(TRUNCATED_CLAUSE);

  return {
    headline: `The sweep minted ${report.minted} advisory tension ${
      report.minted === 1 ? "edge" : "edges"
    }.`,
    clauses,
    unresolved: report.truncated,
  };
}

/**
 * The resume instruction, one spelling for both arms.
 *
 * "Run it again" is the whole content of `truncated`, and it must not read as
 * "it partly failed": the run cap biting is an ordinary bounded pass, and a
 * second run picks up where it stopped rather than repeating. Both the zero and
 * the non-zero arm can carry it, which is why it is a constant rather than a
 * sentence inside one branch.
 */
const TRUNCATED_CLAUSE =
  "⚠️ This run hit its own edge cap, so it stopped before it finished. Run it again to resume — " +
  "the next run picks up where this one stopped rather than repeating it, and this is not a " +
  "failure of the pass.";
