import { describe, expect, test, afterEach, beforeEach, mock } from "bun:test";
import { render, cleanup, fireEvent, waitFor, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { AtlasProvider, type AtlasAuthClient } from "@/ui/context";

/**
 * The UNPREFILLED direction, and the interlock around it (#5088).
 *
 * ## Why this is a safety property rather than a UX nicety
 *
 * `A → B` and `B → A` re-key OPPOSITE row sets and have different blast radii.
 * The server refuses an undirected approval that supplies no direction
 * (`direction-required`), and the route is falsified for sending none — but
 * neither of those can see the half that lives here: **a UI that preselects one
 * ordering satisfies the server's refusal with a value nobody chose.** Every
 * server-side check passes, and the approver's click applies a machine opinion
 * dressed as their decision.
 *
 * Three things have to hold, and each fails silently on its own:
 *
 *   1. **Nothing is selected** on an undirected proposal. Not the stored pair,
 *      which is *"the pair in the order it arrived"*, and not the more populous
 *      ordering — the obvious heuristic points BACKWARDS during exactly the
 *      migration this feature performs, because a newly-adopted canonical
 *      spelling is rarer than the sloppy one it replaces.
 *   2. **Approve stays disabled** until an ordering is picked AND its own blast
 *      radius has come back. Two independent gates; either alone leaves a live
 *      button beside an unevidenced pick.
 *   3. **Each ordering previews SEPARATELY.** One shared slot would let the
 *      preview for `A → B` gate an approval of `B → A`.
 *
 * A DIRECTED proposal is the fourth case: its alternative is still shown, greyed
 * and with its own preview affordance — allowlist direction is evidence, not
 * authority — but it cannot be chosen, because the seam refuses a flip at
 * approval and offering it would be a button that always 409s.
 */

void mock.module("next/navigation", () => ({
  usePathname: () => "/admin/brain/vocabulary",
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const stubAuthClient: AtlasAuthClient = {
  signIn: { email: async () => ({}) },
  signUp: { email: async () => ({}) },
  signOut: async () => {},
  useSession: () => ({ data: null, isPending: false }),
};

const COUNTS = {
  position: "predicate",
  scope: "unscoped",
  total: 1,
  scoped: 1,
  withheld: 0,
  countsConsistent: true,
};

const STRUCTURAL_EVIDENCE = {
  kind: "structural",
  subjects: 2,
  scopedSubjects: 2,
  withheld: 0,
  examples: [
    {
      subject: "widget",
      object: "10 USD",
      fromPredicate: "is priced at",
      toPredicate: "priced at",
    },
  ],
  threshold: 2,
  countsConsistent: true,
};

const aliasEntry = (over: Record<string, unknown> = {}) => ({
  kind: "alias",
  id: "proposal-7",
  position: "predicate",
  pair: ["is priced at", "priced at"],
  direction: null,
  sourceClass: "seam",
  proposedBy: "brain:alias-proposal",
  proposedAt: "2026-08-09T00:00:00.000Z",
  rank: 0.67,
  evidence: STRUCTURAL_EVIDENCE,
  ...over,
});

const cardinalityEntry = (over: Record<string, unknown> = {}) => ({
  kind: "cardinality",
  predicateSurface: "reports to",
  cardinality: "single",
  sourceClass: "correction_event",
  proposedBy: "brain:correction-event-cardinality",
  proposedAt: "2026-08-08T00:00:00.000Z",
  claims: 12,
  evidence: {
    kind: "behavioral",
    subjects: 3,
    events: 4,
    scopedSubjects: 3,
    withheld: 0,
    examples: [
      {
        subject: "widget",
        fromObject: "Bob",
        toObject: "Carol",
        factId: "fact-1",
        at: "2026-08-01T00:00:00.000Z",
      },
    ],
    threshold: 3,
    countsConsistent: true,
  },
  ...over,
});

let queueEntries: unknown[] = [aliasEntry()];
const previewBodies: string[] = [];
const decideBodies: string[] = [];
/**
 * When set, `/preview` waits on this before answering.
 *
 * ⚠️ Without it the second gate is UNOBSERVABLE: the stub resolves
 * synchronously, so there is no window between "an ordering was picked" and
 * "its radius arrived" — and reducing the gate to `chosen !== null` passed all
 * eleven tests. Measured.
 */
let holdPreview: Promise<void> | null = null;
/** Whether `/preview` fails, so the third arm of the gate is reachable. */
let previewFails = false;
/** Whether `/pending` fails, so the failed-vs-empty card is reachable. */
let pendingFails = false;
/** Whether `/preview` answers 200 with a body the schema refuses. */
let previewReturnsGarbage = false;
/** How `/decide` answers: normally, unparseably, or as a lost race. */
let decideMode: "ok" | "non-json" | "extra-key" | "nothing" = "ok";
/** Per-test overrides for the disclosure branches every default fixture turns off. */
let countsOverride: Record<string, unknown> | null = null;
let truncatedOverride = false;
let incompleteOverride = false;
/**
 * Whether `/pending` answers `cardinalityCounts: null` — the queue never asked
 * the cardinality question.
 *
 * ⚠️ Its own switch rather than folded into {@link countsOverride}, because
 * `null` is not a count with different numbers in it. It is the ABSENCE of the
 * question, and the empty state says something different for it than for a
 * withheld row.
 */
let cardinalityCountsNull = false;
/**
 * Whether `/pending` answers `aliasCounts: []` — the ALIAS half was never asked.
 *
 * ⚠️ A second switch beside {@link cardinalityCountsNull} because the response
 * encodes one fact two ways, and that asymmetry is itself the defect under test:
 * `null` for one half, an empty array for the other.
 */
let aliasCountsEmpty = false;

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const originalFetch = globalThis.fetch;

/**
 * Installed in `beforeEach`, not at module scope — the harness's happy-dom
 * preload resets globals after this module evaluates, so a top-level assignment
 * is silently undone and every fetch reaches the real network.
 */
function installFetchStub() {
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/brain-vocabulary/pending")) {
      if (pendingFails) {
        return Promise.resolve(
          jsonResponse({ error: "server_error", message: "the queue blew up" }, 500),
        );
      }
      return Promise.resolve(
        jsonResponse({
          entries: queueEntries,
          aliasCounts: aliasCountsEmpty ? [] : [countsOverride ?? COUNTS],
          cardinalityCounts: cardinalityCountsNull ? null : { ...COUNTS, total: 0, scoped: 0 },
          truncated: truncatedOverride,
          incomplete: incompleteOverride,
        }),
      );
    }
    if (url.includes("/brain-vocabulary/preview")) {
      previewBodies.push(String(init?.body ?? ""));
      if (previewFails) {
        return Promise.resolve(jsonResponse({ error: "server_error", message: "boom" }, 500));
      }
      if (previewReturnsGarbage) {
        // A 200 the schema refuses — the shape `useAdminMutation` hands back as
        // `data: undefined`, which the old `?? null` swallowed entirely.
        return Promise.resolve(jsonResponse({ unexpected: true }));
      }
      const held = holdPreview;
      if (held !== null) {
        holdPreview = null;
        return held.then(() =>
          jsonResponse({
            radius: {
              kind: "computed",
              targetCardinality: { kind: "not-asked" },
              arming: { total: 2, pairs: [], withheld: 0, truncated: false, countsConsistent: true },
              disarming: { total: 0, pairs: [], withheld: 0, truncated: false, countsConsistent: true },
              floor: true,
              subtreeTruncated: false,
            },
          }),
        );
      }
      return Promise.resolve(
        jsonResponse({
          radius: {
            kind: "computed",
            targetCardinality: { kind: "not-asked" },
            arming: { total: 2, pairs: [], withheld: 0, truncated: false, countsConsistent: true },
            disarming: { total: 0, pairs: [], withheld: 0, truncated: false, countsConsistent: true },
            floor: true,
            subtreeTruncated: false,
          },
        }),
      );
    }
    if (url.includes("/brain-vocabulary/decide")) {
      decideBodies.push(String(init?.body ?? ""));
      if (decideMode === "non-json") {
        // A 2xx whose content-type is not JSON — `useAdminMutation` resolves
        // `{ ok: true, data: undefined }` for this, which is the shape the old
        // `?? ""` turned into the strongest success string.
        return Promise.resolve(
          new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }),
        );
      }
      if (decideMode === "extra-key") {
        // Valid JSON the STRICT schema refuses — pins `safeParse` rather than
        // only the `undefined` check.
        return Promise.resolve(
          jsonResponse({ outcome: "approved", proposalId: "p", removedEdge: false }),
        );
      }
      if (decideMode === "nothing") {
        return Promise.resolve(
          jsonResponse({ outcome: "nothing_to_decide", proposalId: null }),
        );
      }
      return Promise.resolve(
        // ⚠️ No `removedEdge` — the union carries it on the `rejected` arm only,
        // and the client PARSES this body now, so an invented field would be
        // refused by `z.strictObject` rather than silently ignored.
        jsonResponse({ outcome: "approved", proposalId: "proposal-7" }),
      );
    }
    return Promise.resolve(jsonResponse({}));
  }) as unknown as typeof fetch;
}

