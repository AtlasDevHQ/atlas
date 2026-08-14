/**
 * `MALFORMED_CLAIM`'s OPERATOR-FACING warn payload (#5105, ADR-0037 §8).
 *
 * The line this file pins had no coverage anywhere — a repo-wide grep for the
 * message returned nothing, and `inheritedUnkeyed` appeared only in
 * `reconcile.ts` itself, before #5047 and after it.
 *
 * ## The one field with a data-exposure edge
 *
 * **`degenerateSurfaces` logs RAW CLAIM TEXT.** It is safe only while the
 * `cause === "degenerate-surface"` filter is correct: by construction such a
 * surface is separators and whitespace and carries no claim content, which is
 * exactly the argument the blank-trim guard one loop up makes when it logs
 * booleans instead of surfaces. Misclassify a `vocabulary-target` failure as
 * `degenerate-surface` and real subject or object text — a customer's claim,
 * verbatim — enters the log stream, where it is retained, shipped to whatever
 * aggregator the deployment uses, and not recallable.
 *
 * So the assertion that carries this file is not that `degenerateSurfaces`
 * contains the right thing. It is that on a `vocabulary-target` failure over a
 * REAL surface it is **empty** — the leak falsifier, and the reason #5105
 * exists. Everything else here is the classification that assertion depends on.
 *
 * ## Why the three-way `cause` needs pinning and not just reading
 *
 * `cause` decides which SUBSYSTEM an operator goes and fixes, and the three
 * answers name three different teams' problems: the producer, this workspace's
 * vocabulary table, and the target row of a row-copy. #5047's review found the
 * sibling gate in `correction.ts` branching on the failing POSITION instead of
 * its CAUSE — which told a human superseding with perfectly good text that
 * their replacement "normalizes away to nothing", on a request no retry could
 * satisfy. Same class of defect, one layer over; here it is a warn nobody was
 * reading rather than a 400 somebody was.
 *
 * The `inherited` arm's correctness also rests on a property of ANOTHER module:
 * `InheritedSlotValue` always supplies both subject and predicate, so
 * `inheritedSlot !== undefined && role !== "object"` cannot mislabel a
 * vocabulary failure as `inherited`. Nothing detects that property moving, so
 * the last case below asserts the shape it depends on rather than assuming it.
 *
 * ## MUTATIONS THIS CATCHES
 *
 * **Generated — see `packages/api/scripts/mutations/reconcile-logging.md`**,
 * from `packages/api/scripts/mutations/reconcile-logging.mutations.ts`:
 *
 *     cd packages/api && bun run scripts/mutate.ts scripts/mutations/reconcile-logging.mutations.ts
 *
 * No database needed — every case blocks in the preparation loop.
 *
 * The three numbers used to live here by hand (#5047); they are generated as of
 * #5061 and all three re-measured identical. Add a test here and the table is
 * stale until you regenerate.
 *
 * The position-vs-cause row is the argument for the multi-position case
 * existing at all: every single-cause test agrees with a position-based
 * classifier by coincidence, because in each of them the position and the cause
 * happen to line up.
 *
 * ## Why a separate file
 *
 * `acl-logging.test.ts`'s pattern, and its constraint: mocking the logger means
 * `mock.module`ing **every** value export of `@atlas/api/lib/logger` and then
 * importing the module under test DYNAMICALLY, so the mock is installed before
 * the import binds. That is process-wide, so it cannot share a file with suites
 * that want real logging. `reconcile.test.ts` deliberately uses no
 * `mock.module()` at all (see its header), which is why this is a sibling and
 * not a `describe` block over there.
 *
 * No database: every case blocks in the PREPARATION LOOP, above the
 * transaction, so the executor below never answers an identity question.
 */

import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test";

interface Captured {
  readonly payload: Record<string, unknown>;
  readonly message: string;
}

const warns: Captured[] = [];
const errors: Captured[] = [];

/**
 * Every value export of `lib/logger`, replaced.
 *
 * ⚠️ A PARTIAL mock is the trap this repo has recorded: `mock.module` replaces
 * the whole module, so any export left out becomes `undefined` and the module
 * under test throws on first use — which reads as a broken test rather than a
 * missing mock. The factory is SYNCHRONOUS, because an async one deadlocks
 * `bun:test`.
 */
