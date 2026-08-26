import { describe, expect, test, afterEach, beforeEach, mock } from "bun:test";
import { render, cleanup, fireEvent, waitFor, screen, within } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { AtlasProvider, type AtlasAuthClient } from "@/ui/context";

/**
 * The two operations that close the recognition loop, given surfaces (#5447).
 *
 * ## Why every assertion here is about a SENTENCE
 *
 * Both endpoints shipped and worked in prod before this UI existed; nothing here
 * is testing that a POST reaches a route. What is new, and what can silently
 * regress, is whether the page tells the truth about what the POST did:
 *
 *   - a cardinality flip offered WITHOUT its floor-framed count is, in the
 *     issue's own words, *worse than no UI* — the preview is the entire reason
 *     the flip is safe to offer;
 *   - a `{minted: 0}` rendered as "nothing to flag" answers a question the route
 *     explicitly declines to answer, and is wrong most often on exactly the
 *     workspace the sweep was built for;
 *   - three 409 arms collapsed into one status line lose the only content they
 *     have, which is whether and when to retry.
 *
 * So the assertions are paired: each "must say X" is next to a state that must
 * NOT say it, because a test for copy passes trivially against a page that
 * renders everything unconditionally.
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

const SURFACES = {
  position: "predicate",
  surfaces: [
    { norm: "reports to", exampleSurface: "reports to", claims: 9, variants: 2 },
    { norm: "led by", exampleSurface: "led by", claims: 4, variants: 1 },
  ],
  truncated: false,
  scope: "unscoped",
};

const EMPTY_COUNTS = {
  position: "predicate",
  scope: "unscoped",
  total: 0,
  scoped: 0,
  withheld: 0,
  countsConsistent: true,
};

/** ⚠️ `led by → leads` is IN FORCE, which is what makes the divergence arm reachable. */
const IN_FORCE = {
  edges: [
    {
      position: "predicate",
      fromNorm: "led by",
      toNorm: "leads",
      approvedBy: "user-1",
      approvedAt: "2026-08-08T00:00:00.000Z",
      hasRejectionMemory: true,
    },
  ],
  counts: [EMPTY_COUNTS],
  cardinalities: [],
  cardinalityCounts: EMPTY_COUNTS,
  coverage: { liveFacts: 12, comparableFacts: 3, pendingProposals: 0, pendingCardinalities: 0 },
  truncated: false,
};

const COMPUTED_RADIUS = {
  kind: "computed",
  targetCardinality: { kind: "not-asked" },
  arming: { total: 6, pairs: [], withheld: 0, truncated: false, countsConsistent: true },
  disarming: { total: 0, pairs: [], withheld: 0, truncated: false, countsConsistent: true },
  floor: true,
  subtreeTruncated: false,
};

/** Mutable knobs, reset per test. */
let inForce: unknown = IN_FORCE;
let inForceStatus = 200;
let cardinalityResponse: { body: unknown; status: number } = {
  body: { cardinality: "single" },
  status: 200,
};
let sweepResponse: { body: unknown; status: number } = {
  body: { minted: 3, truncated: false },
  status: 200,
};
const previewCalls: string[] = [];
const cardinalityCalls: string[] = [];
let inForceFetches = 0;

const originalFetch = globalThis.fetch;

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * Installed in `beforeEach` rather than at module scope — the harness's
 * happy-dom preload resets globals after this module evaluates, so a top-level
 * assignment is silently undone and every fetch reaches the real network.
 * `preview-gate.test.tsx` installs its stub the same way for the same reason.
 */
function installFetchStub() {
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/brain-vocabulary/surfaces")) {
      return Promise.resolve(jsonResponse(SURFACES));
    }
    if (url.includes("/brain-vocabulary/in-force")) {
      inForceFetches += 1;
      return inForceStatus === 200
        ? Promise.resolve(jsonResponse(inForce))
        : Promise.resolve(
            jsonResponse(
              { error: "server_error", message: "in-force blew up", requestId: "req-9" },
              inForceStatus,
            ),
          );
    }
    if (url.includes("/brain-vocabulary/pending")) {
      return Promise.resolve(
        jsonResponse({
          entries: [],
          aliasCounts: [],
          cardinalityCounts: EMPTY_COUNTS,
          truncated: false,
          incomplete: false,
        }),
      );
    }
    if (url.includes("/brain-vocabulary/cardinality")) {
      cardinalityCalls.push(String(init?.body ?? ""));
      return Promise.resolve(jsonResponse(cardinalityResponse.body, cardinalityResponse.status));
    }
    if (url.includes("/brain-vocabulary/preview")) {
      previewCalls.push(String(init?.body ?? ""));
      return Promise.resolve(jsonResponse({ radius: COMPUTED_RADIUS }));
    }
    if (url.includes("/brain-facts/tension-sweep")) {
      return Promise.resolve(jsonResponse(sweepResponse.body, sweepResponse.status));
    }
    return Promise.resolve(jsonResponse({}));
  }) as unknown as typeof fetch;
}

