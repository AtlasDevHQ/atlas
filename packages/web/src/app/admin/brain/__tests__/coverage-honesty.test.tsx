import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { AtlasProvider, type AtlasAuthClient } from "@/ui/context";
// The fixtures are SHARED with `coverage-statement.test.ts` — one typed
// builder, so a wire-shape change cannot leave one suite green against a shape
// the other has already moved past.
import {
  chatArm,
  coverage,
  warehouseArm,
} from "@/ui/components/admin/brain-coverage/__tests__/_fixtures";

/**
 * The Coverage Surface's RENDERING RULES (#5215, ADR-0041).
 *
 * ADR-0041 is explicit that these are decisions rather than styling, so each one
 * gets an arm here. Every assertion below is a sentence the page would be making
 * falsely if it broke:
 *
 *   - **There is no single number, permanently.** Not a percentage anywhere, not
 *     a gauge, not a company-wide denominator. The pressure for one will arrive
 *     as a dashboard ring; this is the test that turns red when it does.
 *   - **Every denominator is credential-relative and dated.** A bare "1 of 2" is
 *     read as coverage OF THE COMPANY, which is the one claim this page can
 *     never support.
 *   - **The unenumerable is a MARK, structurally without a number.** "We
 *     estimate 40% of channels are invisible" is fabrication by construction, so
 *     the map-edge region is asserted digit-free.
 *   - **Stale, unverified-since and quiet-but-current are three renderings, never
 *     conflated.** Only one of the three is a measurement, and the page must not
 *     flatten them into a traffic light.
 *   - **A degraded counter renders the cannot-establish arm, never a zero.** A
 *     silent zero here is a false statement, not an error state.
 *   - **Labels appear only where the wire shape provides them.** The two-clause
 *     policy is server-side; a client that fell back to a vendor id would name
 *     a channel — or a mailbox, which is a person — that no clause admitted.
 */

