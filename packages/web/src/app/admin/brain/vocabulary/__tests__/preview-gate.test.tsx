import { describe, expect, test, afterEach, beforeEach, mock } from "bun:test";
import { render, cleanup, fireEvent, waitFor, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { AtlasProvider, type AtlasAuthClient } from "@/ui/context";

/**
 * The preview-before-you-write interlock (#5087).
 *
 * ## Why this is a safety property and not a UX nicety
 *
 * The page says it in as many words: *"This decision re-keys every affected
 * claim in the workspace, so the blast radius is not optional."* Both write
 * verbs are gated on a blast radius having been COMPUTED — and the gate has
 * three independent ways to fail silently, none of which any other test reaches:
 *
 *   1. The button enables before a radius arrives.
 *   2. The radius is not cleared when the pair or the position changes, so an
 *      approver authors against a preview computed for a DIFFERENT decision.
 *      There are three separate `setRadius(null)` calls; dropping any one leaves
 *      a stale preview on screen with an enabled button beside it.
 *   3. The preview FAILED and the button is live anyway — which is what the
 *      removal path did until the panel caught it, while authoring was gated.
 *
 * Every assertion here would pass against a page that renders nothing, so each
 * is paired with the state that must enable the button.
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
    { norm: "is priced at", exampleSurface: "is priced at", claims: 2, variants: 1 },
    { norm: "priced at", exampleSurface: "priced at", claims: 3, variants: 1 },
  ],
  truncated: false,
  scope: "unscoped",
};

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
  counts: [
    {
      position: "predicate",
      scope: "unscoped",
      total: 0,
      scoped: 0,
      withheld: 0,
      countsConsistent: true,
    },
  ],
  cardinalities: [],
  cardinalityCounts: {
    position: "predicate",
    scope: "unscoped",
    total: 0,
    scoped: 0,
    withheld: 0,
    countsConsistent: true,
  },
  coverage: { liveFacts: 5, comparableFacts: 0, pendingProposals: 0, pendingCardinalities: 0 },
  truncated: false,
};

/** Whether the preview endpoint succeeds, so the failure arm is reachable. */
let previewFails = false;
/** When set, the preview response waits on this — for the in-flight race arm. */
let holdPreview: Promise<void> | null = null;
/** Successive previews wait on these, in order — for the two-in-flight arm. */
let holdQueue: Promise<void>[] = [];
/** Whether `POST /remove` fails, so the dialog's error arm is reachable. */
let removeFails = false;
const previewCalls: unknown[] = [];

const originalFetch = globalThis.fetch;

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * Installed in `beforeEach`, not at module scope.
 *
 * The harness's happy-dom preload resets globals after this module evaluates, so
 * a top-level assignment is silently undone and every fetch reaches the real
 * network — which surfaces as "Unable to connect" and an empty page rather than
 * as an obviously broken stub. `review-honesty.test.tsx` installs its stub the
 * same way for the same reason.
 */
function installFetchStub() {
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/brain-vocabulary/surfaces")) {
      return Promise.resolve(jsonResponse(SURFACES));
    }
    if (url.includes("/brain-vocabulary/in-force")) {
      return Promise.resolve(jsonResponse(IN_FORCE));
    }
    // The page grew a third pane (#5088) with its own fetch. Answered with an
    // EMPTY queue rather than left to the `{}` fallthrough: that would fail the
    // response schema and render an error card, which every `getByText` here
    // would then have to step around — and a harness that renders an error while
    // its assertions pass is how a page-level test stops covering the page.
    if (url.includes("/brain-vocabulary/pending")) {
      return Promise.resolve(
        jsonResponse({
          entries: [],
          aliasCounts: [],
          cardinalityCounts: {
            position: "predicate",
            scope: "unscoped",
            total: 0,
            scoped: 0,
            withheld: 0,
            countsConsistent: true,
          },
          truncated: false,
          // ⚠️ REQUIRED by the strict response schema. Omitted, `useAdminFetch`
          // fails the parse and the Pending pane renders its error card — so the
          // comment above about not leaving an error on screen described the
          // state this stub was actually in. Measured by a reviewer.
          incomplete: false,
        }),
      );
    }
    if (url.includes("/brain-vocabulary/remove")) {
      return Promise.resolve(
        removeFails
          ? jsonResponse(
              {
                error: "not-in-force",
                message: "That alias could not be removed — no approved edge matches that pair.",
                requestId: "req-1",
              },
              409,
            )
          : jsonResponse({ outcome: "removed", proposalId: "p-1", memoryCreated: false }),
      );
    }
    if (url.includes("/brain-vocabulary/preview")) {
      previewCalls.push(init?.body);
      const held = holdQueue.length > 0 ? holdQueue.shift()! : holdPreview;
      if (held !== null && held !== undefined) {
        holdPreview = null;
        return held.then(() =>
          jsonResponse({
            radius: {
              kind: "computed",
              targetCardinality: { kind: "not-asked" },
              arming: { total: 2, pairs: [], withheld: 0, truncated: false, countsConsistent: true },
              disarming: {
                total: 0,
                pairs: [],
                withheld: 0,
                truncated: false,
                countsConsistent: true,
              },
              floor: true,
              subtreeTruncated: false,
            },
          }),
        );
      }
      return Promise.resolve(
        previewFails
          ? jsonResponse({ error: "server_error", message: "preview blew up" }, 500)
          : jsonResponse({
              radius: {
                kind: "computed",
                targetCardinality: { kind: "not-asked" },
                arming: {
                  total: 2,
                  pairs: [],
                  withheld: 0,
                  truncated: false,
                  countsConsistent: true,
                },
                disarming: {
                  total: 0,
                  pairs: [],
                  withheld: 0,
                  truncated: false,
                  countsConsistent: true,
                },
                floor: true,
                subtreeTruncated: false,
              },
            }),
      );
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
 * Pick both sides from the picker — the only way a value can be supplied.
 *
 * `getAllByText(...)[0]` because BOTH pickers render the same option list, which
 * is itself the design: the page offers the same observed norms on each side and
 * excludes only the one already chosen opposite. Clicking the first collapses
 * that picker to its selected view, so the second lookup lands in the remaining
 * list.
 */
async function pickBothNorms() {
  await waitFor(() => expect(screen.getAllByText("is priced at").length).toBeGreaterThan(0));
  fireEvent.click(screen.getAllByText("is priced at")[0]!);
  await waitFor(() => expect(screen.getAllByText("priced at").length).toBeGreaterThan(0));
  fireEvent.click(screen.getAllByText("priced at")[0]!);
  await waitFor(() => expect(screen.getByRole("button", { name: /Author this alias/i })).toBeTruthy());
}

/**
 * `.disabled` on the element, not a `toBeDisabled()` matcher — this harness does
 * not load jest-dom, and the matcher is `undefined` there rather than failing
 * loudly, so an assertion written against it throws a TypeError instead of
 * testing anything.
 */
const authorDisabled = (): boolean =>
  (screen.getByRole("button", { name: /Author this alias/i }) as HTMLButtonElement).disabled;

beforeEach(() => {
  previewFails = false;
  holdPreview = null;
  holdQueue = [];
  removeFails = false;
  previewCalls.length = 0;
  installFetchStub();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const removeButton = (): HTMLButtonElement =>
  screen.getByRole("button", { name: /^Remove the alias$/i }) as HTMLButtonElement;

describe("removal is gated on the SAME computed blast radius", () => {
  test("⚠️ the destructive button is dead while the preview is failing", async () => {
    // THE panel finding. Removal used to check only `radiusPending`, so the
    // button stayed live beside "the blast radius could not be computed …
    // unknown — not zero" — on the graver of the two verbs, which re-keys the
    // corpus back and writes PERMANENT rejection memory that no producer can
    // undo. Authoring was gated; removal was not.
    previewFails = true;
    renderPage();
    fireEvent.click((await screen.findAllByRole("button", { name: /^Remove$/i }))[0]!);
    await waitFor(() => expect(screen.getByText(/could not be computed/i)).toBeTruthy());
    expect(removeButton().disabled).toBe(true);
  });

  test("⚠️ a removal preview that lands after the dialog moved on does not re-arm it", async () => {
    // The removal half of the async race. Its own docstring names the scenario —
    // "Remove edge 1, Cancel, Remove edge 2 → if edge 1's response lands last it
    // fills the slot, and the destructive button enables showing edge 1's
    // counterfactual for edge 2" — and deleting the bump from
    // `clearRemoveRadius()` left all 38 web tests green, on the graver verb.
    // TWO held previews, because the bump only matters in one ordering: the
    // abandoned response has to land AFTER the replacement has started. If it
    // lands before, `loadRadius`'s own opening `{pending: true, radius: null}`
    // clears the slot anyway and the guard is not what saved it.
    let releaseFirst: (() => void) | null = null;
    let releaseSecond: (() => void) | null = null;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const second = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    holdQueue = [first, second];

    renderPage();
    fireEvent.click((await screen.findAllByRole("button", { name: /^Remove$/i }))[0]!);
    // Abandon it while its preview is still in flight.
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /^Remove the alias$/i })).toBeNull(),
    );

    // Re-open — a SECOND preview starts and is also held, so the button is
    // legitimately disabled while it is pending.
    fireEvent.click((await screen.findAllByRole("button", { name: /^Remove$/i }))[0]!);
    await waitFor(() => expect(removeButton().disabled).toBe(true));

    // Now let the ABANDONED response land, on top of a pending replacement.
    releaseFirst!();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The stale radius must not have armed the destructive button.
    expect(removeButton().disabled).toBe(true);
    releaseSecond!();
  });

  test("⚠️ a FAILED removal keeps the dialog open and reports inside it", async () => {
    // Round 1's defect class, re-introducible silently: the failure arm used to
    // call `setAuthorError(...)` AND close the dialog, so the server's removal
    // prose appeared under "Author an alias" with nothing left to attribute it
    // to. Reverting it left all 38 web tests green — nothing anywhere rendered a
    // failing `/remove`.
    removeFails = true;
    renderPage();
    fireEvent.click((await screen.findAllByRole("button", { name: /^Remove$/i }))[0]!);
    await waitFor(() => expect(removeButton().disabled).toBe(false));
    fireEvent.click(removeButton());

    // The dialog is STILL open, and the message is in it.
    await waitFor(() => expect(screen.getByText(/could not be removed/i)).toBeTruthy());
    expect(screen.queryByRole("button", { name: /^Remove the alias$/i })).not.toBeNull();
    // …and the authoring card carries no error it cannot explain.
    expect(screen.queryByText(/Author an alias/i)).not.toBeNull();
  });

  test("POSITIVE CONTROL — it enables once the removal preview lands", async () => {
    // Without this, a page that disabled the removal button unconditionally
    // would satisfy the assertion above — and removal would be impossible,
    // which is the failure the In-force pane exists to prevent.
    renderPage();
    fireEvent.click((await screen.findAllByRole("button", { name: /^Remove$/i }))[0]!);
    await waitFor(() => expect(removeButton().disabled).toBe(false));
    // …and it previewed the REMOVAL, not an approval: a removal is a re-key too,
    // and the two counterfactuals are different expressions over one delta.
    expect(String(previewCalls[0])).toContain("alias-removal");
  });
});