const ClaimVocabularyPage = (await import("../page")).default;

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

function renderPage() {
  testQueryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(createElement(ClaimVocabularyPage), { wrapper: Wrapper });
}

/**
 * Queries SCOPED to one card, by its title.
 *
 * ⚠️ Not `getAllBy...()[n]`. The page carries three pickers, four preview-ish
 * buttons and two alert stacks, and an index pins a test to pane ORDER — which
 * `preview-gate.test.tsx` records as how one of its tests came to drive the
 * wrong control and pass for four commits. `data-slot="card"` is the shadcn
 * primitive's own hook, so this scopes to the component boundary rather than to
 * a class name.
 */
function card(title: RegExp): HTMLElement {
  const heading = screen.getByText(title);
  const found = heading.closest('[data-slot="card"]');
  if (found === null) throw new Error(`no card wraps ${String(title)}`);
  return found as HTMLElement;
}

const cardinalityCard = () => card(/Declare a predicate.s cardinality/);
const sweepCard = () => card(/Look again for tensions/);

/** Pick a predicate in the cardinality card's own picker. */
async function pickPredicate(norm: string) {
  const scope = cardinalityCard();
  await waitFor(() => expect(within(scope).getAllByText(norm).length).toBeGreaterThan(0));
  fireEvent.click(within(scope).getAllByText(norm)[0]!);
}

/** `.disabled` on the element — this harness does not load jest-dom. */
const writeButton = (name: RegExp): HTMLButtonElement =>
  within(cardinalityCard()).getByRole("button", { name }) as HTMLButtonElement;

const curateButton = () => writeButton(/Curate as single-valued/i);
const previewButton = () => writeButton(/Preview the cardinality impact/i);
const sweepButton = () =>
  within(sweepCard()).getByRole("button", { name: /Run the tension sweep|Sweeping/i }) as HTMLButtonElement;

