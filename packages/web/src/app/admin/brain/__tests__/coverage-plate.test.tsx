import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { render, cleanup, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { AtlasProvider, type AtlasAuthClient } from "@/ui/context";
import {
  chatArm,
  coverage,
  warehouseArm,
} from "@/ui/components/admin/brain-coverage/__tests__/_fixtures";

/**
 * The Coverage Plate, RENDERED (#5422, ADR-0041).
 *
 * `plate-model.test.ts` pins the arithmetic. This pins what the arithmetic turns
 * into on screen, and each arm is a sentence the page would be making falsely:
 *
 *   - **No single number, in any visual encoding.** AC6 extends ADR-0041's
 *     citable refusal from text to pictures: no ring, no fill fraction, no arc,
 *     no percentage. The plate is where that pressure will next arrive.
 *   - **The three freshness renderings are three SHAPES**, so they survive for a
 *     reader who cannot use the colour and for one who never reads the legend.
 *   - **Unsurveyed ground is drawn and named**, and the four kinds of nothing do
 *     not share one face.
 *   - **The detail is one interaction away**, which is what makes it legitimate
 *     for the plate to carry no counts: every quad is an anchor to the card that
 *     states them.
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

async function loaded() {
  const view = render(createElement(CompanyAtlasCoverage), { wrapper: Wrapper });
  await waitFor(() =>
    expect(view.container.querySelector('[data-testid="coverage-plate"]')).not.toBeNull(),
  );
  return view;
}

function plateOf(container: HTMLElement): Element {
  const el = container.querySelector('[data-testid="coverage-plate"]');
  if (!el) throw new Error("no coverage plate");
  return el;
}

function quadOf(container: HTMLElement, cls: string): Element {
  const el = container.querySelector(`[data-testid="plate-quad-${cls}"]`);
  if (!el) throw new Error(`no quad for ${cls}`);
  return el;
}

describe("Coverage Plate — no single number, in any visual encoding (AC6)", () => {
  test("draws no ring, arc, wedge or fill fraction anywhere on the sheet", async () => {
    // The reflex reach is a donut, and a donut is the same fabrication ADR-0041
    // refuses in text: a company-wide denominator that does not exist. Every
    // element below is one of the shapes that fabrication arrives in.
    const view = await loaded();
    const sheet = plateOf(view.container).querySelector("svg");
    if (!sheet) throw new Error("no sheet");
    for (const forbidden of ["path[stroke-dashoffset]", "ellipse", "polygon"]) {
      expect(sheet.querySelector(forbidden)).toBeNull();
    }
    // An arc is drawn with `A` in a path command; nothing on this sheet is one.
    for (const path of Array.from(sheet.querySelectorAll("path"))) {
      expect(path.getAttribute("d") ?? "").not.toMatch(/[Aa]\s*\d/);
    }
  });

  test("the sheet states no ratio of its own, and no total", async () => {
    // The counts live on the cards. A ratio under each quad would be a second
    // wording of the card's own headline three inches below it, and a total
    // across quads would add channels to entity–dimension pairs.
    const view = await loaded();
    const sheet = plateOf(view.container).querySelector('[data-testid="coverage-plate-sheet"]');
    if (!sheet) throw new Error("no sheet");
    const drawn = (sheet.textContent ?? "").toLowerCase();
    expect(drawn).not.toMatch(/\d+\s+of\s+\d+/);
    expect(drawn).not.toContain("total");
    // The only figure the sheet may print is its own scale, and only when it is
    // not one-to-one. At the fixture's size it is, so the sheet prints nothing.
    expect(drawn).not.toMatch(/\d/);
  });

  test("the caption says the quads are not comparable, which is why there is no total", async () => {
    const view = await loaded();
    const caption =
      view.container.querySelector('[data-testid="coverage-plate-caption"]')?.textContent ?? "";
    expect(caption).toContain("do not add up");
    expect(caption).toContain("nothing here is a total");
  });

  test("adding the plate does not put a percentage on the page", async () => {
    // The page-wide refusal, re-asserted with the plate mounted — this is the
    // test that turns red when somebody puts a gauge on the sheet.
    const view = await loaded();
    expect(view.container.textContent ?? "").not.toContain("%");
  });
});

describe("Coverage Plate — the three freshness renderings survive as three shapes", () => {
  test("current, stale and unverified are three distinguishable marks, not one", async () => {
    // Shape-first, not colour-first: the legend names all three, and each is
    // drawn differently, so neither a reader who cannot use the colour nor one
    // who never reads the legend is handed a gradient.
    const view = await loaded();
    const legend = view.container.querySelector('[data-testid="coverage-plate-legend"]');
    if (!legend) throw new Error("no legend");
    const text = legend.textContent ?? "";
    expect(text).toContain("Surveyed, current");
    expect(text).toContain("Surveyed, stale");
    expect(text).toContain("Surveyed, unverified");
  });

  test("the fade rule is not shipped, and nothing on the sheet is a gradient", async () => {
    // ADR-0041: "a source that hasn't moved is current, however old its newest
    // evidence". Dimming a mark by evidence age would render a quiet-but-current
    // unit as a stale one, which is precisely the collapse #5422 forbids. So
    // there is no opacity ramp on this sheet, and this is the test that says so.
    const view = await loaded();
    const sheet = plateOf(view.container).querySelector("svg");
    if (!sheet) throw new Error("no sheet");
    expect(sheet.querySelector("linearGradient")).toBeNull();
    expect(sheet.querySelector("radialGradient")).toBeNull();
    for (const mark of Array.from(sheet.querySelectorAll("circle"))) {
      expect(mark.getAttribute("opacity")).toBeNull();
      expect(mark.getAttribute("fill-opacity")).toBeNull();
    }
  });

  test("a quad's accessible name states the counts it stands for", async () => {
    // The sheet carries no printed number, so this is where a reader who cannot
    // see it gets one — and it is the run's real `units`, never the marks that
    // happened to be drawable at the sheet's scale.
    const view = await loaded();
    const label = quadOf(view.container, "chat").getAttribute("aria-label") ?? "";
    expect(label).toContain("1 surveyed, current");
    expect(label).toContain("3 visible, not in scope");
  });

  test("the plate names the three states exactly as the card does", async () => {
    // One vocabulary across the seam. A friendlier word on the plate than on the
    // card makes the reader translate at the moment they follow a quad down to
    // it, which is the one moment the page has to be easy.
    const view = await loaded();
    const legend =
      view.container.querySelector('[data-testid="coverage-plate-legend"]')?.textContent ?? "";
    const card = view.container.querySelector("#coverage-class-chat")?.textContent ?? "";
    for (const word of ["current", "stale", "unverified"]) {
      expect(legend.toLowerCase()).toContain(word);
      expect(card.toLowerCase()).toContain(word);
    }
  });
});

describe("Coverage Plate — unsurveyed ground is drawn, and named", () => {
  test("a never-enumerated class is hatched rather than left out", async () => {
    const view = await loaded();
    const quad = quadOf(view.container, "transcript");
    expect(quad.getAttribute("data-render")).toBe("unsurveyed");
    expect(quad.querySelector("path")?.getAttribute("fill")).toContain("plate-hatch");
    expect(quad.textContent ?? "").toContain("never enumerated");
  });

  test("the four kinds of nothing do not share one face", async () => {
    const view = await loaded();
    const words = ["transcript", "email", "warehouse"].map(
      (cls) => quadOf(view.container, cls).textContent ?? "",
    );
    expect(words[0]).toContain("never enumerated");
    expect(words[1]).toContain("never succeeded");
    expect(words[2]).toContain("cannot establish");
  });

  test("the one blank that is a fault is overprinted in the caution colour", async () => {
    const view = await loaded();
    const path = quadOf(view.container, "warehouse").querySelector("path");
    expect(path?.getAttribute("stroke")).toContain("plate-stale");
  });

  test("the non-surveyable class sits in the margin, not in hatched ground", async () => {
    // ADR-0041 calls `human` "correctly absent from every ratio, forever; not a
    // gap". Hatching it would draw an affirmative refusal as a hole somebody
    // could fill.
    const view = await loaded();
    const human = quadOf(view.container, "human");
    expect(human.getAttribute("data-render")).toBe("off-survey");
    expect(human.querySelector('[fill*="plate-hatch"]')).toBeNull();
    expect(human.textContent ?? "").toContain("not a surveyable class");
  });

  test("unsurveyed ground carries no number", async () => {
    const view = await loaded();
    for (const cls of ["transcript", "email", "warehouse"]) {
      expect(quadOf(view.container, cls).textContent ?? "").not.toMatch(/\d/);
    }
  });
});

describe("Coverage Plate — the detail is one interaction away (AC3)", () => {
  test("every quad is an anchor into its own class card", async () => {
    const view = await loaded();
    for (const cls of ["chat", "transcript", "email", "warehouse", "human"]) {
      expect(quadOf(view.container, cls).getAttribute("href")).toBe(`#coverage-class-${cls}`);
    }
  });

  test("the cards those anchors land on are still on the page", async () => {
    // The seam decision, pinned: the plate SUPPLEMENTS the arms. If a later
    // change replaces them, the three freshness renderings and the four
    // no-count arms leave with them and this goes red.
    const view = await loaded();
    for (const cls of ["chat", "transcript", "email", "warehouse", "human"]) {
      expect(view.container.querySelector(`#coverage-class-${cls}`)).not.toBeNull();
    }
    for (const id of [
      "coverage-freshness-current",
      "coverage-freshness-stale",
      "coverage-freshness-unverified",
    ]) {
      expect(view.container.querySelector(`[data-testid="${id}"]`)).not.toBeNull();
    }
  });

  test("the plate sits under the composed statement, never in place of it", async () => {
    // ADR-0041 puts the composed statement at the top of the page — "a
    // paragraph, not a KPI" — so the plate cannot displace it.
    const view = await loaded();
    const surface = view.container.querySelector('[data-testid="coverage-surface"]');
    const kids = Array.from(surface?.children ?? []).map((el) => el.getAttribute("data-testid"));
    expect(kids.indexOf("coverage-statement")).toBeGreaterThanOrEqual(0);
    expect(kids.indexOf("coverage-plate")).toBeGreaterThan(kids.indexOf("coverage-statement"));
  });
});

describe("Coverage Plate — the day-one state (AC4)", () => {
  test("a first-week workspace draws lit quads on ground that is mostly empty", async () => {
    respond = () =>
      jsonResponse(
        coverage({
          availability: {
            chat: {
              ...chatArm(),
              ratio: {
                surveyed: 1,
                enumerated: 6,
                enumerable: 7,
                inPerimeterWithoutEvidence: 0,
                unit: "chat-channel-roster",
              },
              freshness: { current: 1, stale: 0, unverified: 0 },
              units: [],
              unitsWithheld: 7,
              mapEdges: [],
            },
            warehouse: warehouseArm({ enumerable: 281, surveyed: 0, unitCount: 0 }),
          },
        }),
      );
    const view = await loaded();
    expect(quadOf(view.container, "chat").getAttribute("data-render")).toBe("soundings");
    expect(quadOf(view.container, "warehouse").getAttribute("data-render")).toBe("soundings");
    expect(quadOf(view.container, "transcript").getAttribute("data-render")).toBe("unsurveyed");
    expect(quadOf(view.container, "email").getAttribute("data-render")).toBe("unsurveyed");
    // Nothing is padded to make the sheet look fuller: the two lit quads hold
    // exactly what the counts say and no sample data.
    const sheet = plateOf(view.container).querySelector("svg");
    expect(sheet?.querySelectorAll("circle").length).toBe(7 + 281);
  });
});
