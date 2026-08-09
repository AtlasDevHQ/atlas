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
    if (url.includes("/brain-vocabulary/preview")) {
      previewCalls.push(init?.body);
      const held = holdPreview;
      if (held !== null) {
        holdPreview = null;
        return held.then(() =>
          jsonResponse({
            radius: {
              kind: "computed",
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
    // A separate reset site (`page.tsx`'s position select), and the staler of
    // the two: the radius would be for a different POSITION entirely, whose
    // population and blast radius have nothing to do with the new one.
    renderPage();
    await pickBothNorms();
    fireEvent.click(screen.getByRole("button", { name: /Preview the impact/i }));
    await waitFor(() => expect(authorDisabled()).toBe(false));

    // The select is a shadcn/Radix trigger; changing it clears both picks AND
    // the radius, so the assertion is that the preview banner is gone rather
    // than only that the button is disabled.
    expect(screen.queryByText(/At least 2/)).not.toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: /^Change$/ })[0]!);
    await waitFor(() => expect(screen.queryByText(/At least 2/)).toBeNull());
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