const { PendingQueue } = await import("../pending-queue");

let testQueryClient: QueryClient;

function Wrapper({ children }: { children: ReactNode }) {
  return createElement(
    NuqsAdapter,
    null,
    createElement(
      QueryClientProvider,
      { client: testQueryClient },
      createElement(AtlasProvider, {
        config: {
          apiUrl: "http://localhost:3001",
          isCrossOrigin: false as const,
          authClient: stubAuthClient,
        },
        children,
      }),
    ),
  );
}

function renderQueue() {
  testQueryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(createElement(PendingQueue), { wrapper: Wrapper });
}

/**
 * `.disabled` on the element, not a `toBeDisabled()` matcher — this harness does
 * not load jest-dom, and that matcher is `undefined` there rather than failing
 * loudly, so an assertion written against it throws a TypeError instead of
 * asserting anything.
 */
function approveButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /^Approve$/ }) as HTMLButtonElement;
}

beforeEach(() => {
  installFetchStub();
  queueEntries = [aliasEntry()];
  previewBodies.length = 0;
  decideBodies.length = 0;
  holdPreview = null;
  previewFails = false;
  pendingFails = false;
  previewReturnsGarbage = false;
  decideMode = "ok";
  countsOverride = null;
  truncatedOverride = false;
  incompleteOverride = false;
  cardinalityCountsNull = false;
  aliasCountsEmpty = false;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("an UNDIRECTED proposal offers both orderings and preselects neither", () => {
  test("⚠️ nothing is chosen, and Approve is disabled", async () => {
    renderQueue();
    await waitFor(() => expect(screen.getByText(/Direction — not yet chosen/)).toBeTruthy());

    // Both orderings are offered as pickable...
    const choose = screen.getAllByRole("button", { name: /Choose this/ });
    expect(choose).toHaveLength(2);
    // ...and neither is marked chosen, so there is nothing to prefill FROM.
    expect(screen.queryByRole("button", { name: /^Chosen$/ })).toBeNull();
    expect(approveButton().disabled).toBe(true);
    // The reason is stated rather than left as an inert button.
    expect(screen.getByText(/Pick a direction/)).toBeTruthy();
    // ⚠️ And no preview has been requested. A list that eagerly previewed both
    // orderings would run two workspace-wide scans per row on page load; the AC
    // asks for the second one lazily, on expand.
    expect(previewBodies).toHaveLength(0);
  });

  test("⚠️ picking one is still not enough — its own preview has to come back", async () => {
    // ⚠️ The preview is HELD, and that is the whole test. Without the hold there
    // is no window in which the second gate is observable, and reducing
    // `chosen !== null && radius !== null && error === null` to `chosen !== null`
    // passed every assertion in this file. Measured.
    let release!: () => void;
    holdPreview = new Promise<void>((resolve) => {
      release = resolve;
    });

    renderQueue();
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Choose this/ }).length).toBe(2));
    fireEvent.click(screen.getAllByRole("button", { name: /Choose this/ })[0]!);

    // The pick loads THAT ordering's radius, and only that one.
    await waitFor(() => expect(previewBodies.length).toBeGreaterThan(0));
    expect(previewBodies).toHaveLength(1);
    const body = JSON.parse(previewBodies[0]!) as { fromNorm: string; toNorm: string };
    expect(body.fromNorm).toBe("is priced at");
    expect(body.toNorm).toBe("priced at");

    // A direction IS chosen and Approve is still refused — the second gate.
    expect(screen.getByRole("button", { name: /^Chosen$/ })).toBeTruthy();
    expect(approveButton().disabled).toBe(true);

    release();
    await waitFor(() => expect(approveButton().disabled).toBe(false));
  });

  test("⚠️ a preview that FAILED does not arm Approve either", async () => {
    // The third arm of the same gate, and the one the removal dialog shipped
    // broken in #5087: the button stayed live beside "the blast radius could not
    // be computed … unknown — not zero".
    previewFails = true;
    renderQueue();
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Choose this/ }).length).toBe(2));
    fireEvent.click(screen.getAllByRole("button", { name: /Choose this/ })[0]!);
    await waitFor(() => expect(previewBodies.length).toBe(1));
    await waitFor(() =>
      expect(screen.getByText(/could not be computed/)).toBeTruthy(),
    );
    expect(approveButton().disabled).toBe(true);
  });

  test("⚠️ the two orderings preview SEPARATELY — one slot cannot gate the other", async () => {
    // A shared slot would let the radius computed for `A → B` satisfy the gate
    // for an approval of `B → A`: a number about the opposite re-key, arming the
    // interlock that exists to stop exactly that.
    renderQueue();
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^Preview$/ }).length).toBe(2));
    fireEvent.click(screen.getAllByRole("button", { name: /^Preview$/ })[1]!);
    await waitFor(() => expect(previewBodies.length).toBe(1));
    const reverse = JSON.parse(previewBodies[0]!) as { fromNorm: string; toNorm: string };
    expect(reverse.fromNorm).toBe("priced at");
    expect(reverse.toNorm).toBe("is priced at");

    // Previewing the REVERSE does not arm Approve, because nothing is chosen.
    expect(approveButton().disabled).toBe(true);

    // Choosing the FORWARD ordering issues its own preview rather than reusing
    // the one already on screen.
    fireEvent.click(screen.getAllByRole("button", { name: /Choose this/ })[0]!);
    await waitFor(() => expect(previewBodies.length).toBe(2));
    const forward = JSON.parse(previewBodies[1]!) as { fromNorm: string; toNorm: string };
    expect(forward.fromNorm).toBe("is priced at");
  });

  test("the chosen ordering is what the decide request carries", async () => {
    renderQueue();
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Choose this/ }).length).toBe(2));
    // The SECOND ordering — reverse of the stored pair, so a route that fell
    // back to `pair` would send the wrong one and this assertion would catch it.
    fireEvent.click(screen.getAllByRole("button", { name: /Choose this/ })[1]!);
    await waitFor(() => expect(approveButton().disabled).toBe(false));
    fireEvent.click(approveButton());
    await waitFor(() => expect(decideBodies.length).toBe(1));
    const body = JSON.parse(decideBodies[0]!) as {
      direction: { fromNorm: string; toNorm: string };
    };
    expect(body.direction).toEqual({ fromNorm: "priced at", toNorm: "is priced at" });
  });

  test("REJECT needs no direction and no preview", async () => {
    // A rejection changes nothing about the corpus, so gating it on a blast
    // radius would be ceremony — and `AliasDecisionRequest` makes a direction
    // unrepresentable on that arm anyway.
    renderQueue();
    await waitFor(() => expect(screen.getByRole("button", { name: /^Reject$/ })).toBeTruthy());
    const reject = screen.getByRole("button", { name: /^Reject$/ }) as HTMLButtonElement;
    expect(reject.disabled).toBe(false);
    fireEvent.click(reject);
    await waitFor(() => expect(decideBodies.length).toBe(1));
    const body = JSON.parse(decideBodies[0]!) as Record<string, unknown>;
    expect(body.decision).toBe("rejected");
    expect(body.direction).toBeUndefined();
  });
});