describe("the two previews do not contaminate each other", () => {
  test("⚠️ opening a REMOVAL preview leaves the authoring card's preview empty", async () => {
    // Found by writing the removal-gate test above: with ONE shared `radius`,
    // clicking Remove computed a removal counterfactual into the state the
    // authoring card renders. The card then displayed a preview for a decision
    // nobody was making — and with both norms picked, its "Author this alias"
    // button became enabled by a number computed for a different pair, in the
    // opposite direction, on a different verb.
    renderPage();
    await pickBothNorms();
    expect(authorDisabled()).toBe(true);

    fireEvent.click((await screen.findAllByRole("button", { name: /^Remove$/i }))[0]!);
    await waitFor(() => expect(removeButton().disabled).toBe(false));

    // ⚠️ Asserted WHILE THE DIALOG IS OPEN. The earlier version dismissed it
    // first — but the close handler clears the removal slot, and under a
    // single-shared-slot revert it clears the SHARED slot, so the assertion held
    // either way. The contamination exists only while both are live.
    //
    // TEXT queries rather than `*ByRole`: Radix `aria-hidden`s the page behind
    // the dialog, which hides it from role queries but not from text ones.
    //
    // The removal's radius is 2-arming. If it had leaked into the authoring
    // slot, the authoring card would render the same "At least 2" line — so
    // exactly ONE occurrence is the property.
    expect(screen.getAllByText(/At least 2 published/)).toHaveLength(1);
    // …and the authoring card still shows its "preview first" prompt, which it
    // only renders while its own radius is null.
    expect(screen.getByText(/blast radius is not optional/i)).toBeTruthy();
  });
});