void mock.module("@atlas/api/lib/logger", () => {
  const record = (sink: Captured[]) => (payload: unknown, message?: unknown) =>
    sink.push({
      payload: (payload ?? {}) as Record<string, unknown>,
      message: typeof message === "string" ? message : String(payload),
    });
  const capture = {
    error: record(errors),
    warn: record(warns),
    info: () => {},
    debug: () => {},
    level: "info",
  };
  return {
    createLogger: () => capture,
    getLogger: () => capture,
    setLogLevel: () => true,
    getRequestContext: () => undefined,
    withRequestContext: <T,>(_ctx: unknown, fn: () => T): T => fn(),
    redactPaths: [] as string[],
    scrubErrSerializer: (err: unknown) => err,
    scrubLogFormatter: (obj: unknown) => obj,
    hashShareToken: (token: string) => token,
    ACTOR_KINDS: ["human", "agent", "mcp", "scheduler", "api_key"] as const,
  };
});

type ReconcileModule = typeof import("@atlas/api/lib/brain/reconcile");
type IdentityModule = typeof import("@atlas/api/lib/brain/identity");

let reconcileFacts: ReconcileModule["reconcileFacts"];
let identityVocabulary: IdentityModule["identityVocabulary"];
let inheritSlotFromFactRow: IdentityModule["inheritSlotFromFactRow"];

beforeAll(async () => {
  // DYNAMIC, after the mock above is installed. A static import binds the real
  // logger before the factory runs and every assertion here reads an empty sink.
  ({ reconcileFacts } = await import("@atlas/api/lib/brain/reconcile"));
  ({ identityVocabulary, inheritSlotFromFactRow } = await import(
    "@atlas/api/lib/brain/identity"
  ));
});

afterEach(() => {
  warns.length = 0;
  errors.length = 0;
});

const WORKSPACE = "ws-5105";
const EPISODE = "ep-5105";
const PRODUCER = "extraction:v1";

/**
 * The transaction seam, answering as little as it can.
 *
 * Every REFUSED candidate is decided in the preparation loop, above the
 * transaction, so no statement here classifies anything — but a batch whose
 * candidates are all malformed still opens the transaction, so the runner has
 * to exist.
 *
 * The one answer it gives is an id for the fact insert, and only the control
 * case reaches it: `writeCandidate` throws on an insert that returns no id
 * (correctly — a silent `return` would report a fact that does not exist), so a
 * blanket `{ rows: [] }` turns "the healthy claim was NOT refused" into a
 * failure that reads like a defect in the guard. Every other statement still
 * answers nothing, which keeps the corroboration and tension lookups from
 * inventing a collision this file is in no position to assert about.
 */
const noopRunner = async <T,>(
  fn: (tx: { query: (sql: string) => Promise<{ rows: { id: string }[] }> }) => Promise<T>,
) =>
  fn({
    query: async (sql: string) => ({
      rows: sql.includes("INSERT INTO brain_facts")
        ? [{ id: "00000000-0000-4000-8000-0000000000ff" }]
        : [],
    }),
  });

function run(
  candidates: readonly { subject?: string; predicate?: string; object?: string; inheritedSlot?: unknown }[],
  vocabulary = identityVocabulary,
) {
  return reconcileFacts(
    {
      episode: {
        id: EPISODE,
        workspaceId: WORKSPACE,
        source: "slack",
        sourceId: "C01:1719000000.000100",
        sourceActor: "U123",
        occurredAt: new Date("2026-06-21T09:00:00.000Z"),
        visibleTo: ["org"],
      },
      candidates: candidates.map((c) => ({
        subject: "deploy window",
        predicate: "is",
        object: "Thursdays",
        ...c,
        // This cast IS load-bearing, unlike the one below it used to be: the
        // local `inheritedSlot?: unknown` is deliberately WIDER than
        // `InheritedSlot`, so the cases here can drive the runtime narrowing.
      })) as Parameters<typeof reconcileFacts>[0]["candidates"],
      producer: PRODUCER,
      extractedAt: new Date("2026-06-21T10:00:00.000Z"),
      vocabulary,
    },
    // No cast on `withTransaction`: `noopRunner` is assignable to
    // `ReconcileTransactionRunner` as written, and a cast that is not
    // load-bearing is worse than none — it would absorb a genuine future
    // incompatibility in that type silently.
    {
      withTransaction: noopRunner,
      now: () => new Date("2026-06-21T10:00:01.000Z"),
    },
  );
}

/** The one `MALFORMED_CLAIM` warn, refused if there is not exactly one. */
function theWarn(): Captured {
  const malformed = warns.filter((w) => w.message.includes("no identity for one or more slots"));
  expect(
    malformed,
    "expected exactly one MALFORMED_CLAIM warn — zero means the line was deleted or the " +
      "candidate was not refused at all, and more than one means the assertions below are " +
      "reading an arbitrary member of a set",
  ).toHaveLength(1);
  return malformed[0]!;
}