describe("a DIRECTED proposal shows the alternative without offering it", () => {
  beforeEach(() => {
    queueEntries = [
      aliasEntry({
        direction: { fromNorm: "is priced at", toNorm: "priced at" },
        sourceClass: "warehouse_key",
      }),
    ];
  });

  test("⚠️ the alternative is rendered with its own preview affordance, and is NOT selectable", async () => {
    renderQueue();
    await waitFor(() =>
      expect(screen.getByText(/Direction \(claimed by the producer\)/)).toBeTruthy(),
    );
    // The producer's claim is preselected — here that IS the evidence, and the
    // approver is confirming rather than choosing.
    expect(screen.getByRole("button", { name: /^Chosen$/ })).toBeTruthy();
    // Exactly ONE ordering is choosable: the seam refuses a flip at approval, so
    // offering the other would be a button that always 409s.
    expect(screen.queryAllByRole("button", { name: /Choose this/ })).toHaveLength(0);
    // ...but the alternative is still SHOWN with its own preview, because
    // allowlist direction is evidence and not authority, and an approver
    // overriding it should see what they are overriding.
    expect(screen.getAllByRole("button", { name: /^Preview$/ }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/not available/)).toBeTruthy();
    expect(screen.getByText(/reject this proposal and author the edge you want/i)).toBeTruthy();
  });
});