describe("authoring is gated on a computed blast radius", () => {
  test("the author button is disabled before any preview has been run", async () => {
    renderPage();
    await pickBothNorms();
    expect(authorDisabled()).toBe(true);
    // …and the page SAYS why, rather than leaving a dead button.
    expect(screen.getByText(/blast radius is not optional/i)).toBeTruthy();
  });

  test("POSITIVE CONTROL — it enables once a preview has come back", async () => {
    // Without this, a page that disabled the button unconditionally would
    // satisfy every other assertion in this file.
    renderPage();
    await pickBothNorms();
    fireEvent.click(screen.getByRole("button", { name: /Preview the impact/i }));
    await waitFor(() => expect(authorDisabled()).toBe(false));
    expect(previewCalls).toHaveLength(1);
  });

  test("⚠️ a FAILED preview does not enable it", async () => {
    // A preview that failed and a preview that came back empty are opposite
    // facts. The button must not treat "we could not compute the impact" as
    // "there is no impact" — which is the same conflation the removal path had
    // until the panel caught it.
    previewFails = true;
    renderPage();
    await pickBothNorms();
    fireEvent.click(screen.getByRole("button", { name: /Preview the impact/i }));
    await waitFor(() => expect(screen.getByText(/could not be computed/i)).toBeTruthy());
    expect(authorDisabled()).toBe(true);
  });

  test("⚠️ RE-PICKING a norm clears the preview, so the gate is not just !bothPicked", async () => {
    // ⚠️ The previous version of this test clicked "Change" and stopped there —
    // which un-picks a side, so `!bothPicked` disabled the button on its own and
    // ALL THREE `clearAuthorRadius()` calls could be deleted with the test still
    // green, despite its comment naming them. It asserted the guard it was
    // written for and could not see it.
    //
    // Re-picking restores `bothPicked`, so the only thing that can keep the
    // button disabled is the radius having been cleared.
    renderPage();
    await pickBothNorms();
    fireEvent.click(screen.getByRole("button", { name: /Preview the impact/i }));
    await waitFor(() => expect(authorDisabled()).toBe(false));

    fireEvent.click(screen.getAllByRole("button", { name: /^Change$/ })[0]!);
    await waitFor(() => expect(screen.getAllByText("is priced at").length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText("is priced at")[0]!);

    // Both sides picked again — and the gate is still shut, because the preview
    // that was computed belongs to the pair before the change.
    await waitFor(() => expect(authorDisabled()).toBe(true));
  });

  test("⚠️ changing the POSITION clears the preview too", async () => {
    // ⚠️ This test used to click `getAllByRole("button", {name: /^Change$/})[0]`
    // — the picker's UN-PICK button, not the position select — so it was a
    // duplicate of the re-picking test above and deleting `clearAuthorRadius()`
    // from the position handler left it green, despite its own comment naming
    // that handler. It described an interaction it did not perform.
    //
    // The select is a Radix trigger exposed as a `combobox`. Driving it is the
    // only thing that reaches the third reset site, and this is the STALEST of
    // the three: the radius would belong to a different POSITION entirely, whose
    // population has nothing to do with the new one.
    renderPage();
    await pickBothNorms();
    fireEvent.click(screen.getByRole("button", { name: /Preview the impact/i }));
    await waitFor(() => expect(authorDisabled()).toBe(false));
    expect(screen.queryByText(/At least 2 published/)).not.toBeNull();

    // ⚠️ BY NAME. The page grew two more comboboxes with the Pending pane
    // (#5088), so a bare `getByRole("combobox")` throws on multiple matches —
    // and the fix that "works" (`getAllByRole(...)[0]`) pins this test to the
    // pane ORDER, which is exactly how it previously came to drive the wrong
    // control and pass for four commits.
    const trigger = screen.getByRole("combobox", { name: /Authoring position/i });
    fireEvent.keyDown(trigger, { key: "Enter" });
    const subjectOption = await screen.findByRole("option", { name: /^Subject$/ });
    fireEvent.click(subjectOption);

    // Polled by hand and asserted as a BOOLEAN. `waitFor(() =>
    // expect(queryByText(...)).toBeNull())` serialises the entire container on
    // timeout, and with Radix's portal that is a two-million-line dump which
    // buries the actual failure and makes a red CI run unreadable.
    await waitFor(() => expect(screen.queryByRole("option")).toBeNull());
    const stillShowingStaleRadius = screen.queryByText(/At least 2 published/) !== null;
    expect(stillShowingStaleRadius).toBe(false);
  });

  test("⚠️ a preview that lands AFTER a reset does not re-arm the gate", async () => {
    // The async half. Every reset is synchronous and none of them invalidated an
    // in-flight request, so the response for the abandoned decision arrived
    // afterwards and repopulated the slot — re-enabling the write button with a
    // number computed for a pair nobody was authoring.
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    holdPreview = gate;

    renderPage();
    await pickBothNorms();
    fireEvent.click(screen.getByRole("button", { name: /Preview the impact/i }));

    // Abandon the decision while the preview is still in flight.
    fireEvent.click(screen.getAllByRole("button", { name: /^Change$/ })[0]!);
    await waitFor(() => expect(screen.getAllByText("is priced at").length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText("is priced at")[0]!);

    // …then let the stale response land.
    release!();
    await gate;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(authorDisabled()).toBe(true);
  });
});