describe("the MALFORMED_CLAIM warn payload (#5105)", () => {
  it("a degenerate OBJECT surface: cause `degenerate-surface`, and the surface IS logged", async () => {
    // `-` clears the blank-trim guard — `String#trim` strips whitespace but not
    // `_` or `-` — and reaches the identity guard with a null key. This is the
    // one cause whose surface is safe to log, and the payload is what sends the
    // operator to the PRODUCER rather than to the vocabulary table.
    await run([{ object: "-" }]);

    const { payload } = theWarn();
    expect(payload.unkeyed).toEqual([{ role: "object", cause: "degenerate-surface" }]);
    expect(payload.degenerateSurfaces).toEqual([{ role: "object", surface: "-" }]);
    // Not the target's fault, and not a copy: an ordinary extracted candidate
    // carries no inherited slot at all.
    expect(payload.inheritedUnkeyed).toEqual([]);
    expect(payload.inheritedFrom).toBeNull();
    // The correlation fields, without which the line names no episode to go and
    // look at.
    expect(payload).toMatchObject({
      workspaceId: WORKSPACE,
      episodeId: EPISODE,
      producer: PRODUCER,
    });
  });

  it("⭐ a VOCABULARY-TARGET failure over a real surface logs NO surface — the leak falsifier", async () => {
    // ⚠️ THE ASSERTION THIS FILE EXISTS FOR.
    //
    // `slotKey` is `identityKey(alias(identityKey(surface)))`, so a null key
    // has a second cause that has nothing to do with the text: this workspace's
    // vocabulary maps a real norm to something that normalizes away. The
    // surface here — `"ships on"` — is a perfectly good claim slot. It is
    // customer text.
    //
    // If the `cause === "degenerate-surface"` filter on `degenerateSurfaces`
    // ever widens (dropped, inverted, or written over the POSITION instead of
    // the CAUSE), that text lands in the log stream, gets shipped to whatever
    // aggregator the deployment uses, and is not recallable. Nothing else in
    // the repo would notice.
    //
    // Both halves are asserted deliberately: `cause` proves the classification
    // reached `vocabulary-target` (so the case is really exercising this arm
    // and not silently degenerating), and the empty `degenerateSurfaces` is the
    // leak assertion itself. Either alone can be satisfied by a defect.
    const mapsAway = (norm: string) => (norm === "ships on" ? "-" : norm);
    await run([{ predicate: "ships on" }], { ...identityVocabulary, predicate: mapsAway });

    const { payload } = theWarn();
    expect(payload.unkeyed).toEqual([{ role: "predicate", cause: "vocabulary-target" }]);
    expect(
      payload.degenerateSurfaces,
      "a claim's REAL text reached the log stream. `degenerateSurfaces` is safe only while it " +
        "is filtered to `degenerate-surface`, whose surfaces are separators and whitespace by " +
        "construction; a vocabulary-target surface is customer content and must stay out.",
    ).toEqual([]);
    expect(payload.inheritedUnkeyed).toEqual([]);
  });

  it("…and the surface is not smuggled in through any other field of that payload", async () => {
    // The wider version of the same question, and the one that survives a
    // future field being added beside `degenerateSurfaces`. `unkeyed` carries
    // roles and causes, `inheritedUnkeyed` carries roles, `inheritedFrom`
    // carries a fact id — none of them is a channel for claim text, and the
    // cheapest way to keep that true is to search the whole serialized payload.
    const secret = "acme corp quarterly revenue";
    const mapsAway = (norm: string) => (norm === secret ? "-" : norm);
    await run([{ subject: secret }], { ...identityVocabulary, subject: mapsAway });

    const { payload } = theWarn();
    expect(payload.unkeyed).toEqual([{ role: "subject", cause: "vocabulary-target" }]);
    expect(
      JSON.stringify(payload),
      `the claim's subject text reached the warn payload through a field other than ` +
        "`degenerateSurfaces`",
    ).not.toContain(secret);
  });

  it("an INHERITED null slot: cause `inherited`, at BOTH copied positions", async () => {
    // The row-copy channel (#5037). The slot is copied off the target row
    // rather than derived from any surface in this candidate, so an operator
    // sent to inspect this claim's text would find nothing wrong with it — the
    // TARGET row is what has no identity, and `inheritedFrom` names it.
    //
    // Post-0194 the key columns are `NOT NULL`, so this cannot come off the
    // database any more; it survives as a diagnostic for a hand-built slot and
    // for the deploy overlap, where an N-1 instance's rows are still unkeyed.
    const target = "00000000-0000-4000-8000-000000000042";
    await run([
      {
        inheritedSlot: inheritSlotFromFactRow({
          id: target,
          subject_key: null,
          predicate_key: null,
        }),
      },
    ]);

    const { payload } = theWarn();
    // BOTH positions, and the order is the slot order. This is the assertion
    // that pins the property `InheritedSlotValue` supplies and this arm depends
    // on: it always carries subject AND predicate, which is what makes
    // `inheritedSlot !== undefined && role !== "object"` unable to mislabel a
    // vocabulary failure as `inherited`. If that ever narrows to one position,
    // this is what says so.
    expect(payload.unkeyed).toEqual([
      { role: "subject", cause: "inherited" },
      { role: "predicate", cause: "inherited" },
    ]);
    expect(payload.inheritedUnkeyed).toEqual(["subject", "predicate"]);
    expect(payload.inheritedFrom).toBe(target);
    // Nothing about this claim's own text is at fault, so nothing is logged
    // from it.
    expect(payload.degenerateSurfaces).toEqual([]);
  });

  it("the OBJECT of an inherited candidate is never `inherited` — it is derived from its own text", async () => {
    // ⚠️ The discriminator #5047's comment is emphatic about, and the one a
    // reader is most likely to get wrong. `inheritedFrom` is set for EVERY
    // correction-produced candidate, but only the SUBJECT and PREDICATE are
    // copied — the object is always derived from the replacement's own text.
    //
    // So a human superseding with `"-"` lands here with a healthy inherited
    // slot and a degenerate object, and a payload keyed on `inheritedFrom`
    // alone would send the operator to inspect a target row that is perfectly
    // fine. The cause must say `degenerate-surface` and `inheritedUnkeyed`
    // must be EMPTY even though `inheritedFrom` is not null.
    await run([
      {
        object: "-",
        inheritedSlot: inheritSlotFromFactRow({
          id: "00000000-0000-4000-8000-000000000043",
          subject_key: "deploy window",
          predicate_key: "is",
        }),
      },
    ]);

    const { payload } = theWarn();
    expect(payload.unkeyed).toEqual([{ role: "object", cause: "degenerate-surface" }]);
    expect(
      payload.inheritedUnkeyed,
      "the object was reported as inherited — it never is, and a message keyed on that would " +
        "blame a target row with nothing wrong with it",
    ).toEqual([]);
    // Non-null, and that is the point: `inheritedFrom` alone is NOT the
    // discriminator, and this pairing is what proves the payload distinguishes
    // the two.
    expect(payload.inheritedFrom).toBe("00000000-0000-4000-8000-000000000043");
    expect(payload.degenerateSurfaces).toEqual([{ role: "object", surface: "-" }]);
  });

  it("classifies each position independently when two fail for different reasons", async () => {
    // One claim, two causes: a degenerate subject and a vocabulary-mapped-away
    // predicate. A classifier that decided per ROW rather than per POSITION
    // passes every single-cause case above and fails only here — and it would
    // put the real predicate text into `degenerateSurfaces` if it collapsed the
    // other way, which is the leak again, reached from a direction the
    // dedicated falsifier does not cover.
    const mapsAway = (norm: string) => (norm === "ships on" ? "___" : norm);
    await run([{ subject: "___", predicate: "ships on" }], {
      ...identityVocabulary,
      predicate: mapsAway,
    });

    const { payload } = theWarn();
    expect(payload.unkeyed).toEqual([
      { role: "subject", cause: "degenerate-surface" },
      { role: "predicate", cause: "vocabulary-target" },
    ]);
    // ONLY the degenerate one. The predicate's real text stays out.
    expect(payload.degenerateSurfaces).toEqual([{ role: "subject", surface: "___" }]);
  });

  it("the message names all three causes, so the payload is readable without the source", async () => {
    // The line is what an operator holds at 3am. `cause` is a bare enum, and a
    // message that rendered it without saying what each value means would send
    // them to the source of `reconcile.ts` to decode their own alert.
    await run([{ object: "-" }]);

    const { message } = theWarn();
    for (const cause of ["degenerate-surface", "vocabulary-target", "inherited"]) {
      expect(message, `the warn message stopped naming the \`${cause}\` cause`).toContain(cause);
    }
  });

  it("a healthy claim produces no MALFORMED_CLAIM warn at all", async () => {
    // The control. Every assertion above is about the CONTENT of a line, so a
    // guard that fired on everything would satisfy all of them — this is the
    // only test that says the line is conditional.
    const report = await run([{}]);

    // ⚠️ THE CLAIM IS CREATED, asserted before the absence. Measured: forcing
    // the grant screen — which sits ABOVE the identity guard — to refuse every
    // candidate kills 7 of this file's 8 tests, and this control was the
    // survivor. An absence assertion alone cannot tell "the warn is
    // conditional" from "the pipeline never reached the guard", so any future
    // change that blocks the healthy claim earlier would leave this green while
    // deleting the file's premise.
    expect(report.outcomes[0]).toMatchObject({ kind: "created" });
    expect(warns.filter((w) => w.message.includes("no identity for one or more slots"))).toHaveLength(0);
  });
});