describe("the two evidence models are rendered differently and never as a bare N", () => {
  test("⚠️ each magnitude carries its unit as a phrase", async () => {
    queueEntries = [aliasEntry(), cardinalityEntry()];
    renderQueue();
    await waitFor(() => expect(screen.getByText(/Curated predicate/)).toBeTruthy());
    const text = document.body.textContent ?? "";

    // The alias unit: distinct subjects whose claims AGREE.
    expect(text).toContain("2 distinct subjects");
    expect(text).toContain("agree about the object under both spellings");

    // ⚠️ The cardinality unit, and the issue's own shorthand for it is WRONG:
    // the gate is `COUNT(DISTINCT subject_key)`, not a count of corrections. So
    // the sentence leads with the subjects that crossed the bar and carries the
    // event count beside it, rather than naming a number no gate reads.
    expect(text).toContain("3 distinct subjects");
    expect(text).toContain("across 4 corrections");
    expect(text).toContain("repeated edits to one subject count once");

    // Both thresholds are stated, so neither number is read against the wrong
    // bar — and neither appears in a shared column an approver could compare.
    expect(text).toContain("raises a proposal at 2");
    expect(text).toContain("raises a proposal at 3 subjects");
  });

  test("the kinds are distinguishable at a glance, by consequence", async () => {
    queueEntries = [aliasEntry(), cardinalityEntry()];
    renderQueue();
    await waitFor(() => expect(screen.getByText(/Curated predicate/)).toBeTruthy());
    const text = document.body.textContent ?? "";
    // An alias MOVES A POPULATION between slots.
    expect(text).toContain("into the other’s slot");
    // A cardinality flip ARMS SUPERSESSION for every future claim.
    expect(text).toContain("every future claim");
    expect(text).toContain("retroactively");
  });

  test("⚠️ the disclosure branches render — withheld, disagreed, below-threshold, truncated", async () => {
    // Every fixture above turns these OFF, so five branches were unrendered by
    // any test: the withheld sentence, the counts-disagreed sentence, the
    // "reads below the bar that raised it" clause, the withheld badge and the
    // truncation notice. The below-threshold clause is the one worth naming —
    // the whole "evidence is RE-DERIVED, so an entry can read below its own
    // gate" argument exists for that sentence.
    queueEntries = [
      aliasEntry({
        evidence: {
          ...STRUCTURAL_EVIDENCE,
          subjects: 1,
          scopedSubjects: 0,
          withheld: 1,
          examples: [],
          countsConsistent: false,
        },
      }),
    ];
    countsOverride = { ...COUNTS, total: 5, scoped: 1, withheld: 4, countsConsistent: false };
    truncatedOverride = true;
    renderQueue();
    await waitFor(() => expect(screen.getByText(/Alias/)).toBeTruthy());
    const text = document.body.textContent ?? "";
    expect(text).toContain("reads below the bar that raised it");
    expect(text).toContain("cannot read");
    expect(text).toContain("treat them as approximate");
    expect(text).toContain("4 withheld");
    expect(text).toContain("counts disagreed");
    expect(text).toContain("More proposals are awaiting a decision");
  });

  test("⚠️ a DROPPED row is not reported as reachable by filtering", async () => {
    // Two facts, two remedies. One boolean made the client state the filtering
    // remedy for a row no filter reaches.
    incompleteOverride = true;
    renderQueue();
    await waitFor(() => expect(screen.getByText(/not listed here at all/)).toBeTruthy());
    expect(document.body.textContent ?? "").toContain("fault on Atlas");
  });

  test("an entity-position proposal reports its evidence as unaskable, not as zero", async () => {
    queueEntries = [
      aliasEntry({
        position: "subject",
        pair: ["project atlas", "nova"],
        evidence: { kind: "not-applicable", reason: "entity-position" },
      }),
    ];
    renderQueue();
    await waitFor(() => expect(screen.getByText(/Alias/)).toBeTruthy());
    const text = document.body.textContent ?? "";
    expect(text).toContain("cannot be asked at this position");
    expect(text).toContain("not the same as none being found");
    // ⚠️ No count at all on this branch — "0 subjects agree" and "this evidence
    // cannot exist here" are the same number and opposite facts.
    expect(text).not.toContain("0 distinct subject");
  });

  test("⚠️ the cardinality Approve is gated on its own preview too", async () => {
    // The STRICTER of the two gates on the page — this decision is retroactive —
    // and nothing measured it: reducing it to `decideMutation.saving` passed
    // every test in this file.
    queueEntries = [cardinalityEntry()];
    renderQueue();
    await waitFor(() => expect(screen.getByText(/Curated predicate/)).toBeTruthy());
    expect(approveButton().disabled).toBe(true);
    expect(screen.getByText(/Preview first/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Preview the impact/ }));
    await waitFor(() => expect(approveButton().disabled).toBe(false));
  });

  test("a cardinality entry with no addressable surface says so instead of offering a button", async () => {
    queueEntries = [cardinalityEntry({ predicateSurface: null })];
    renderQueue();
    await waitFor(() => expect(screen.getByText(/Curated predicate/)).toBeTruthy());
    expect(screen.queryByRole("button", { name: /^Approve$/ })).toBeNull();
    expect(document.body.textContent ?? "").toContain("has no");
    expect(document.body.textContent ?? "").toContain("cannot be decided from here");
  });
});

