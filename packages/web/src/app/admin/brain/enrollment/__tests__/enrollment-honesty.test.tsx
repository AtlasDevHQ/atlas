import { describe, expect, test, afterEach, beforeEach, mock } from "bun:test";
import { render, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { AtlasProvider, type AtlasAuthClient } from "@/ui/context";
import { BrainWarehouseRunResponseSchema } from "@/ui/lib/admin-schemas";

/**
 * The enrollment surface's honesty rules (#5196, ADR-0039).
 *
 * Three pairs of states this page must never render identically. Each is a
 * failure the page would otherwise report as a fact about the workspace:
 *
 *   1. **"nothing is enrolled"** vs **"we could not find out"**. The first is a
 *      correct and expected starting state — ADR-0039's whole point is that the
 *      producer reaches nothing until a human acts. The second is a failure, and
 *      rendering it as the first tells an admin their reach is empty on the one
 *      request that could not answer.
 *   2. **"your semantic layer is empty"** vs **"we could not read it"**, on its
 *      own fetch, which is why the two lists are two requests.
 *   3. **"un-enrolled"** vs **"retracted"**. "Un-enroll" reads as "stop knowing
 *      this", and an admin who believed that would reach for this button to try
 *      to take back a published claim.
 *
 * Every prohibition below is paired with a positive control, because a page that
 * rendered nothing at all would satisfy all three `not.toContain` assertions.
 */

/**
 * ⚠️ The factory must stay SYNC (an async one deadlocks `bun:test`), and the export
 * list has to be complete rather than the three hooks this page happens to call
 * today. A partial `mock.module` replaces the whole module, so the first shadcn
 * primitive or provider that reaches for `useParams()` dies with a `TypeError` that
 * reads as a React bug rather than as a missing mock.
 */
void mock.module("next/navigation", () => ({
  usePathname: () => "/admin/brain/enrollment",
  useRouter: () => ({
    push: () => {},
    replace: () => {},
    back: () => {},
    forward: () => {},
    refresh: () => {},
    prefetch: () => {},
  }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  useSelectedLayoutSegment: () => null,
  useSelectedLayoutSegments: () => [],
  useServerInsertedHTML: () => {},
  redirect: () => {
    throw new Error("redirect() called in a test");
  },
  permanentRedirect: () => {
    throw new Error("permanentRedirect() called in a test");
  },
  notFound: () => {
    throw new Error("notFound() called in a test");
  },
  ReadonlyURLSearchParams: URLSearchParams,
}));

const stubAuthClient: AtlasAuthClient = {
  signIn: { email: async () => ({}) },
  signUp: { email: async () => ({}) },
  signOut: async () => {},
  useSession: () => ({ data: null, isPending: false }),
};

/** Whether `GET /brain-enrollment` succeeds, so the failure arm is reachable. */
let listFails = false;
/** Whether `GET /brain-enrollment/entities` succeeds. */
let entitiesFail = false;
/** What the write verbs answer, so both halves of the no-op split are reachable. */
let writeChanged = true;
/** Whether the write verbs 403, so the error surfaces are reachable. */
let writeFails = false;
/** The enrolled rows the list endpoint answers with. */
let enrollments: unknown[] = [];
/** The entities the picker endpoint answers with. */
let entities: unknown[] = [
  { name: "accounts", group: null, table: "public.accounts", description: null },
];

/**
 * THREE pairs across TWO entities, deliberately unequal.
 *
 * The page renders `enrollments.length` beside the server's `entityCount`, with
 * a comment claiming the second is the server's number rather than a client-side
 * `new Set(...)`. A one-pair/one-entity fixture makes those two values equal by
 * construction, so no assertion written against it could tell the claim from its
 * opposite.
 */
const THREE_PAIRS_TWO_ENTITIES = [
  {
    entity: "accounts",
    group: null,
    dimension: "arr_band",
    enrolledAt: "2026-08-14T00:00:00.000Z",
    enrolledBy: "user-1",
    note: null,
    // The naming dimension (#5043). ONE of the three, so the "names this
    // entity" badge and the two verbs on the row are exercised against a
    // fixture where the flag is not constant.
    naming: true,
  },
  {
    entity: "accounts",
    group: null,
    dimension: "tier",
    enrolledAt: "2026-08-14T00:00:00.000Z",
    enrolledBy: "user-1",
    note: null,
    naming: false,
  },
  {
    entity: "subscriptions",
    group: null,
    dimension: "plan",
    enrolledAt: "2026-08-14T00:00:00.000Z",
    enrolledBy: "user-2",
    note: null,
    naming: false,
  },
];

/** What `POST /produce` answers, and with what status. */
let runResponse: unknown = {};
let runStatus = 200;

/**
 * Parse a fixture through the wire schema AND narrow it to the complete arm.
 *
 * The narrowing is the second half of the same job: `BrainWarehouseRunResponseSchema`
 * is a discriminated union, so a bare `.parse()` hands back "complete OR degraded"
 * and every fixture field a test wants to vary — `refusals`, `enrolled` — stops
 * existing on the type. Asserting the discriminant here keeps the contract check and
 * leaves callers a concrete shape.
 */
function completeReport(input: unknown) {
  const parsed = BrainWarehouseRunResponseSchema.parse(input);
  if (!parsed.reportComplete) {
    throw new Error("fixture is meant to be a COMPLETE run report");
  }
  return parsed;
}

/**
 * A run where every enrolled pair was refused — `created: 0` with reasons.
 *
 * ⚠️ **PARSED through the wire schema, not just hand-written to match.** Both halves
 * of this file are authored by the same hand — the fixture and the assertions — so
 * without this call nothing checks either against the contract the server actually
 * sends, and the schema gaining a required field would leave these tests green over
 * a payload that can never arrive.
 */
const ALL_REFUSED = completeReport({
  reportComplete: true,
  workspaceId: "ws-1",
  snapshotAt: "2026-08-16T22:15:03.546Z",
  enrolled: 2,
  entities: [],
  refusals: [
    {
      entity: "accounts",
      dimension: "tier",
      reason: "entity-unreadable",
      message: "“accounts” could not be read — check the datasource is reachable.",
    },
    {
      entity: "accounts",
      dimension: "arr_band",
      reason: "entity-unreadable",
      message: "“accounts” could not be read — check the datasource is reachable.",
    },
  ],
  created: 0,
  corroborated: 0,
  entityEdges: {
    kind: "nothing-to-propose",
    entries: 0,
    ambiguous: 0,
    selfEdges: 0,
    unmintedIds: 0,
  },
});

/** What the page POSTed to `/naming`, in order. */
type NamingBody = { entity: string; group: string | null; dimension: string | null };
type EnrollBody = {
  entity: string;
  group: string | null;
  dimension: string;
  note: string | null;
};
const enrollBodies: EnrollBody[] = [];
let namingBodies: NamingBody[] = [];

const originalFetch = globalThis.fetch;

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * Installed in `beforeEach`, not at module scope: the harness's happy-dom
 * preload resets globals after this module evaluates, so a top-level assignment
 * is silently undone and every fetch reaches the real network — which surfaces
 * as an empty page rather than as an obviously broken stub.
 *
 * ⚠️ Order matters in the URL matching. `/brain-enrollment/entities` and
 * `/brain-enrollment/dimensions` both contain `/brain-enrollment`, so the bare
 * list arm has to come LAST or it answers all three with the list payload — and
 * every assertion below would then be reading a page whose picker never loaded.
 */
function installFetchStub() {
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/brain-enrollment/entities")) {
      return Promise.resolve(
        entitiesFail
          ? jsonResponse(
              { error: "server_error", message: "semantic layer unreachable", requestId: "req-1" },
              500,
            )
          : jsonResponse({ entities }),
      );
    }
    if (url.includes("/brain-enrollment/dimensions")) {
      return Promise.resolve(
        jsonResponse({
          entity: "accounts",
          group: null,
          dimensions: [
            {
              name: "arr_band",
              kind: "dimension",
              type: "string",
              description: null,
              enrolled: false,
              naming: false,
            },
          ],
        }),
      );
    }
    if (url.includes("/brain-enrollment/enroll")) {
      enrollBodies.push(JSON.parse(String(init?.body)) as EnrollBody);
      return Promise.resolve(
        writeFails
          ? jsonResponse(
              { error: "not-entitled", message: "you may not enroll", requestId: "req-1" },
              403,
            )
          : jsonResponse({ entity: "accounts", group: null, dimension: "arr_band", changed: writeChanged }),
      );
    }
    if (url.includes("/brain-enrollment/naming")) {
      namingBodies.push(JSON.parse(String(init?.body)) as NamingBody);
      return Promise.resolve(
        writeFails
          ? jsonResponse(
              { error: "not-entitled", message: "you may not rename", requestId: "req-1" },
              403,
            )
          : jsonResponse({
              entity: "accounts",
              group: null,
              // Echoed from the REQUEST, so a page that sent the wrong half is
              // visible in what comes back rather than masked by a constant.
              dimension: (JSON.parse(String(init?.body)) as { dimension: string | null })
                .dimension,
              changed: writeChanged,
            }),
      );
    }
    if (url.includes("/brain-enrollment/unenroll")) {
      return Promise.resolve(
        writeFails
          ? jsonResponse(
              { error: "not-entitled", message: "you may not un-enroll", requestId: "req-1" },
              403,
            )
          : jsonResponse({ entity: "accounts", group: null, dimension: "arr_band", changed: writeChanged }),
      );
    }
    // BEFORE the bare list arm, per the ordering note above — `/produce`
    // contains `/brain-enrollment` and would otherwise be answered with the
    // enrollment list, which parses as a run report with every count absent.
    if (url.includes("/brain-enrollment/produce")) {
      return Promise.resolve(
        runStatus === 200 ? jsonResponse(runResponse) : jsonResponse(runResponse, runStatus),
      );
    }
    if (url.includes("/brain-enrollment")) {
      return Promise.resolve(
        listFails
          ? jsonResponse(
              { error: "server_error", message: "enrollment read blew up", requestId: "req-1" },
              500,
            )
          : jsonResponse({
              enrollments,
              entityCount: new Set(
                (enrollments as { entity: string }[]).map((e) => e.entity),
              ).size,
            }),
      );
    }
    return Promise.resolve(jsonResponse({}));
  }) as unknown as typeof fetch;
}