void mock.module("next/navigation", () => ({
  usePathname: () => "/admin/brain",
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const stubAuthClient: AtlasAuthClient = {
  signIn: { email: async () => ({}) },
  signUp: { email: async () => ({}) },
  signOut: async () => {},
  useSession: () => ({ data: null, isPending: false }),
};

const CompanyAtlasCoverage = (await import("../page")).default;

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

const SLACK_VITALS = { scopeMode: "membership", inScopeCount: 0, sync: null, channels: [] };

const originalFetch = globalThis.fetch;
let respond: () => Response;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  respond = () => jsonResponse(coverage());
  testQueryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    return url.includes("brain-slack") ? jsonResponse(SLACK_VITALS) : respond();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  testQueryClient.clear();
  cleanup();
});

function renderPage() {
  return render(createElement(CompanyAtlasCoverage), { wrapper: Wrapper });
}

/** Waits for the composed statement, which only renders once the read landed. */
async function loaded() {
  const view = renderPage();
  await waitFor(() =>
    expect(view.container.querySelector('[data-testid="coverage-statement"]')).not.toBeNull(),
  );
  return view;
}

function textOf(container: HTMLElement, testId: string): string {
  const el = container.querySelector(`[data-testid="${testId}"]`);
  if (!el) throw new Error(`no element with data-testid="${testId}"`);
  return el.textContent ?? "";
}

describe("Coverage Surface — no single number, permanently (ADR-0041)", () => {
  test("renders no percentage anywhere on the page", async () => {
    // The citable refusal, as a test. A ring, a score, or "just an approximate
    // blend" are the same proposal: a company-wide denominator that does not
    // exist. Any of them arrives on screen as a `%`.
    const view = await loaded();
    expect(view.container.textContent ?? "").not.toContain("%");
  });

  test("states the ratio only as parts of ITS OWN unit, and says so", async () => {
    const view = await loaded();
    const chat = view.container.querySelector('[data-testid="coverage-class-chat"]');
    if (!chat) throw new Error("no chat class card");
    const text = chat.textContent ?? "";

    expect(text).toContain("3 of 7 chat channels");
    // The caption is not decoration: without it the number reads as coverage of
    // the company, which is the claim this page can never support.
    expect(text).toContain("of the channels Atlas's chat credentials can see");
    // …and its date, because "as of" is part of the statement rather than an
    // apology for it.
    expect(text).toContain("as of");
  });

  test("never claims a denominator over the company itself", async () => {
    const view = await loaded();
    const text = (view.container.textContent ?? "").toLowerCase();
    expect(text).not.toContain("of the company");
    expect(text).not.toContain("company-wide");
    expect(text).not.toContain("overall coverage");
  });
});

describe("Coverage Surface — the unenumerable is a mark (ADR-0041)", () => {
  test("the map edge renders as a sentence with no number in it", async () => {
    // "We estimate 40% of channels are invisible" is fabrication by
    // construction, so this region is asserted DIGIT-FREE rather than merely
    // percentage-free — a count of what is beyond the edge is the same
    // invention wearing a different notation.
    const view = await loaded();
    const marks = textOf(view.container, "coverage-map-edges");
    expect(marks).toContain("beyond the ones counted here");
    expect(marks).not.toMatch(/\d/);
  });

  test("a class with no map edges prints no all-clear about what it cannot see", async () => {
    // The absence of edges is already said by the ratio's caption. A printed
    // "the map is complete" would be a claim about the unenumerable, which is
    // the one thing nothing here can establish.
    respond = () =>
      jsonResponse(coverage({ availability: { chat: { ...chatArm(), mapEdges: [] } } }));
    const view = await loaded();
    expect(view.container.querySelector('[data-testid="coverage-map-edges"]')).toBeNull();
    expect(view.container.querySelector('[data-testid="coverage-statement-map-edges"]')).toBeNull();
    expect((view.container.textContent ?? "").toLowerCase()).not.toContain("map is complete");
  });
});

describe("Coverage Surface — three freshness renderings, never conflated (ADR-0041)", () => {
  test("stale carries its own arithmetic, so the verdict can be checked", async () => {
    const view = await loaded();
    const stale = view.container.querySelector('[data-testid="coverage-freshness-stale"]');
    if (!stale) throw new Error("no stale rendering");
    const text = stale.textContent ?? "";
    // Both instants travel. A badge that said only "stale" would be a judgment;
    // ADR-0041 admits stale only as a measured divergence.
    // Both instants still travel, just not twice: the vendor movement sits on
    // the verdict, the evidence age is the row's own column. A badge that said
    // only "stale" would be a judgment; ADR-0041 admits it only as a measured
    // divergence, so the reader must be able to check both halves.
    expect(text).toContain("the source moved on");
    expect(stale.closest("div")?.textContent ?? "").toContain("newest evidence");
  });

  test("unverified-since carries a real date and its reason, and is not called stale", async () => {
    const view = await loaded();
    const unverified = view.container.querySelector(
      '[data-testid="coverage-freshness-unverified"]',
    );
    if (!unverified) throw new Error("no unverified rendering");
    const text = unverified.textContent ?? "";
    expect(text).toContain("unverified since");
    expect(text).toContain("the rotation has not asked this source about it yet");
    expect(text.toLowerCase()).not.toContain("stale");
  });

  test("quiet-but-current says when the source was asked, not merely that it is fine", async () => {
    // "Current" is a claim about the present resting on a reading taken in the
    // past, and the probe rotation is bounded. A bare green tick would let a
    // reading of unbounded age assert a present-tense all-clear.
    const view = await loaded();
    const current = view.container.querySelector('[data-testid="coverage-freshness-current"]');
    if (!current) throw new Error("no current rendering");
    expect(current.textContent ?? "").toContain("the source was asked on");
  });

  test("the three arms are visually distinct elements, not one badge", async () => {
    const view = await loaded();
    for (const id of [
      "coverage-freshness-current",
      "coverage-freshness-stale",
      "coverage-freshness-unverified",
    ]) {
      expect(view.container.querySelector(`[data-testid="${id}"]`)).not.toBeNull();
    }
  });

  test("the per-class tally covers withheld units too", async () => {
    // "3 of 12 surveyed mailboxes are stale" is a COUNT, and counts are always
    // disclosable — which is why withholding a name costs the admin nothing
    // they are entitled to.
    const view = await loaded();
    const tally = textOf(view.container, "coverage-freshness");
    expect(tally).toContain("1 current");
    expect(tally).toContain("1 stale");
    expect(tally).toContain("1 unverified");
  });
});

describe("Coverage Surface — thin is the reader's judgment, so give them what to judge with (ADR-0041)", () => {
  test("every surveyed unit carries its own evidence age, not just the stale one", async () => {
    // The half that was missing: `newestEvidenceAt` was rendered inside the
    // `stale` sentence alone, so a `current` or `unverified` unit handed the
    // reader a verdict and no age. "The judgment is the reader's" only works if
    // the reader is given the counts to make it.
    const view = await loaded();
    const ages = Array.from(
      view.container.querySelectorAll('[data-testid="coverage-evidence-age"]'),
    );
    // Three SURVEYED units in the fixture; the fourth is enumerated and has no
    // evidence to date — an age on that one would be an all-clear about a source
    // Atlas has never read.
    expect(ages).toHaveLength(3);
    for (const age of ages) expect(age.textContent ?? "").toContain("newest evidence");
  });

  test("orders surveyed units by oldest evidence, and hangs no verdict on the order", async () => {
    // "Counts sorted and comparable, judgment left to the reader." Alphabetical
    // made the list findable and the comparison impossible.
    const view = await loaded();
    // Selected by ROW testid rather than by DOM nesting: the arms gained a
    // wrapper each when the list was bounded (#5357), and a `> div` selector
    // would have gone quietly green over the wrong elements.
    const labels = Array.from(view.container.querySelectorAll('[data-testid="coverage-unit-row"]'))
      .map((row) => row.querySelector("span")?.textContent ?? "");
    // #archive (May) → #launch (Jul) → #general (Aug), then the enumerated one.
    expect(labels).toEqual(["#archive", "#launch", "#general", "#incidents"]);
    // …and nothing labels the oldest one thin. No badge, no threshold copy.
    const units = textOf(view.container, "coverage-units").toLowerCase();
    for (const verdict of ["thin", "needs attention", "at risk", "unhealthy"]) {
      expect(units).not.toContain(verdict);
    }
  });
});

describe("Coverage Surface — a card states what it covers, it does not list it (#5357)", () => {
  /** Renders the page with a warehouse arm at the given denominator. */
  async function warehouseCard(opts: Parameters<typeof warehouseArm>[0]) {
    respond = () => jsonResponse(coverage({ availability: { warehouse: warehouseArm(opts) } }));
    const view = await loaded();
    const card = view.container.querySelector('[data-testid="coverage-class-warehouse"]');
    if (!(card instanceof HTMLElement)) throw new Error("no warehouse card");
    return card;
  }

  const rows = (card: HTMLElement) =>
    card.querySelectorAll('[data-testid="coverage-unit-row"]').length;

  test("the default render is not proportional to the denominator", async () => {
    // THE invariant, and deliberately stated without a number. The defect was a
    // card that grew with the workspace: 281 pairs rendered 200 rows and buried
    // the other four classes, and it would have rendered 200 again at 2,810
    // while reading as though nothing were wrong.
    //
    // Asserting a fixed row count would go green against a render that DID track
    // the denominator and merely happened to land on that number for one
    // fixture — so the assertion is a comparison between two denominators.
    const small = rows(await warehouseCard({ enumerable: 281 }));
    cleanup();
    const large = rows(await warehouseCard({ enumerable: 2810 }));
    expect(large).toBe(small);
    // The other half: both responses ship 200 units, and the card must not
    // render them. Bounded against the rows the WIRE handed it, not only against
    // the count it states.
    expect(small).toBeLessThanOrEqual(10);
  });

  test("every count renders outside the disclosure, with the list collapsed", async () => {
    // The characteristic failure of a disclosure is the counts collapsing along
    // with the list it was added for.
    const card = await warehouseCard({ enumerable: 281 });
    const text = card.textContent ?? "";
    expect(card.querySelector('[data-testid="coverage-ratio"]')?.textContent).toContain(
      "4 of 281",
    );
    expect(text).toContain("277 are visible to Atlas and unsurveyed");
    expect(card.querySelector('[data-testid="coverage-freshness"]')).not.toBeNull();
    expect(card.querySelector('[data-testid="coverage-denominator-caption"]')).not.toBeNull();
  });

  test("the preview is the first units of the existing order, never a re-sort", async () => {
    // A bound that re-sorted would be a verdict about which units deserve to be
    // seen — the badge ADR-0041 refuses. Surveyed sorts oldest-evidence-first,
    // and the fixture's ages DESCEND with the index, so the last-authored unit
    // must lead. Alphabetical order would put `dim_000` first.
    const card = await warehouseCard({ enumerable: 281, surveyed: 4 });
    const labels = Array.from(
      card.querySelectorAll(
        '[data-testid="coverage-unit-arm-surveyed"] [data-testid="coverage-unit-row"]',
      ),
    ).map((row) => row.querySelector("span")?.textContent ?? "");
    expect(labels[0]).toBe("organization.dim_003");
  });

  test("the control names the state, and carries no count and no definite article", async () => {
    const card = await warehouseCard({ enumerable: 281 });
    const trigger = card.querySelector('[data-testid="coverage-unit-more-enumerated"]');
    const label = trigger?.textContent ?? "";
    expect(label).toBe("Show more unsurveyed entity–dimension pairs");
    // No count: this control reveals 196 of the 277 stated above it, so a number
    // here is either false or reads as a defect. And no "the": a totality claim
    // the control cannot keep.
    expect(label).not.toMatch(/[0-9]/);
    expect(label).not.toContain("the ");
  });

  test("expanding reveals the rest and every count is still on the card", async () => {
    const card = await warehouseCard({ enumerable: 281 });
    const before = rows(card);
    const trigger = card.querySelector('[data-testid="coverage-unit-more-enumerated"]');
    if (!(trigger instanceof HTMLElement)) throw new Error("no disclosure control");
    fireEvent.click(trigger);
    await waitFor(() => expect(rows(card)).toBeGreaterThan(before));
    const text = card.textContent ?? "";
    expect(card.querySelector('[data-testid="coverage-ratio"]')?.textContent).toContain(
      "4 of 281",
    );
    expect(text).toContain("277 are visible to Atlas and unsurveyed");
  });

  test("the clipped-listing sentence names its rule, carries no number, and precedes its rows", async () => {
    // It cannot carry a number: the cap is `COVERAGE_UNITS_MAX` in `@atlas/api`,
    // which the frontend does not import and the wire does not carry. A restated
    // "200" would be a second copy of a constant across an HTTP boundary with
    // nothing keeping the two in step.
    const card = await warehouseCard({ enumerable: 281 });
    // Collapsed, there is no listing for a caption to be ABOUT — so there is no
    // caption. That is the placement rule, asserted rather than assumed.
    expect(card.querySelector('[data-testid="coverage-units-truncated"]')).toBeNull();

    const trigger = card.querySelector('[data-testid="coverage-unit-more-enumerated"]');
    if (!(trigger instanceof HTMLElement)) throw new Error("no disclosure control");
    fireEvent.click(trigger);
    await waitFor(() =>
      expect(card.querySelector('[data-testid="coverage-units-truncated"]')).not.toBeNull(),
    );
    const note = card.querySelector('[data-testid="coverage-units-truncated"]');
    const text = note?.textContent ?? "";
    expect(text).toContain("sort earliest");
    expect(text).toContain("later names are not listed");
    expect(text).not.toMatch(/[0-9]/);

    // BEFORE the rows it describes. At 196 revealed rows a note placed after the
    // list is 196 rows from where the reader starts — the original defect in
    // miniature.
    const arm = card.querySelector('[data-testid="coverage-unit-arm-enumerated"]');
    if (!arm) throw new Error("no enumerated arm");
    const order = Array.from(
      arm.querySelectorAll(
        '[data-testid="coverage-units-truncated"], [data-testid="coverage-unit-row"]',
      ),
    ).map((el) => el.getAttribute("data-testid"));
    expect(order.indexOf("coverage-units-truncated")).toBeLessThan(
      order.lastIndexOf("coverage-unit-row"),
    );
    expect(order[order.length - 1]).toBe("coverage-unit-row");
  });

  test("the warehouse card has no withheld disclosure — clipping is its only absence", async () => {
    // Two absences, opposite remedies (`CONTEXT.md` → "clipped listing"). The
    // warehouse cannot withhold: the admin authored the semantic layer, so
    // `deliberateAct` is unconditionally true and every unit is namable. A
    // withheld sentence here would be a disclosure about nothing.
    const card = await warehouseCard({ enumerable: 281 });
    expect(card.querySelector('[data-testid="coverage-withheld"]')).toBeNull();
  });
});

describe("Coverage Surface — degradation renders an arm, never a zero (ADR-0041)", () => {
  test("cannot-establish says so, with no number in it", async () => {
    const view = await loaded();
    const warehouse = view.container.querySelector('[data-testid="coverage-class-warehouse"]');
    if (!warehouse) throw new Error("no warehouse class card");
    const text = warehouse.textContent ?? "";
    expect(text).toContain("cannot establish anything about");
    // The whole point of the arm: a zero here would read as a measured empty
    // roster rather than a class this deployment cannot account for.
    expect(text).not.toMatch(/\d/);
    // And it is an error, not body copy an eye slides past.
    expect(warehouse.querySelector('[role="alert"]')).not.toBeNull();
  });

  test("never-enumerated is distinguished from an enumeration that has always failed", async () => {
    const view = await loaded();
    const transcript = textOf(view.container, "coverage-class-transcript");
    const email = textOf(view.container, "coverage-class-email");

    expect(transcript).toContain("Never enumerated");
    expect(transcript).not.toMatch(/\d/);
    // The second carries an attempt and the enumerator's own reason — the
    // sentence that names something to fix.
    expect(email).toContain("has never succeeded");
    expect(email).toContain("Microsoft Graph refused the mailbox listing.");
  });

  test("not-surveyable is an affirmative statement, not a gap", async () => {
    const view = await loaded();
    const human = textOf(view.container, "coverage-class-human");
    expect(human).toContain("Not a surveyable class");
    expect(human).toContain("does not enumerate people");
    expect(human).not.toMatch(/\d/);
  });

  test("countsConsistent: false renders a caveat ON the statement, not a blank page", async () => {
    // The flag says the arithmetic between the arms disagreed. Every sentence is
    // still the best Atlas can say, so this is a banner rather than a refusal to
    // render — and the parts must still be there beneath it.
    respond = () => jsonResponse(coverage({ countsConsistent: false }));
    const view = await loaded();
    const caveat = view.container.querySelector('[data-testid="coverage-caveat"]');
    if (!caveat) throw new Error("no caveat rendered for countsConsistent: false");
    expect(caveat.getAttribute("role")).toBe("alert");
    expect(textOf(view.container, "coverage-statement-availability")).toContain("Atlas surveys");
  });

  test("an enumeration that has since failed captions the dated counts rather than clearing them", async () => {
    respond = () =>
      jsonResponse(
        coverage({
          availability: {
            chat: {
              ...chatArm(),
              unavailable: {
                since: "2026-08-19T02:00:00.000Z",
                reason: "Slack returned 429 for the channel listing.",
              },
            },
          },
        }),
      );
    const view = await loaded();
    const chat = textOf(view.container, "coverage-class-chat");
    // The counts survive — they are the last ones that succeeded, not wrong.
    expect(chat).toContain("3 of 7 chat channels");
    expect(chat).toContain("Enumeration has been unavailable since");
    expect(chat).toContain("These counts are the last that succeeded");
    expect(chat).toContain("Slack returned 429 for the channel listing.");
  });
});

describe("Coverage Surface — the authority arm survives inside the statement (ADR-0041)", () => {
  test("the backlog counts are the WORKSPACE totals, not this reader's queue", async () => {
    // ADR-0041 keeps the old overview's counts, reframed. The number the publish
    // button acts on is workspace-wide (7), not the four this reviewer can see —
    // rendering the reader-scoped total under an admin-wide verb is how a hidden
    // backlog gets published unseen.
    const view = await loaded();
    const tiles = view.container.textContent ?? "";
    expect(tiles).toContain("Awaiting review");
    expect(tiles).toContain("7");
  });

  test("the hidden backlog is stated once, in one wording, in both placements", async () => {
    // Two placements are deliberate — one reader scans the paragraph, the other
    // the tiles — and two WORDINGS would be the drift hazard, so both render
    // `hiddenBacklogSentence`.
    const view = await loaded();
    const beside = textOf(view.container, "coverage-hidden-backlog");
    expect(beside).toContain("3 of the drafts awaiting review are not visible to you");
    expect(textOf(view.container, "coverage-statement-authority")).toContain(beside);
  });
});

describe("Coverage Surface — labels only where the wire provides them (ADR-0041)", () => {
  test("names the units the server labelled and no others", async () => {
    const view = await loaded();
    const units = view.container.querySelector('[data-testid="coverage-units"]');
    if (!units) throw new Error("no unit list");
    const text = units.textContent ?? "";
    expect(text).toContain("#general");
    expect(text).toContain("#incidents");
    // Four labelled units on the wire, four rendered — the client never mints a
    // fifth from an id, a count, or a placeholder.
    expect(view.container.querySelectorAll('[data-testid="coverage-unit-row"]')).toHaveLength(4);
  });

  test("never falls back to a vendor id when a name is absent", async () => {
    // The failure this guards: a `label ?? unitId` would name a channel — or a
    // mailbox, which is naming a person — that no clause admitted.
    const view = await loaded();
    const text = view.container.textContent ?? "";
    for (const id of ["C0001", "C0002", "C0003", "C0004"]) {
      expect(text).not.toContain(id);
    }
  });

  test("withheld units are disclosed as a count, with no hint at which ones", async () => {
    const view = await loaded();
    const withheld = textOf(view.container, "coverage-withheld");
    expect(withheld).toContain("3 further chat channels");
    expect(withheld).toContain("not listed");
  });
});