describe("⚠️ a decide body Atlas could not read is never reported as the verb pressed", () => {
  async function approveOnce(): Promise<void> {
    renderQueue();
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Choose this/ }).length).toBe(2));
    fireEvent.click(screen.getAllByRole("button", { name: /Choose this/ })[0]!);
    await waitFor(() => expect(approveButton().disabled).toBe(false));
    fireEvent.click(approveButton());
  }

  test("a NON-JSON 200 says `could not confirm`, not `re-keyed`", async () => {
    // `use-admin-mutation` resolves `{ ok: true, data: undefined }` for a 204 or
    // any 2xx that does not declare JSON — a proxy, an HTML error page — and the old
    // `result.data?.outcome ?? ""` fell through every branch into "every
    // affected claim has been re-keyed" for a body nobody read.
    decideMode = "non-json";
    await approveOnce();
    await waitFor(() => expect(screen.getByText(/could not confirm/)).toBeTruthy());
    expect(document.body.textContent ?? "").not.toContain("has been re-keyed");
  });

  test("a STRICT-schema violation does too — the parse is what runs, not a null check", async () => {
    // Valid JSON with an extra key. A guard written as `data === undefined`
    // would pass this straight through; `safeParse` against `z.strictObject`
    // is what actually refuses it.
    decideMode = "extra-key";
    await approveOnce();
    await waitFor(() => expect(screen.getByText(/could not confirm/)).toBeTruthy());
    expect(document.body.textContent ?? "").not.toContain("has been re-keyed");
  });

  test("⚠️ …and the schema ISSUES are logged, not dropped on the floor", async () => {
    // A `safeParse` guard that emits nothing is a catch that emits nothing. The
    // server's own `checked()` parsed this body successfully against ITS copy of
    // the schema, so a rename between `@useatlas/schemas` and the deployed API
    // produces a 200 that is correct server-side, an approver reading "could not
    // confirm", and — without this — an empty console. `issues[0].path` is the
    // only artefact that names the offending field, and this body describes a
    // decide transaction that has already COMMITTED.
    const warnings: unknown[][] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      decideMode = "extra-key";
      await approveOnce();
      await waitFor(() => expect(screen.getByText(/could not confirm/)).toBeTruthy());
      const decideWarn = warnings.find((w) => String(w[0]).includes("decide response failed"));
      expect(decideWarn, "the decide safeParse failure was silent").toBeTruthy();
      // ⚠️ The ISSUES, not just a message. A log line that says "it failed"
      // without saying which field is the same dead end as no log line.
      expect(JSON.stringify(decideWarn?.[1] ?? null)).toContain("removedEdge");
    } finally {
      console.warn = realWarn;
    }
  });

  test("⚠️ a LOST RACE is reported as itself, never as the approval", async () => {
    // `nothing_to_decide` is a truthful 200 — somebody else decided it, or one
    // is in flight — and telling this approver "approved" would credit them with
    // a workspace-wide re-key they did not cause. The route half is pinned;
    // replacing this client branch with `if (false)` left every test green.
    decideMode = "nothing";
    await approveOnce();
    await waitFor(() => expect(screen.getByText(/had already been decided/)).toBeTruthy());
    expect(document.body.textContent ?? "").not.toContain("has been re-keyed");
  });

  test("POSITIVE CONTROL — a parseable approval still reports the re-key", async () => {
    await approveOnce();
    await waitFor(() => expect(screen.getByText(/has been re-keyed/)).toBeTruthy());
  });
});

describe("⚠️ …and the CARDINALITY half gets the same three arms, not just the alias half", () => {
  // The panel's round-3 finding, and the pattern it named across this whole
  // diff: the alias row's `readDecideOutcome === null` arm is falsified three
  // ways above, and its cardinality twin — whose own comment says *"this one
  // arms RETROACTIVE supersession"* — had none of them. Replacing that arm with
  // `?? { outcome: "approved" }` left every other test in this file green, on the
  // higher-consequence half of the pair.
  //
  // The success string it falls through to is not a soft one: *"Every future
  // claim in that slot can supersede an earlier one at the next publish"*, said
  // about a response nobody read.
  async function approveCardinalityOnce(): Promise<void> {
    queueEntries = [cardinalityEntry()];
    renderQueue();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Preview the impact/ })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Preview the impact/ }));
    await waitFor(() => expect(approveButton().disabled).toBe(false));
    fireEvent.click(approveButton());
  }

  test("a NON-JSON 200 says `could not confirm`, not `can supersede`", async () => {
    decideMode = "non-json";
    await approveCardinalityOnce();
    await waitFor(() => expect(screen.getByText(/could not confirm/)).toBeTruthy());
    expect(document.body.textContent ?? "").not.toContain("can supersede an earlier one");
  });

  test("a STRICT-schema violation does too", async () => {
    decideMode = "extra-key";
    await approveCardinalityOnce();
    await waitFor(() => expect(screen.getByText(/could not confirm/)).toBeTruthy());
    expect(document.body.textContent ?? "").not.toContain("can supersede an earlier one");
  });

  test("⚠️ a LOST RACE is reported as itself here too", async () => {
    // The alias twin's test comment says the fix was measured by replacing the
    // branch with `if (false)` — and that is exactly what stayed green on this
    // component. On a lost race the approver is told they armed retroactive
    // supersession for a write somebody else made.
    decideMode = "nothing";
    await approveCardinalityOnce();
    await waitFor(() => expect(screen.getByText(/had already been decided/)).toBeTruthy());
    expect(document.body.textContent ?? "").not.toContain("can supersede an earlier one");
  });

  test("POSITIVE CONTROL — a parseable approval still reports the arming", async () => {
    await approveCardinalityOnce();
    await waitFor(() => expect(screen.getByText(/can supersede an earlier one/)).toBeTruthy());
  });

  test("⚠️ REJECT sends `rejected`, and the verb is read from the button pressed", async () => {
    // ⚠️ The single highest-consequence hole the panel found in this file, and
    // it was structural: `decideBodies` was asserted TWICE on the alias half and
    // ZERO times on the cardinality half. Replacing `decision` in the request
    // body with the literal `"approved"` left every other test in this file green — so pressing
    // *Reject* would arm retroactive supersession workspace-wide while the
    // notice read "Rejected: … keeps whatever cardinality it had." The click,
    // the write and the receipt, all disagreeing, in the worst direction.
    queueEntries = [cardinalityEntry()];
    renderQueue();
    await waitFor(() => expect(screen.getByRole("button", { name: /^Reject$/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /^Reject$/ }));
    await waitFor(() => expect(decideBodies.length).toBe(1));
    expect(JSON.parse(decideBodies[0]!)).toEqual({
      kind: "cardinality",
      predicateSurface: "reports to",
      decision: "rejected",
    });
  });

  test("POSITIVE CONTROL — Approve sends `approved` through the same field", async () => {
    // Without this, hard-coding the body to `"rejected"` satisfies the test
    // above — the mirror of the defect it exists for.
    await approveCardinalityOnce();
    await waitFor(() => expect(decideBodies.length).toBe(1));
    expect(JSON.parse(decideBodies[0]!)).toEqual({
      kind: "cardinality",
      predicateSurface: "reports to",
      decision: "approved",
    });
  });

  test("⚠️ a rejection is NOT reported as an armed curation", async () => {
    // The fourth arm of the notice ternary, and the one with no test: deleting
    // the `decision === "rejected"` branch left every test green and rendered
    // "Curated: … Every future claim in that slot can supersede an earlier one"
    // for a decision that curated nothing.
    queueEntries = [cardinalityEntry()];
    renderQueue();
    await waitFor(() => expect(screen.getByRole("button", { name: /^Reject$/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /^Reject$/ }));
    await waitFor(() => expect(screen.getByText(/keeps whatever cardinality it had/)).toBeTruthy());
    expect(document.body.textContent ?? "").not.toContain("can supersede an earlier one");
  });
});