const BrainEnrollmentPage = (await import("../page")).default;

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
  return render(createElement(BrainEnrollmentPage), { wrapper: Wrapper });
}

/**
 * The rendered text once BOTH fetches have settled.
 *
 * ⚠️ Gated on the two loading strings DISAPPEARING, not on a heading appearing.
 * Every heading here is static, so a `toContain("In the producer’s reach")` gate
 * resolves on the first paint — before either request has answered — and every
 * assertion below then reads the loading state. That is not a flake: it fails
 * uniformly, and it fails in the direction where a `not.toContain` prohibition
 * passes for the wrong reason.
 */
async function settledText(): Promise<string> {
  const { container } = renderPage();
  await waitFor(() => {
    const text = container.textContent ?? "";
    expect(text).not.toContain("Loading what is enrolled…");
    expect(text).not.toContain("Loading your semantic layer…");
  });
  return container.textContent ?? "";
}

beforeEach(() => {
  listFails = false;
  entitiesFail = false;
  writeChanged = true;
  writeFails = false;
  namingBodies = [];
  enrollBodies.length = 0;
  runResponse = ALL_REFUSED;
  runStatus = 200;
  enrollments = [];
  entities = [{ name: "accounts", group: null, table: "public.accounts", description: null }];
  installFetchStub();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("enrolled-nothing is not the same as could-not-load", () => {
  test("an empty reach says so, and says it is the starting state rather than a fault", async () => {
    const text = await settledText();
    expect(text).toContain("Nothing is enrolled");
    // The reassurance is the substance, not decoration: an admin who reads an
    // empty reach as a broken warehouse goes looking for a connection problem
    // that does not exist.
    expect(text).toContain("Atlas can still query your warehouse live");
    // POSITIVE CONTROL for the prohibition below. Keyed on the LIST pane's own
    // sentence rather than the shared phrase "the request failed": both panes
    // use that phrase, so a bare match would be satisfied by the picker's error
    // and the assertion would stop being about the reach at all.
    expect(text).not.toContain("not because your workspace has enrolled nothing");
  });

  test("a failed list never renders as an empty reach", async () => {
    listFails = true;
    const text = await settledText();
    expect(text).toContain("not because your workspace has enrolled nothing");
    // ⚠️ The prohibition. The list falls back to `[]` on failure, so the flat
    // empty-state sentence would state the workspace has enrolled nothing at
    // the moment nobody knows what it has enrolled.
    expect(text).not.toContain("Nothing is enrolled, so the warehouse producer");
  });
});

describe("an unreadable semantic layer is not an empty one", () => {
  test("no published entities says exactly that", async () => {
    entities = [];
    const text = await settledText();
    expect(text).toContain("Nothing is published in your semantic layer");
    expect(text).not.toContain("Your semantic layer could not be read");
  });

  test("a failed entity read never renders as an empty semantic layer", async () => {
    entitiesFail = true;
    const text = await settledText();
    expect(text).toContain("Your semantic layer could not be read");
    expect(text).not.toContain("Nothing is published in your semantic layer");
  });

  test("the two failures are independent — one broken read does not blank the other pane", async () => {
    // The reason the page makes two requests rather than one. A merged endpoint
    // would put the semantic layer's availability in front of the reach an admin
    // came to read.
    entitiesFail = true;
    enrollments = THREE_PAIRS_TWO_ENTITIES;
    const text = await settledText();
    expect(text).toContain("Your semantic layer could not be read");
    // The reach still renders, with its row.
    expect(text).toContain("arr_band");
    // And the REACH pane reports no failure of its own. Pane-specific, for the
    // reason the first test records: the picker's error legitimately contains
    // "the request failed", so that phrase cannot separate the two panes.
    expect(text).not.toContain("not because your workspace has enrolled nothing");
  });
});

describe("the counters are the server's, and never a number nobody knows", () => {
  test("pairs and entities are counted separately", async () => {
    enrollments = THREE_PAIRS_TWO_ENTITIES;
    const { container } = renderPage();
    await waitFor(() =>
      expect(container.textContent ?? "").not.toContain("Loading what is enrolled…"),
    );
    const text = container.textContent ?? "";
    // Unequal, so a page rendering `enrollments.length` for both goes red on
    // one of them.
    expect(text).toContain("Pairs3");
    expect(text).toContain("Entities2");
  });

  test("a read still IN FLIGHT shows an em-dash, never a zero", async () => {
    // ⚠️ The state the first fix for this defect missed. `useAdminFetch` returns
    // `{ data: null, error: null, loading: true }` on first mount, so a guard
    // written as `listError !== null` leaves the loading window rendering `0` —
    // the page asserting an empty reach while the prose below still says
    // "Loading what is enrolled…". Three states, not two.
    enrollments = THREE_PAIRS_TWO_ENTITIES;
    const { container } = renderPage();
    // Assert BEFORE the fetch settles. The loading prose is the proof we are in
    // that window rather than past it — without it this test would silently
    // become a second copy of the settled-state one.
    await waitFor(() =>
      expect(container.textContent ?? "").toContain("Loading what is enrolled…"),
    );
    const loadingText = container.textContent ?? "";
    expect(loadingText).toContain("Pairs—");
    expect(loadingText).not.toContain("Pairs0");
    expect(loadingText).not.toContain("Entities0");

    // …and the control: once it settles, the real numbers appear. Without this
    // the assertions above are satisfied by a page that renders an em-dash
    // forever.
    await waitFor(() => expect(container.textContent ?? "").toContain("Pairs3"));
    expect(container.textContent ?? "").toContain("Entities2");
  });

  test("a failed read shows an em-dash, never a zero", async () => {
    // ⚠️ `useAdminFetch` nulls `data` on error, so both chips evaluated to `0`
    // and rendered ABOVE the failure prose — the two numbers an admin's eye
    // lands on first asserting an empty reach at the moment nobody knows what
    // the reach is.
    listFails = true;
    const text = await settledText();
    expect(text).toContain("Pairs—");
    expect(text).toContain("Entities—");
    expect(text).not.toContain("Pairs0");
    expect(text).not.toContain("Entities0");
  });
});

describe("the write verbs report what actually happened", () => {
  async function renderWithOneEnrollment() {
    enrollments = [THREE_PAIRS_TWO_ENTITIES[0]!];
    const { container } = renderPage();
    await waitFor(() =>
      expect(container.textContent ?? "").not.toContain("Loading what is enrolled…"),
    );
    return container;
  }

  test("a real removal says published claims are untouched", async () => {
    const container = await renderWithOneEnrollment();
    fireEvent.click(screen.getByRole("button", { name: /Un-enroll/i }));
    await waitFor(() =>
      expect(container.textContent ?? "").toContain("still published, still visible, still valid"),
    );
    // The other half of the ternary must NOT also be on screen — an inverted
    // condition would otherwise be half-caught.
    expect(container.textContent ?? "").not.toContain("was not enrolled");
  });

  test("a no-op removal says the pair was not enrolled", async () => {
    // The paired arm. Without it, an inverted ternary passes the test above by
    // rendering the reassurance on every path.
    writeChanged = false;
    const container = await renderWithOneEnrollment();
    fireEvent.click(screen.getByRole("button", { name: /Un-enroll/i }));
    await waitFor(() => expect(container.textContent ?? "").toContain("was not enrolled"));
    expect(container.textContent ?? "").not.toContain("still published, still visible, still valid");
  });

  test("a failed removal reports in the reach card, not under 'Enroll a dimension'", async () => {
    // The message used to land in the enroll form's error slot — a destructive
    // alert under a heading about enrolling, while the affected row got a bare
    // badge with no reason.
    writeFails = true;
    const container = await renderWithOneEnrollment();
    fireEvent.click(screen.getByRole("button", { name: /Un-enroll/i }));
    await waitFor(() => expect(container.textContent ?? "").toContain("you may not un-enroll"));

    // It is rendered AFTER the reach card's heading, which is what places it
    // with the row it belongs to rather than in the authoring form above.
    const text = container.textContent ?? "";
    expect(text.indexOf("you may not un-enroll")).toBeGreaterThan(text.indexOf("In the producer"));
  });
});


describe("naming the column an entity is known by (#5043)", () => {
  async function renderNamed(naming: boolean) {
    enrollments = [{ ...THREE_PAIRS_TWO_ENTITIES[0]!, naming }];
    const { container } = renderPage();
    await waitFor(() =>
      expect(container.textContent ?? "").not.toContain("Loading what is enrolled…"),
    );
    return container;
  }

  test("the standing copy says what naming DOES, not that it is a display setting", async () => {
    const text = await settledText();
    // "Use as name" reads like a preference. It is the act that decides which
    // claims Atlas treats as being about the same thing, and re-files every
    // fact about the entity — a workspace-wide re-key an admin has no reason to
    // expect from a control labelled that way.
    expect(text).toContain("Changing it re-files everything Atlas knows about that entity");
    expect(text).toContain("not a display setting");
  });

  test("the row shows which dimension names its entity — and the others do not", async () => {
    // The fixture's FIRST pair is the naming one and the other two are not, so
    // a badge rendered unconditionally would show three times.
    enrollments = THREE_PAIRS_TWO_ENTITIES;
    const { container } = renderPage();
    await waitFor(() =>
      expect(container.textContent ?? "").not.toContain("Loading what is enrolled…"),
    );
    const text = container.textContent ?? "";
    expect(text.match(/names this entity/g) ?? []).toHaveLength(1);
    // Both verbs are on screen, one per row — the naming row offers to stop,
    // the other two offer to start.
    expect(screen.getAllByRole("button", { name: /^Use as name$/ })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: /Stop using as name/ })).toHaveLength(1);
  });

  test("naming a column sends the dimension, and explains the merge it creates", async () => {
    const container = await renderNamed(false);
    fireEvent.click(screen.getByRole("button", { name: /^Use as name$/ }));
    await waitFor(() =>
      expect(container.textContent ?? "").toContain("become the same subject"),
    );
    // The other half of the ternary must NOT also be on screen.
    expect(container.textContent ?? "").not.toContain("no longer has a name column");
    // ⚠️ THE WIRE PAYLOAD, not just the copy. The notice branches on the page's
    // own local boolean, so every assertion about prose passes whatever the page
    // actually sent — `dimension: target.dimension` on BOTH paths survived the
    // whole suite.
    expect(namingBodies).toEqual([{ entity: "accounts", group: null, dimension: "arr_band" }]);
  });

  test("clearing it sends NULL — the destructive half of the verb", async () => {
    // The paired arm. Without it an inverted ternary passes the test above by
    // rendering the merge copy on every path.
    const container = await renderNamed(true);
    fireEvent.click(screen.getByRole("button", { name: /Stop using as name/ }));
    await waitFor(() =>
      expect(container.textContent ?? "").toContain("no longer has a name column"),
    );
    expect(container.textContent ?? "").not.toContain("become the same subject");
    // ⚠️ `null`, and this is the assertion that matters most in the file.
    // Sending the dimension here does not clear the name — it RE-NAMES, which
    // re-keys every fact about the entity workspace-wide. The copy is identical
    // either way, so prose can never catch it.
    expect(namingBodies).toEqual([{ entity: "accounts", group: null, dimension: null }]);
  });

  test("a failed naming change gets its OWN error slot and badge", async () => {
    // A shared slot would render this under the un-enroll card's "not removed"
    // badge — the same defect the un-enroll slot was split out of the enroll
    // card to fix, one verb later.
    writeFails = true;
    const container = await renderNamed(false);
    fireEvent.click(screen.getByRole("button", { name: /^Use as name$/ }));
    await waitFor(() => expect(container.textContent ?? "").toContain("you may not rename"));
    const text = container.textContent ?? "";
    expect(text).toContain("name not changed");
    expect(text).not.toContain("not removed");
  });
});