beforeEach(() => {
  inForce = IN_FORCE;
  inForceStatus = 200;
  cardinalityResponse = { body: { cardinality: "single" }, status: 200 };
  sweepResponse = { body: { minted: 3, truncated: false }, status: 200 };
  previewCalls.length = 0;
  cardinalityCalls.length = 0;
  inForceFetches = 0;
  installFetchStub();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("cardinality authoring reaches POST /cardinality at all", () => {
  test("the flip is written, and the In-force pane is re-read without a reload", async () => {
    // The acceptance criterion, end to end. Before this card the ONLY caller of
    // `POST /cardinality` in `packages/web/src` was nothing at all — the In-force
    // pane rendered `entry.cardinality` as a badge and could not author it.
    renderPage();
    await pickPredicate("reports to");
    await waitFor(() => expect(previewButton().disabled).toBe(false));
    fireEvent.click(previewButton());
    await waitFor(() => expect(curateButton().disabled).toBe(false));

    const before = inForceFetches;
    fireEvent.click(curateButton());
    await waitFor(() => expect(cardinalityCalls.length).toBe(1));
    expect(JSON.parse(cardinalityCalls[0]!)).toEqual({
      predicateSurface: "reports to",
      cardinality: "single",
    });
    // "without a reload" is a refetch, not a router navigation.
    await waitFor(() => expect(inForceFetches).toBeGreaterThan(before));
  });

  test("the preview asks the CARDINALITY-FLIP question, not an alias question", async () => {
    renderPage();
    await pickPredicate("reports to");
    fireEvent.click(previewButton());
    await waitFor(() => expect(previewCalls.length).toBe(1));
    expect(JSON.parse(previewCalls[0]!)).toEqual({
      kind: "cardinality-flip",
      predicateSurface: "reports to",
    });
  });

  test("⚠️ the write is DEAD until a preview has come back", async () => {
    // "A UI that offers the flip without rendering the preview count would be
    // worse than no UI — the preview is the reason the flip is safe to offer."
    renderPage();
    await pickPredicate("reports to");
    expect(curateButton().disabled).toBe(true);
    expect(within(cardinalityCard()).getByText(/Preview first/i)).toBeTruthy();
    // POSITIVE CONTROL — the same button enables once the number exists, so the
    // assertion above is about the gate rather than about a permanently dead
    // control.
    fireEvent.click(previewButton());
    await waitFor(() => expect(curateButton().disabled).toBe(false));
  });

  test("the count is rendered as a FLOOR, not as a total", async () => {
    // `floor` is a literal `true` on the computed branch precisely so the word
    // "at least" is assertable. A flip is not a batch: it applies to every future
    // claim in the slot, and reading 6 as a total is how an operator decides a
    // 6-pair blast radius is small.
    renderPage();
    await pickPredicate("reports to");
    fireEvent.click(previewButton());
    const scope = cardinalityCard();
    await waitFor(() => expect(within(scope).getByText(/At least 6 published/)).toBeTruthy());
    expect(within(scope).getByText(/every future claim in the slot/)).toBeTruthy();
  });

  test("the retroactive blast radius is stated BEFORE the preview is asked for", async () => {
    // The hazard is a property of the verb, not of the number, so it may not wait
    // for a count to arrive — an operator who never clicks Preview must still
    // have read it.
    renderPage();
    const scope = cardinalityCard();
    await waitFor(() => expect(within(scope).getByText(/Retroactive/)).toBeTruthy());
    expect(within(scope).getByText(/floor, never a total/)).toBeTruthy();
  });
});

describe("un-curation to multi is reachable, and says what a stored multi means", () => {
  async function chooseMulti() {
    const trigger = screen.getByRole("combobox", { name: /Predicate cardinality/i });
    fireEvent.keyDown(trigger, { key: "Enter" });
    const option = await screen.findByRole("option", { name: /values coexist/i });
    fireEvent.click(option);
    await waitFor(() => expect(screen.queryByRole("option")).toBeNull());
  }

  test("`multi` is selectable and writes `multi`", async () => {
    cardinalityResponse = { body: { cardinality: "multi" }, status: 200 };
    renderPage();
    await pickPredicate("reports to");
    await chooseMulti();
    fireEvent.click(previewButton());
    const button = () => writeButton(/Record as multi-valued/i);
    await waitFor(() => expect(button().disabled).toBe(false));
    fireEvent.click(button());
    await waitFor(() => expect(cardinalityCalls.length).toBe(1));
    expect(JSON.parse(cardinalityCalls[0]!).cardinality).toBe("multi");
  });

  test("⚠️ it says absent-from-the-table ALREADY means multi", async () => {
    // Without this sentence `multi` reads as a no-op, and the one thing it is
    // for — the adjudicated record that a human looked and declined — is
    // invisible. The route's own description is the source: *"Absent from the
    // table already MEANS multi, so a stored multi is a human declining the
    // question."*
    renderPage();
    const scope = cardinalityCard();
    // POSITIVE CONTROL — absent on the `single` direction, so this is not a
    // sentence the card renders unconditionally.
    expect(within(scope).queryByText(/absent from this table already means multi/i)).toBeNull();
    await chooseMulti();
    await waitFor(() =>
      expect(
        within(cardinalityCard()).getByText(/absent from this table already means multi/i),
      ).toBeTruthy(),
    );
    expect(within(cardinalityCard()).getByText(/declining the/i)).toBeTruthy();
  });

  test("changing direction clears the preview, so a `multi` cannot ship behind a flip's count", async () => {
    // The two previews are opposite questions with opposite signs. Without the
    // clear, previewing `single` and then switching to `multi` arms the
    // un-curation behind the flip's number.
    renderPage();
    await pickPredicate("reports to");
    fireEvent.click(previewButton());
    await waitFor(() => expect(curateButton().disabled).toBe(false));
    await chooseMulti();
    await waitFor(() => expect(writeButton(/Record as multi-valued/i).disabled).toBe(true));
    // And the second preview asks the OTHER question.
    fireEvent.click(previewButton());
    await waitFor(() => expect(previewCalls.length).toBe(2));
    expect(JSON.parse(previewCalls[1]!).kind).toBe("cardinality-removal");
  });
});

describe("⚠️ the alias divergence between /preview and /cardinality", () => {
  test("an aliased predicate names its target and the write is blocked", async () => {
    // `/preview` keys with `identityKey` (normalization only); `/cardinality`
    // keys with `slotKey` (normalization AND the alias closure). For `led by`,
    // which is aliased onto `leads`, the number describes one slot and the write
    // lands in another — both correct in isolation, and together exactly the
    // case where a count cannot license a decision.
    renderPage();
    await pickPredicate("led by");
    const scope = cardinalityCard();
    await waitFor(() => expect(within(scope).getByText(/is aliased onto/)).toBeTruthy());
    expect(within(cardinalityCard()).getByText(/would curate/)).toBeTruthy();
    fireEvent.click(previewButton());
    // The preview still returns a perfectly good number — and the button stays
    // dead anyway, which is the whole point.
    await waitFor(() => expect(previewCalls.length).toBe(1));
    expect(curateButton().disabled).toBe(true);
  });

  test("POSITIVE CONTROL — an UNALIASED predicate shows no divergence and arms", async () => {
    renderPage();
    await pickPredicate("reports to");
    expect(within(cardinalityCard()).queryByText(/is aliased onto/)).toBeNull();
    fireEvent.click(previewButton());
    await waitFor(() => expect(curateButton().disabled).toBe(false));
  });

  test("⚠️ a FAILED in-force load blocks the write rather than reading as no-alias", async () => {
    // `edges` falls back to `[]` on failure, so "no alias starts here" and
    // "nobody knows what starts here" are the same value — and the divergence is
    // precisely the hazard an absent edge would be read as ruling out.
    inForceStatus = 500;
    renderPage();
    await pickPredicate("reports to");
    const scope = cardinalityCard();
    await waitFor(() => expect(within(scope).getByText(/unknown, not clear/)).toBeTruthy());
    fireEvent.click(previewButton());
    await waitFor(() => expect(previewCalls.length).toBe(1));
    expect(curateButton().disabled).toBe(true);
  });

  test("⚠️ a TRUNCATED in-force list blocks it too", async () => {
    // A truncated list is silently cut, so the alias edge may exist and simply
    // not be on the page. Same value, same wrong inference.
    inForce = { ...IN_FORCE, truncated: true };
    renderPage();
    await pickPredicate("reports to");
    await waitFor(() =>
      expect(within(cardinalityCard()).getByText(/unknown, not clear/)).toBeTruthy(),
    );
    expect(curateButton().disabled).toBe(true);
  });
});

describe("the write's refusal is the server's, so an entitlement bar is legible", () => {
  test("a 403 renders the route's own denial prose, and the control still works", async () => {
    // The route re-resolves owner/admin against the workspace being written
    // rather than reading it off the session, so this page cannot know the answer
    // before asking — which is why the control is not hidden on a guess. An admin
    // of another workspace reads the refusal instead of finding a dead button.
    cardinalityResponse = {
      body: {
        error: "not-entitled",
        message:
          "You may not curate a predicate's cardinality in this workspace — it needs the owner or admin entitlement.",
        requestId: "req-4",
      },
      status: 403,
    };
    renderPage();
    await pickPredicate("reports to");
    fireEvent.click(previewButton());
    await waitFor(() => expect(curateButton().disabled).toBe(false));
    fireEvent.click(curateButton());
    await waitFor(() =>
      expect(within(cardinalityCard()).getByText(/owner or admin entitlement/)).toBeTruthy(),
    );
    // NOT a broken control: it is still live, so a reader who gains the
    // entitlement can retry without reloading.
    expect(curateButton().disabled).toBe(false);
  });

  test("⚠️ the success notice does not follow the operator to the NEXT predicate", async () => {
    // A completed write clears the picker and leaves its confirmation up, which
    // is right until a second predicate is picked — at which point “reports to is
    // now curated single-valued” sits above a form about something else and reads
    // as that predicate's state. The page's own `removeError` split records this
    // shared-slot conflation one pane over.
    renderPage();
    await pickPredicate("reports to");
    fireEvent.click(previewButton());
    await waitFor(() => expect(curateButton().disabled).toBe(false));
    fireEvent.click(curateButton());
    await waitFor(() =>
      expect(within(cardinalityCard()).getByText(/is now curated single-valued/)).toBeTruthy(),
    );
    await pickPredicate("reports to");
    await waitFor(() =>
      expect(within(cardinalityCard()).queryByText(/is now curated single-valued/)).toBeNull(),
    );
  });

  test("a successful `single` write says supersession is ARMED, not that anything was superseded", async () => {
    renderPage();
    await pickPredicate("reports to");
    fireEvent.click(previewButton());
    await waitFor(() => expect(curateButton().disabled).toBe(false));
    fireEvent.click(curateButton());
    await waitFor(() =>
      expect(within(cardinalityCard()).getByText(/Nothing has been superseded yet/)).toBeTruthy(),
    );
  });
});

describe("the tension sweep is triggerable and never over-claims", () => {
  test("a non-zero run renders `minted` and says the write is additive", async () => {
    renderPage();
    fireEvent.click(sweepButton());
    const scope = () => sweepCard();
    await waitFor(() =>
      expect(within(scope()).getByText(/minted 3 advisory tension edges/)).toBeTruthy(),
    );
    // The clause that belongs to the RESULT, not the card's standing
    // description — "additive and advisory" appears in both, deliberately (the
    // guarantee matters most beside a number), so matching it would be ambiguous.
    expect(within(scope()).getByText(/does not duplicate these edges/)).toBeTruthy();
  });

  test("⚠️ `{minted: 0}` names the three causes and does NOT read as done", async () => {
    sweepResponse = { body: { minted: 0, truncated: false }, status: 200 };
    renderPage();
    fireEvent.click(sweepButton());
    const scope = () => sweepCard();
    await waitFor(() =>
      expect(within(scope()).getByText(/does not identify a cause/)).toBeTruthy(),
    );
    // The commonest cause, which is the one an operator will actually be in.
    expect(within(scope()).getByText(/curated single-valued AND approved/)).toBeTruthy();
    expect(within(scope()).getByText(/already converged/)).toBeTruthy();
    expect(within(scope()).getByText(/no live facts to compare/)).toBeTruthy();
    expect(within(scope()).queryByText(/Nothing to flag/i)).toBeNull();
  });

  test("`truncated: true` says to run it again to resume", async () => {
    sweepResponse = { body: { minted: 5, truncated: true }, status: 200 };
    renderPage();
    fireEvent.click(sweepButton());
    await waitFor(() =>
      expect(within(sweepCard()).getByText(/Run it again to resume/)).toBeTruthy(),
    );
    expect(within(sweepCard()).getByText(/picks up where this one stopped/)).toBeTruthy();
  });

  test("POSITIVE CONTROL — a finished run does not tell you to run it again", async () => {
    renderPage();
    fireEvent.click(sweepButton());
    await waitFor(() =>
      expect(within(sweepCard()).getByText(/minted 3 advisory tension edges/)).toBeTruthy(),
    );
    expect(within(sweepCard()).queryByText(/Run it again to resume/)).toBeNull();
  });

  test("the pending-does-not-arm-it caveat is on screen BEFORE any run", async () => {
    // Telling an operator afterwards that a pending entry does not arm the sweep
    // is telling them after they have already read `0` as an answer.
    renderPage();
    await waitFor(() =>
      expect(within(sweepCard()).getByText(/a pending proposal does not/)).toBeTruthy(),
    );
  });

  test("⚠️ each of the three 409 arms renders a DIFFERENT message", async () => {
    // The acceptance criterion, and the property a generic failure card breaks:
    // "retry in a few seconds" and "retry once and escalate" are different
    // instructions, and which one applies is the whole content of the response.
    const seen: string[] = [];
    for (const code of ["reconcile-lock", "conflicting-lock", "unfinished"] as const) {
      sweepResponse = {
        body: {
          error: code,
          message: `The tension sweep hit ${code}. Nothing was changed.`,
          requestId: "req-7",
        },
        status: 409,
      };
      renderPage();
      fireEvent.click(sweepButton());
      await waitFor(() => expect(within(sweepCard()).getByText(new RegExp(code))).toBeTruthy());
      seen.push(within(sweepCard()).getByText(new RegExp(code)).textContent ?? "");
      cleanup();
    }
    expect(new Set(seen).size).toBe(3);
  });

  test("a 409's report slot is CLEARED, so a previous run's count does not sit beside it", async () => {
    // A single state slot would leave `minted: 3` on screen next to a refusal
    // that changed nothing — the failed-vs-empty conflation, in its most
    // flattering direction.
    renderPage();
    fireEvent.click(sweepButton());
    await waitFor(() =>
      expect(within(sweepCard()).getByText(/minted 3 advisory tension edges/)).toBeTruthy(),
    );
    sweepResponse = {
      body: { error: "unfinished", message: "It did not complete.", requestId: "req-8" },
      status: 409,
    };
    fireEvent.click(sweepButton());
    await waitFor(() => expect(within(sweepCard()).getByText(/did not complete/)).toBeTruthy());
    expect(within(sweepCard()).queryByText(/minted 3 advisory tension edges/)).toBeNull();
  });
});