describe("⚠️ the cardinality preview asks about the decision that is actually offered", () => {
  // The preview gates Approve, so a preview of a DIFFERENT decision is a gate
  // that opens on the wrong evidence. The alias half asserts its preview body
  // three times; the cardinality half asserted it zero times, and pointing it at
  // an unrelated predicate with the opposite verb left every other test in this file green.
  async function previewOnce(entry: Record<string, unknown>): Promise<void> {
    queueEntries = [entry];
    renderQueue();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Preview the impact/ })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Preview the impact/ }));
    await waitFor(() => expect(previewBodies.length).toBe(1));
  }

  test("a `single` entry previews the FLIP — the decision approving it would make", async () => {
    await previewOnce(cardinalityEntry({ cardinality: "single" }));
    expect(JSON.parse(previewBodies[0]!)).toEqual({
      kind: "cardinality-flip",
      predicateSurface: "reports to",
    });
  });

  test("⚠️ a `multi` entry does NOT preview the flip — that decision is not on offer", async () => {
    // Hard-coded to `cardinality-flip`, a pending `multi` row previewed "At
    // least N published claims become supersedable" directly beneath its own
    // copy saying "Nothing is superseded by this" — the pane contradicting
    // itself, with the number as the more believable half. Approving `multi`
    // arms nothing, and `cardinality-removal` is the question whose honest
    // answer says so.
    await previewOnce(cardinalityEntry({ cardinality: "multi" }));
    const body = JSON.parse(previewBodies[0]!) as Record<string, unknown>;
    expect(body.kind).toBe("cardinality-removal");
    expect(body.kind).not.toBe("cardinality-flip");
    // ...and it is the SAME predicate the row is about.
    expect(body.predicateSurface).toBe("reports to");
  });
});

describe("⚠️ evidence Atlas COULD NOT READ is never rendered as a zero", () => {
  test("an alias entry says unknown-not-zero rather than explaining a count", async () => {
    // The flat shape returned `subjects: 0, countsConsistent: false` and the
    // client rendered "0 distinct subjects … this now reads below the bar that
    // raised it, BECAUSE the count is re-derived from the corpus as it stands" —
    // a confident, specific, wrong causal story about a number nobody read.
    queueEntries = [aliasEntry({ evidence: { kind: "unreadable" } })];
    renderQueue();
    await waitFor(() => expect(screen.getByText(/unknown, not zero/)).toBeTruthy());
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("0 distinct subjects");
    expect(text).not.toContain("reads below the bar that raised it");
  });

  test("a cardinality entry does the same, and invents no retraction history", async () => {
    // The old copy said "it may have been raised before the claims behind it
    // were retracted" — a specific history, for a query that returned nothing.
    queueEntries = [cardinalityEntry({ evidence: { kind: "unreadable" } })];
    renderQueue();
    await waitFor(() => expect(screen.getByText(/correction history/)).toBeTruthy());
    const text = document.body.textContent ?? "";
    expect(text).toContain("unknown, not zero");
    expect(text).not.toContain("were retracted");
  });

  test("POSITIVE CONTROL — readable evidence still renders its counts", async () => {
    queueEntries = [aliasEntry(), cardinalityEntry()];
    renderQueue();
    await waitFor(() => expect(screen.getByText(/Curated predicate/)).toBeTruthy());
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("unknown, not zero");
    expect(text).toContain("2 distinct subjects");
  });
});

describe("⚠️ approving a `multi` entry is not reported as arming supersession", () => {
  test("the notice records coexistence, matching the row body above it", async () => {
    // The row body branches on `entry.cardinality` and says "values in this slot
    // coexist"; the notice did not, and reported "now holds one value at a time
    // … can supersede an earlier one" — the opposite of what was written, in the
    // dangerous direction, contradicting the copy two elements up.
    queueEntries = [cardinalityEntry({ cardinality: "multi" })];
    renderQueue();
    await waitFor(() => expect(screen.getByRole("button", { name: /Preview the impact/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Preview the impact/ }));
    await waitFor(() => expect(approveButton().disabled).toBe(false));
    fireEvent.click(approveButton());
    await waitFor(() => expect(screen.getByText(/coexist/)).toBeTruthy());
    expect(document.body.textContent ?? "").not.toContain("now holds one value at a time");
  });
});

describe("⚠️ a preview body that will not PARSE is an error, never a blank pane", () => {
  test("says so rather than leaving the gate shut with no signal", async () => {
    // `useAdminMutation` resolves `{ok: true, data: undefined}` for a 204 or a
    // 2xx that does not declare JSON, and `result.data?.radius ?? null` turned that into
    // `{radius: null, pending: false, error: null}` — the triple
    // `BlastRadiusPreview` renders as NOTHING. No radius, no error, "Preview
    // first" again, and an approval gate that can never open.
    const warnings: unknown[][] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      previewReturnsGarbage = true;
      renderQueue();
      await waitFor(() =>
        expect(screen.getAllByRole("button", { name: /Choose this/ }).length).toBe(2),
      );
      fireEvent.click(screen.getAllByRole("button", { name: /Choose this/ })[0]!);
      await waitFor(() =>
        expect(screen.getByText(/not in a shape this page understands/)).toBeTruthy(),
      );
      expect(approveButton().disabled).toBe(true);
      // ⚠️ …and the issues reach the console — see the decide twin. Same silent
      // `safeParse`, same reason it must not be silent.
      expect(warnings.some((w) => String(w[0]).includes("preview response failed"))).toBe(true);
    } finally {
      console.warn = realWarn;
    }
  });
});