describe("an entity in two connection groups is two choices (#5286)", () => {
  /**
   * The picker's two rows for one name, and the dimension list that answers for
   * whichever group was asked about.
   *
   * ⚠️ **This is the shape the page rendered as ONE option until #5286**, because
   * `loadEnrollableEntities` collapsed same-named rows server-side. Whichever the
   * admin meant, the enrollment could not record it — the row stored cleanly and
   * the producer refused it on every run afterwards.
   */
  function twoGroups() {
    entities = [
      { name: "test_orders", group: "g-clickhouse", table: "orders", description: null },
      { name: "test_orders", group: "g-mysql", table: "orders", description: null },
    ];
  }

  test("both groups are offered, and the group is what tells them apart", async () => {
    twoGroups();
    const { container } = renderPage();
    await waitFor(() =>
      expect(container.textContent ?? "").not.toContain("Loading your semantic layer…"),
    );

    fireEvent.click(screen.getByRole("combobox", { name: "Entity" }));
    const options = await screen.findAllByRole("option");
    expect(options).toHaveLength(2);
    // The NAME alone would render two identical rows — the duplicate-React-key
    // state the old server-side collapse existed to avoid, and which it avoided
    // by making the pair unenrollable instead.
    expect(options.map((o) => o.textContent)).toEqual([
      "test_orders — g-clickhouse",
      "test_orders — g-mysql",
    ]);
  });

  test("the group is NOT shown where it cannot disambiguate", async () => {
    // The control. A group printed on every row is noise an admin learns to
    // ignore — and then ignores on the workspace where it decides which database
    // a claim came from.
    entities = [{ name: "accounts", group: "g-only", table: "accounts", description: null }];
    const { container } = renderPage();
    await waitFor(() =>
      expect(container.textContent ?? "").not.toContain("Loading your semantic layer…"),
    );

    fireEvent.click(screen.getByRole("combobox", { name: "Entity" }));
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["accounts"]);
  });

  test("picking one group sends THAT group to the write, not the other", async () => {
    // ⚠️ The assertion that matters. Every rendering test above passes on a page
    // that renders two options and then posts the first one's group for both —
    // which is the original defect wearing a picker.
    twoGroups();
    const { container } = renderPage();
    await waitFor(() =>
      expect(container.textContent ?? "").not.toContain("Loading your semantic layer…"),
    );

    fireEvent.click(screen.getByRole("combobox", { name: "Entity" }));
    fireEvent.click(await screen.findByRole("option", { name: "test_orders — g-mysql" }));

    // The dimension list is its own fetch, keyed on the picked entity AND its
    // group — so it is DISABLED until that request answers. Waiting on the
    // control rather than on a timer is what keeps this test about the payload.
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Dimension or measure" }).hasAttribute("disabled"),
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("combobox", { name: "Dimension or measure" }));
    fireEvent.click(await screen.findByRole("option", { name: /arr_band/ }));
    fireEvent.click(screen.getByRole("button", { name: /Enroll this dimension/ }));

    await waitFor(() => expect(enrollBodies).toHaveLength(1));
    expect(enrollBodies[0]).toEqual({
      entity: "test_orders",
      group: "g-mysql",
      dimension: "arr_band",
      note: null,
    });
  });

  test("a row in the reach names its group, and the flat scope names none", async () => {
    enrollments = [
      {
        entity: "test_orders",
        group: "g-mysql",
        dimension: "status",
        enrolledAt: "2026-08-14T00:00:00.000Z",
        enrolledBy: "user-1",
        note: null,
        naming: false,
      },
      {
        entity: "accounts",
        group: null,
        dimension: "arr_band",
        enrolledAt: "2026-08-14T00:00:00.000Z",
        enrolledBy: "user-1",
        note: null,
        naming: false,
      },
    ];
    const text = await settledText();
    // Named where there is one — it is what tells two same-named rows apart, and
    // two same-named rows are the state the producer refuses.
    expect(text).toContain("g-mysql · enrolled by user-1");
    // ...and NOT invented where there is none. A `null` rendered as "null" or as
    // an empty separator is a group whose name the admin cannot look up.
    expect(text).toContain("accounts");
    expect(text).not.toContain("null · enrolled by");
  });
});

