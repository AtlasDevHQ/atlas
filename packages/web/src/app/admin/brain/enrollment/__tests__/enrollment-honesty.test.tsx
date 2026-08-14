import { describe, expect, test, afterEach, beforeEach, mock } from "bun:test";
import { render, cleanup, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { AtlasProvider, type AtlasAuthClient } from "@/ui/context";

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

void mock.module("next/navigation", () => ({
  usePathname: () => "/admin/brain/enrollment",
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(),
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
/** The enrolled rows the list endpoint answers with. */
let enrollments: unknown[] = [];
/** The entities the picker endpoint answers with. */
let entities: unknown[] = [{ name: "accounts", table: "public.accounts", description: null }];

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
  globalThis.fetch = mock((input: RequestInfo | URL) => {
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
          dimensions: [
            {
              name: "arr_band",
              kind: "dimension",
              type: "string",
              description: null,
              enrolled: false,
            },
          ],
        }),
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
  enrollments = [];
  entities = [{ name: "accounts", table: "public.accounts", description: null }];
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
    enrollments = [
      {
        entity: "accounts",
        dimension: "arr_band",
        enrolledAt: "2026-08-14T00:00:00.000Z",
        enrolledBy: "user-1",
        note: null,
      },
    ];
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