describe("a FAILED load is never rendered as an empty queue", () => {
  test("⚠️ says the list is empty because the request failed", async () => {
    // The surface's own headline failure mode, and the fetch stub never returned
    // a non-200 for `/pending`, so nothing rendered this card.
    pendingFails = true;
    renderQueue();
    await waitFor(() => expect(screen.getByText(/because the request/)).toBeTruthy());
    const text = document.body.textContent ?? "";
    expect(text).toContain("not because there is nothing awaiting a decision");
    // ...and the empty-state sentence must NOT also be on screen.
    expect(text).not.toContain("Nothing is awaiting a decision");
  });
});

describe("the empty state is a coverage statement, never a congratulation", () => {
  test("⚠️ never says you are all caught up", async () => {
    queueEntries = [];
    renderQueue();
    await waitFor(() => expect(screen.getByText(/Nothing is awaiting a decision/)).toBeTruthy());
    const text = document.body.textContent ?? "";
    // There is no caught-up state for a vocabulary — only what has been decided
    // and what has not yet been observed.
    expect(text.toLowerCase()).not.toContain("caught up");
    expect(text.toLowerCase()).not.toContain("all clear");
    expect(text).toContain("not the same as nothing needing one");
  });

  test("⚠️ a question never ASKED is not reported as one you may not see", async () => {
    // `cardinalityCounts === null` and `withheld > 0` are two different reasons
    // the sentence is narrower than it sounds, and one qualifier carried both:
    // *"that you can see"* names an ACL boundary, and it was rendered for a
    // queue that simply never asked the cardinality question — filtered out, or
    // filtered to an entity position where a cardinality proposal cannot exist.
    // An approver who reads that goes looking for an admin to widen a grant that
    // would change nothing.
    queueEntries = [];
    cardinalityCountsNull = true;
    renderQueue();
    await waitFor(() => expect(screen.getByText(/Nothing is awaiting a decision/)).toBeTruthy());
    const text = document.body.textContent ?? "";
    expect(text).toContain("among the kinds this queue asked about");
    expect(text).not.toContain("that you can see");
  });

  test("a WITHHELD row still says `that you can see`", async () => {
    // The other side of the split, and the reason it is a split rather than a
    // reword: this qualifier is the honest one when rows exist and a grant is
    // hiding them.
    queueEntries = [];
    countsOverride = { ...COUNTS, total: 4, scoped: 0, withheld: 4 };
    renderQueue();
    await waitFor(() => expect(screen.getByText(/Nothing is awaiting a decision/)).toBeTruthy());
    const text = document.body.textContent ?? "";
    expect(text).toContain("that you can see");
    expect(text).not.toContain("among the kinds this queue asked about");
  });

  test("⚠️ BOTH reasons at once are both stated, not collapsed to one", async () => {
    // The fourth arm. Collapsing the combined case back to " that you can see"
    // left every test green — the pre-split defect (a by-construction exclusion
    // reported as a permission boundary) resurfacing in the case where the
    // permission boundary is also real, which is the hardest one to notice.
    queueEntries = [];
    cardinalityCountsNull = true;
    countsOverride = { ...COUNTS, total: 4, scoped: 0, withheld: 4 };
    renderQueue();
    await waitFor(() => expect(screen.getByText(/Nothing is awaiting a decision/)).toBeTruthy());
    const text = document.body.textContent ?? "";
    expect(text).toContain("that you can see");
    expect(text).toContain("among the kinds this queue asked about");
  });

  test("⚠️ an ALIAS half that was never asked gets the qualifier too", async () => {
    // The mirror encoding. The cardinality half signals "not asked" with `null`;
    // the alias half signals it with `[]`, and reading only the first meant
    // `?kind=cardinality` on an empty result printed the flat sentence — the
    // exact defect the split was written to stop, one half over.
    queueEntries = [];
    aliasCountsEmpty = true;
    renderQueue();
    await waitFor(() => expect(screen.getByText(/Nothing is awaiting a decision/)).toBeTruthy());
    expect(document.body.textContent ?? "").toContain("among the kinds this queue asked about");
  });

  test("⚠️ a count nobody ESTABLISHED is not reported as a clean nothing", async () => {
    // The third reason the sentence is narrower than it sounds, and the one both
    // earlier cuts missed: `readTotal` failing to narrow yields `withheld: 0` on
    // a non-null record, so neither existing flag fires and the page asserted
    // "Nothing is awaiting a decision." flat for a workspace whose pending total
    // was never read.
    queueEntries = [];
    countsOverride = { ...COUNTS, countsConsistent: false };
    renderQueue();
    await waitFor(() => expect(screen.getByText(/Nothing is awaiting a decision/)).toBeTruthy());
    expect(document.body.textContent ?? "").toContain("as far as Atlas could establish");
  });

  test("POSITIVE CONTROL — nothing withheld and everything asked carries NO qualifier", async () => {
    // Without this, an unconditional qualifier satisfies both assertions above,
    // and the page would hedge a sentence it is entitled to state flat.
    queueEntries = [];
    renderQueue();
    await waitFor(() => expect(screen.getByText(/Nothing is awaiting a decision/)).toBeTruthy());
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("that you can see");
    expect(text).not.toContain("among the kinds this queue asked about");
  });
});