describe("un-enrolling is not retraction, and the page says so", () => {
  test("the standing copy states what un-enrolling does NOT do", async () => {
    const text = await settledText();
    expect(text).toContain("Un-enrolling stops future claims and nothing else");
    // Named where the retraction actually lives, so the sentence is a route
    // rather than a refusal.
    expect(text).toContain("stay published");
  });

  test("the page never claims enrolling makes anything true", async () => {
    const text = await settledText();
    // The review gate is not optional for this source (ADR-0036 §T9, PRD
    // condition 2), and a surface that implied otherwise would be the first
    // place someone reads that it is.
    expect(text).toContain("arrives as a draft for your review");
    expect(text).toContain("never what is true");
  });
});

/**
 * The run report (#5197, #5284).
 *
 * `created: 0` has two causes that produce identical silence in `brain_facts` —
 * an empty reach, and every pair refused. ADR-0039 names that indistinguishability
 * as M5's central invisibility, which is why the report carries `enrolled` and
 * `refusals` side by side. The panel has to say WHICH.
 *
 * Before this panel existed the producer had no UI trigger at all, so a refusal
 * reached nobody: an admin enrolled a pair, read "Run the producer to apply it",
 * and had nothing to press. That is how #5284 survived to prod.
 */
describe("a run that produced nothing says WHY it produced nothing", () => {
  /** Press Run and wait for the report to land. */
  async function runAndRead(): Promise<string> {
    enrollments = THREE_PAIRS_TWO_ENTITIES;
    const { container } = renderPage();
    await waitFor(() => {
      expect(container.textContent ?? "").not.toContain("Loading what is enrolled…");
    });
    fireEvent.click(screen.getByRole("button", { name: /run the producer/i }));
    await waitFor(() => {
      expect(container.textContent ?? "").not.toContain("Reading the warehouse…");
    });
    return container.textContent ?? "";
  }

  test("every pair refused reads as refused, not as a quiet warehouse", async () => {
    const text = await runAndRead();
    expect(text).toContain("Every enrolled pair was refused");
    // The positive control the prohibition needs: a page rendering no report at
    // all would satisfy any `not.toContain` below.
    expect(text).toContain("2 refused");
    // The SERVER's reason, verbatim — the thing an admin acts on.
    expect(text).toContain("could not be read");
    // …and it must NOT read as the benign case.
    expect(text).not.toContain("A quiet warehouse costs no review");
  });

  test("a quiet run and a refused run do not render the same sentence", async () => {
    runResponse = { ...ALL_REFUSED, refusals: [] };
    const text = await runAndRead();
    // Same `created: 0`, opposite meaning. This is the pair the panel exists for.
    expect(text).toContain("A quiet warehouse costs no review");
    expect(text).not.toContain("Every enrolled pair was refused");
  });

  test("SOME pairs refused does not read as EVERY pair refused", async () => {
    // ⚠️ `ALL_REFUSED` sets `enrolled: 2` with two refusals, so `refused ===
    // report.enrolled` holds by CONSTRUCTION and the middle arm of the three was
    // unreachable from any fixture. Measured: relaxing the guard to `refused > 0`
    // was green — and then one refusal out of eight rendered "Every enrolled pair
    // was refused, so this run read nothing", a false statement about the admin's
    // own run, in the panel written to stop exactly that.
    runResponse = { ...ALL_REFUSED, enrolled: 8, refusals: [ALL_REFUSED.refusals[0]] };
    const text = await runAndRead();
    expect(text).toContain("Some pairs were refused");
    expect(text).not.toContain("Every enrolled pair was refused");
    // Positive controls, at a size that cannot be confused with the fixture above.
    expect(text).toContain("1 refused");
    expect(text).toContain("8 pairs in reach");
  });

  test("a run that PRODUCED something says so, and never reports a bare zero", async () => {
    // Every fixture in this file had `created: 0`, so the entire success rendering
    // was unexercised — on a page that exists because prod runs produced nothing.
    // Measured: inverting the chip's ternary was green, and rendered "0 filed as
    // drafts" — the confident zero the component was written to prevent.
    runResponse = {
      ...ALL_REFUSED,
      enrolled: 3,
      created: 5,
      corroborated: 2,
      refusals: [],
      entities: [
        {
          entity: "accounts",
          rows: 900,
          candidates: 7,
          created: 5,
          corroborated: 2,
          blocked: 0,
          comparable: 7,
          unidentifiedRows: 0,
          collidingSubjectRows: 0,
          unsurfaceableCells: 0,
          unsurfaceableKeyRows: 0,
          cardinalityProposed: [],
          entitiesStored: 900,
          unnamedRows: 0,
        },
      ],
    };
    const text = await runAndRead();
    expect(text).toContain("5 filed as drafts");
    expect(text).toContain("2 unchanged and corroborated");
    expect(text).toContain("Every claim landed as a draft");
    // The two silences must both be absent — this run was neither.
    expect(text).not.toContain("No new claims");
    expect(text).not.toContain("A quiet warehouse costs no review");
  });

  test("a 200 that is not a run report is refused, not rendered as one", async () => {
    // ⚠️ `/produce`'s path contains `/brain-enrollment`, so a proxy interposing on
    // it answers with the enrollment LIST — a 200 that casts cleanly to a report
    // with every count absent. Cast (which is what `useAdminMutation` does), the
    // degraded arm then renders `undefined` where its message and request id go,
    // which is the panel that exists to say "go read the log for this id".
    runResponse = { enrollments: [], entities: [] };
    const text = await runAndRead();
    expect(text).toContain("could not read the report");
    // It must not invite a re-run: `produce` is an authority act and the drafts
    // are already filed by the time the body is unreadable.
    expect(text).toContain("review queue");
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("filed as drafts");
  });

  test("the degraded arm reports NO counts — not even a zero", async () => {
    runResponse = {
      reportComplete: false,
      workspaceId: "ws-1",
      requestId: "req-degraded",
      message: "The run committed but its counts could not be established.",
    };
    const text = await runAndRead();
    expect(text).toContain("req-degraded");
    expect(text).toContain("counts could not be established");
    // ⚠️ The whole point of the withheld arm. `{enrolled: 2, created: 0}` from a
    // run that may have refused everything is a confident all-clear handed to
    // the one person whose next action is to press Run again — so the panel must
    // not reconstruct one from fields the schema deliberately omits.
    expect(text).not.toContain("filed as drafts");
    expect(text).not.toContain("pairs in reach");
    expect(text).not.toContain("No new claims");
  });

  test("a 409 from the run lock surfaces the server's sentence, not a crash", async () => {
    runStatus = 409;
    runResponse = {
      error: "conflict",
      message: "A scheduled run is already in flight for this workspace.",
      requestId: "req-1",
    };
    const text = await runAndRead();
    expect(text).toContain("already in flight");
  });
});

describe("the run control is not offered where a run would mislead", () => {
  /** `jest-dom` matchers are not installed here, so read the DOM property. */
  const runButton = () =>
    screen.getByRole("button", { name: /run the producer/i }) as HTMLButtonElement;

  test("an empty reach disables it — a run over nothing reports like a broken producer", async () => {
    await settledText();
    expect(runButton().disabled).toBe(true);
  });

  test("a known, non-empty reach enables it", async () => {
    enrollments = THREE_PAIRS_TWO_ENTITIES;
    await settledText();
    expect(runButton().disabled).toBe(false);
  });
});