describe("⚠️ two UNADDRESSABLE cardinality rows are two rows, not one", () => {
  test("both render, because the key folds in the index", async () => {
    // `entryKey` used to key a cardinality row on `predicateSurface ??
    // "unaddressable"`, so every row whose claims have all been retracted shared
    // one React key. React renders the first and drops the rest — and these are
    // precisely the rows an approver is meant to find and reject, so the
    // collision hides them at the one moment they matter. Only one such row was
    // ever constructed in this file, so the collision was never built.
    // ⚠️ The console spy is the assertion that BITES, and the row count is the
    // control beside it. Measured: React renders both children on a first pass
    // even with one key between them, so *"two rows appear"* passes on the
    // collided key and pins nothing. What the collision breaks is
    // RECONCILIATION — the two rows share an identity, so per-row state
    // (a chosen direction, a preview, a decide error) follows the key rather
    // than the row on any subsequent render. React says so, once, and that
    // warning is the only observable at render time.
    const errors: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map((a) => String(a)).join(" "));
    };
    try {
      queueEntries = [
        cardinalityEntry({ predicateSurface: null, proposedAt: "2026-08-08T00:00:00.000Z" }),
        cardinalityEntry({ predicateSurface: null, proposedAt: "2026-08-07T00:00:00.000Z" }),
      ];
      renderQueue();
      await waitFor(() => expect(screen.getAllByText(/Curated predicate/).length).toBe(2));
      expect(screen.getAllByText(/no live claim carries this predicate/)).toHaveLength(2);
      expect(errors.filter((e) => /same key|duplicate key/i.test(e))).toEqual([]);
    } finally {
      console.error = realError;
    }
  });

  test("⚠️ two ADDRESSABLE rows keep their own preview state", async () => {
    // ⚠️ The BEHAVIOURAL half, and the reason the console spy above is not
    // enough on its own. My first comment claimed the warning was "the only
    // observable at render time" — that was wrong twice over: an unaddressable
    // row renders nothing but an Alert, so the state-follows-the-key harm cannot
    // even occur on the rows that test constructs; and on addressable rows there
    // is a direct observable, which is this.
    //
    // It also pins what the spy cannot: that the key is the row's IDENTITY. A
    // key of `` `row:${index}` `` is perfectly distinct and passes the spy — and
    // is a live defect class, because after a decided row is refetched away every
    // later row shifts index and its preview follows the position instead.
    queueEntries = [
      cardinalityEntry({ predicateSurface: "reports to" }),
      cardinalityEntry({ predicateSurface: "works at" }),
    ];
    renderQueue();
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /Preview the impact/ }).length).toBe(2),
    );
    // Preview the SECOND row only.
    fireEvent.click(screen.getAllByRole("button", { name: /Preview the impact/ })[1]!);
    await waitFor(() => expect(previewBodies.length).toBe(1));
    expect(JSON.parse(previewBodies[0]!).predicateSurface).toBe("works at");
    // The first row's gate must still be shut and its button unpressed. Sharing
    // one identity between the rows is what makes the second row's radius open
    // the first row's Approve.
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /Preview the impact/ }).length).toBe(1),
    );
    const approves = screen.getAllByRole("button", { name: /^Approve$/ }) as HTMLButtonElement[];
    expect(approves.filter((b) => b.disabled)).toHaveLength(1);
    expect(approves.filter((b) => !b.disabled)).toHaveLength(1);
  });

  test("⚠️ …and keep it when an EARLIER row is decided away", async () => {
    // ⚠️ The assertion that pins the key to the row's IDENTITY, and the one the
    // test above cannot make. Within a single render pass an index key is
    // perfectly distinct — so `` `row:${index}` `` passes both the console spy
    // and the two-rows probe. The harm needs the list to CHANGE.
    //
    // Here it changes the way it always does in production: a row is decided and
    // the refetch drops it. Keyed by index, the surviving row inherits the
    // decided row's slot and therefore its state — its computed blast radius
    // vanishes and its Approve shuts, for a preview the approver did run. Keyed
    // by identity, the state follows the row.
    queueEntries = [
      cardinalityEntry({ predicateSurface: "reports to" }),
      cardinalityEntry({ predicateSurface: "works at" }),
    ];
    renderQueue();
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /Preview the impact/ }).length).toBe(2),
    );
    fireEvent.click(screen.getAllByRole("button", { name: /Preview the impact/ })[1]!);
    await waitFor(() =>
      expect(
        (screen.getAllByRole("button", { name: /^Approve$/ }) as HTMLButtonElement[]).filter(
          (b) => !b.disabled,
        ),
      ).toHaveLength(1),
    );

    // The first row is decided, and the refetch returns only the second.
    queueEntries = [cardinalityEntry({ predicateSurface: "works at" })];
    fireEvent.click(screen.getAllByRole("button", { name: /^Reject$/ })[0]!);
    await waitFor(() => expect(screen.getAllByText(/Curated predicate/).length).toBe(1));

    // The survivor still holds ITS preview: one Approve, and it is open.
    const approves = screen.getAllByRole("button", { name: /^Approve$/ }) as HTMLButtonElement[];
    expect(approves).toHaveLength(1);
    expect(approves[0]!.disabled).toBe(false);
  });

  test("POSITIVE CONTROL — the spy above sees a real duplicate-key warning", async () => {
    // Without this, a harness that swallows React's warning (a production build,
    // a different renderer, a future React that drops the message) turns the
    // assertion above into a permanent pass, and the key fix becomes
    // unfalsifiable without anyone noticing.
    const errors: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map((a) => String(a)).join(" "));
    };
    try {
      render(
        createElement(
          "ul",
          null,
          [1, 2].map(() => createElement("li", { key: "collide" }, "row")),
        ),
      );
      await waitFor(() =>
        expect(errors.filter((e) => /same key|duplicate key/i.test(e)).length).toBeGreaterThan(0),
      );
    } finally {
      console.error = realError;
    }
  });
});
