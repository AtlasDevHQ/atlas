import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { AtlasProvider, type AtlasAuthClient } from "@/ui/context";

/**
 * What the Company Atlas Coverage Surface must SAY, and what it must never do
 * (#5066, evolved by #5215). The sibling `facts/__tests__/review-honesty.test.tsx`
 * is the model: every assertion here is a place where a quiet UI would mislead
 * an admin. The three-state rendering rules ADR-0041 decides are pinned next
 * door in `coverage-honesty.test.tsx`; this file owns the two properties that
 * survived the page's evolution unchanged.
 *
 * Two claims the page states in prose and nothing else was enforcing:
 *
 *   - **A failed or pending read must never render as `0`.** Every number here
 *     is a BACKLOG, so "0 awaiting review" over a broken fetch says "your queue
 *     is clear" at the moment nobody knows what is in it. Concretely these arms
 *     pin that `AdminContentWrapper` still stands between the fetch and the
 *     tiles — removing it is what lets a count reach the screen during error or
 *     loading. A hand-rolled `ErrorBanner` is the neighbouring hazard, caught
 *     by the 404 arm: it renders no count, but discards `FetchError.status` and
 *     so shows a red alert plus a dead Retry for the ordinary self-hosted
 *     no-database case. (`CoverageSurface`'s own `coverage === null` branch
 *     is unreachable behind that wrapper by contract, so nothing here can
 *     falsify it; its `console.warn` is the measurement instead.)
 *   - **This page is not a second review queue.** `brain_facts.status` is
 *     grep-guarded to a named allowlist (`check-brain-fact-promotion.sh`), and
 *     no console surface may write it outside the shared publish modal. A label
 *     assertion is defeated by renaming a button, so the durable form is the
 *     endpoint set: the page may touch the two read-only GETs and nothing else.
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

const originalFetch = globalThis.fetch;

/**
 * The only endpoints this page is allowed to reach — both read-only GETs.
 * `brain-slack/channels` joined in #5203: it is the console's only presenter
 * of the Slack history-sync verdict, the surface whose install card the
 * retirement removed. `brain-coverage` REPLACED `brain-facts/summary` in #5215:
 * ADR-0041 makes this page one statement, so both arms come from one response —
 * and the backlog counts moved from the reader-scoped `/summary` to the
 * workspace-wide authority arm, which is the number the publish button acts on.
 */
const ALLOWED = /\/api\/v1\/admin\/(brain-coverage|brain-slack\/channels)$/;

/**
 * A coverage response whose AUTHORITY arm carries the four backlog counts.
 *
 * The availability arm is deliberately minimal here — every class on an arm that
 * carries no numbers — so the digit sweeps below stay about the backlog counts.
 * The availability arm's own rendering is `coverage-honesty.test.tsx`'s subject.
 */
const COVERAGE = {
  availability: {
    chat: {
      state: "never-enumerated",
      reason: "no-cycle-recorded",
      lastAttemptAt: null,
      unavailableReason: null,
    },
    transcript: {
      state: "never-enumerated",
      reason: "no-cycle-recorded",
      lastAttemptAt: null,
      unavailableReason: null,
    },
    email: {
      state: "never-enumerated",
      reason: "no-cycle-recorded",
      lastAttemptAt: null,
      unavailableReason: null,
    },
    warehouse: {
      state: "never-enumerated",
      reason: "no-cycle-recorded",
      lastAttemptAt: null,
      unavailableReason: null,
    },
    human: { state: "not-surveyable", reason: "non-surveyable-class" },
  },
  authority: {
    buckets: [],
    workspaceTotals: {
      awaitingReview: 7,
      published: 41,
      retracted: 0,
      provisional: 2,
      inTension: 3,
    },
    reviewableAwaitingReview: 7,
    countsConsistent: true,
    distinctAudiences: 0,
    bucketsTruncated: false,
  },
  countsConsistent: true,
};

/** Healthy Slack vitals. `inScopeCount: 0` keeps the digit sweeps honest. */
const SLACK_VITALS = {
  scopeMode: "membership",
  inScopeCount: 0,
  sync: null,
  channels: [],
};

/** The revoked-credential shape — the sync error IN THE SYNC'S OWN WORDS. */
const SLACK_SYNC_ERROR =
  "The workspace's Slack credential is no longer valid — reconnect Slack under Admin → Integrations";
const SLACK_VITALS_FAILING = {
  scopeMode: "membership",
  inScopeCount: 0,
  sync: {
    lastSyncAt: null,
    status: "error",
    error: SLACK_SYNC_ERROR,
    coverageIncomplete: false,
  },
  channels: [],
};

// A real request id shape: the API stamps `crypto.randomUUID()`. Using a
// digit-free stand-in ("req_abc") also made the banner-strip below inert,
// since the strip only earns its keep when the banner contains digits.
const REQUEST_ID = "8f0c1e2a-4b6d-4f1a-9c3e-77d2b5a10e94";

/**
 * The envelopes this endpoint actually emits, not invented ones. 404 is
 * `requireOrgContext()`'s no-internal-database refusal (`admin-router.ts`,
 * `NO_INTERNAL_DB_MESSAGE`); 500 is `runHandler`'s unmapped-error branch
 * (`lib/effect/hono.ts`) with the label from `admin-brain-coverage.ts`.
 * A fixture with a shape the server never sends would keep this file green
 * through a routing change that only ever sees the real one.
 */
const NO_INTERNAL_DB = {
  error: "not_available",
  message: "No internal database configured.",
  requestId: REQUEST_ID,
};

const SERVER_ERROR = {
  error: "internal_error",
  message: "Failed to load company atlas coverage.",
  requestId: REQUEST_ID,
};

/**
 * The four tile titles. `StatCard` renders title and value together, so a
 * fabricated `0` cannot reach the screen without its label — which makes
 * "no label is present" a sharper assertion than "no digit is present" on its
 * own. The two are complementary: this catches a labelled zero, the digit
 * sweep catches an unlabelled one.
 */
const TILE_LABELS = ["Awaiting review", "In tension", "Provisional", "Published"];

function expectNoCounts(container: HTMLElement) {
  const text = container.textContent ?? "";
  for (const label of TILE_LABELS) {
    expect(text).not.toContain(label);
  }
}

/**
 * The value rendered inside the `StatCard` whose title is `label`.
 *
 * Reads the BINDING rather than the page text, because `toContain("7")` only
 * asks whether a digit is somewhere on the page: swapping the awaiting-review
 * and published values renders "41 awaiting review / 7 published" — the exact
 * class of misleading number this file exists to prevent — while every
 * token-presence assertion stays green. Throws rather than returning empty so
 * a missing tile names itself.
 */
function tileValue(container: HTMLElement, label: string): string {
  const title = Array.from(container.querySelectorAll('[data-slot="card-title"]')).find(
    (el) => (el.textContent ?? "").trim() === label,
  );
  if (!title) throw new Error(`no tile titled "${label}"`);
  const content = title.closest('[data-slot="card"]')?.querySelector('[data-slot="card-content"]');
  if (!content) throw new Error(`tile "${label}" has no card content`);
  // `StatCard` renders the value as the content box's first element and the
  // description as a sibling. Read the element, not the box's `textContent` —
  // the two run together with no separator ("7Drafts a human has not…"), so
  // splitting on whitespace silently yields the wrong string.
  const value = content.firstElementChild;
  if (!value) throw new Error(`tile "${label}" has no value element`);
  return (value.textContent ?? "").trim();
}

let requested: { url: string; method: string }[] = [];
/** Resolves the COVERAGE request. Overridden per test to fail or to hang. */
let respond: (url: string) => Promise<Response> | Response;
/** Resolves the SLACK vitals request, independently — the two sections fail
 * independently in production, and a uniform stub would hand the Slack fetch
 * a coverage body and turn every error-arm assertion into a statement about a
 * parse failure nobody designed. Defaults healthy; the error arms hang it so
 * their single-banner/digit-sweep anatomy is untouched. */
let respondSlack: (url: string) => Promise<Response> | Response;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  requested = [];
  respond = () => jsonResponse(COVERAGE);
  respondSlack = () => jsonResponse(SLACK_VITALS);
  testQueryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    requested.push({ url, method: init?.method ?? "GET" });
    return url.includes("brain-slack") ? respondSlack(url) : respond(url);
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

describe("Company Atlas overview — counts are never fabricated (#5066)", () => {
  test("renders the four backlog counts once the coverage read lands", async () => {
    const view = renderPage();
    await waitFor(() => expect(view.container.textContent).toContain("41"));

    // Each count asserted against ITS OWN label. A count under the wrong noun
    // is not a lesser bug than a missing one — it is the one an admin acts on.
    expect(tileValue(view.container, "Awaiting review")).toBe("7");
    expect(tileValue(view.container, "Provisional")).toBe("2");
    expect(tileValue(view.container, "In tension")).toBe("3");
    expect(tileValue(view.container, "Published")).toBe("41");
  });

  test("a FAILED coverage read renders no number at all — least of all a zero", async () => {
    // The load-bearing arm. `?? 0` anywhere in the render path turns a broken
    // read into "your queue is clear", which is worse than an error because it
    // is actionable in the wrong direction.
    //
    // ⚠️ Wait for a POSITIVE marker of the error state (the banner's
    // `role="alert"`), never for the absence of "Awaiting review" — absence is
    // already true on the first pending frame, so a `waitFor` on it resolves
    // before the fetch settles and the assertions below land on the LOADING
    // state instead. That version of this test passed against a page that
    // rendered zeros on error.
    respond = () => jsonResponse(SERVER_ERROR, 500);
    respondSlack = () => new Promise<Response>(() => {}); // hang: this arm is about the coverage read
    const view = renderPage();

    // ⚠️ Anchored on the request id, NOT on `[role="alert"]`: `ErrorBoundary`'s
    // fallback carries that same role, so a render CRASH would satisfy the
    // wait and then trivially satisfy `expectNoCounts` — reporting "no
    // fabricated counts" for a page that never rendered.
    await waitFor(() => expect(view.container.textContent ?? "").toContain(REQUEST_ID));
    // The 500 rule: every one carries a correlation id to the user.
    expect(view.container.textContent ?? "").toContain(SERVER_ERROR.message);
    expectNoCounts(view.container);
    // `expectNoCounts` only sees a number arriving with one of the four
    // titles. Strip the banner — whose correlation id legitimately contains
    // digits — and no digit may remain anywhere else, which catches an
    // UNLABELLED bare count. Throws rather than `?.remove()`: a silent no-op
    // strip would leave this assertion passing for the wrong reason.
    const outsideBanner = view.container.cloneNode(true) as HTMLElement;
    const banner = outsideBanner.querySelector('[role="alert"]');
    if (!banner) throw new Error("no [role=alert] banner to strip — the 500 surface changed");
    banner.remove();
    expect(outsideBanner.textContent ?? "").not.toMatch(/\d/);
  });

  test("a 404 (no internal database) is routed to the feature gate, not a red error", async () => {
    // `/brain-coverage` answers 404 when DATABASE_URL isn't configured — the ordinary
    // self-hosted state, not a fault. A destructive alert with a Retry button
    // that cannot help is the wrong disclosure, and it is what a hand-rolled
    // `<ErrorBanner message={friendlyError(err)}>` produces, because flattening
    // the error to a string discards `FetchError.status`. `FeatureGate`'s 404
    // copy is the positive marker that the routing survived.
    respond = () => jsonResponse(NO_INTERNAL_DB, 404);
    respondSlack = () => new Promise<Response>(() => {}); // hang: this arm is about the coverage read
    const view = renderPage();

    await waitFor(() =>
      expect(view.container.textContent ?? "").toContain("Company Atlas not enabled"),
    );
    // The generic banner and its dead Retry button are what must NOT appear.
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect((view.container.textContent ?? "").toLowerCase()).not.toContain("retry");
    // Routing to the gate is not enough on its own: the gate used to render
    // only its canned "enable this feature in your server configuration"
    // line, which names nothing an operator can go set. Since #5068 the
    // server's own sentence and the correlation id both reach the screen.
    expect(view.container.textContent ?? "").toContain(NO_INTERNAL_DB.message);
    expect(view.container.textContent ?? "").toContain(REQUEST_ID);
    expectNoCounts(view.container);
    // The digit sweep this arm had to drop while the gate rendered no id.
    // Same shape as the 500 arm: strip the one element whose digits are
    // legitimate, then no digit may remain — which is what catches an
    // UNLABELLED bare count that `expectNoCounts` cannot see. Throws rather
    // than `?.remove()` so a silent no-op strip can't leave this green.
    //
    // ⚠️ This couples to `NO_INTERNAL_DB.message` being digit-free, since the
    // gate now renders it. Give that message a port or a version number and
    // the failure reads "fabricated count" — which is the wrong place to
    // start debugging.
    const outsideId = view.container.cloneNode(true) as HTMLElement;
    const idLine = outsideId.querySelector('[data-testid="feature-gate-request-id"]');
    if (!idLine) throw new Error("no request-id line to strip — the 404 gate surface changed");
    idLine.remove();
    expect(outsideId.textContent ?? "").not.toMatch(/\d/);
  });

  test("a failing Slack sync renders the sync's OWN error words, as an alert (#5203)", async () => {
    // The presenter this section exists for: the route's `sync.error` is
    // written to be admin-actionable, and this card is the only console
    // surface those words reach. Dropping the card, the error branch, or the
    // fetch itself all go red here — the recorded-but-unread state must not
    // reappear one layer up.
    respondSlack = () => jsonResponse(SLACK_VITALS_FAILING);
    const view = renderPage();

    await waitFor(() => expect(view.container.textContent ?? "").toContain(SLACK_SYNC_ERROR));
    // Rendered as an ERROR, not as body copy an eye slides past.
    const alerts = Array.from(view.container.querySelectorAll('[role="alert"]'));
    expect(alerts.some((a) => (a.textContent ?? "").includes(SLACK_SYNC_ERROR))).toBe(true);
  });

  test("a healthy Slack scope says so without inventing a sync that never ran", async () => {
    const view = renderPage();
    // ⚠️ Anchored on the LOADED card's copy — "Slack ingest" alone also
    // matches the wrapper's "Loading Slack ingest status..." frame, and a
    // waitFor satisfied by the loading state lands every assertion below on a
    // frame where the card has not rendered.
    // sync: null is "no sync recorded yet" — not an error, not a fabricated
    // success timestamp.
    await waitFor(() =>
      expect(view.container.textContent ?? "").toContain("No history sync recorded yet"),
    );
    expect(
      Array.from(view.container.querySelectorAll('[role="alert"]')).filter((a) =>
        (a.textContent ?? "").includes("Slack"),
      ),
    ).toHaveLength(0);
  });

  test("a PENDING coverage read renders no number either", async () => {
    // Same hazard as the failed read, different arm: a momentary "0" while the
    // request is in flight reads exactly like a cleared backlog. Waits for the
    // loading state's own copy so this asserts on a frame that definitely
    // rendered, not on whatever was on screen before the effect ran.
    respond = () => new Promise<Response>(() => {}); // never settles
    respondSlack = () => new Promise<Response>(() => {}); // hang: this arm is about the coverage read
    const view = renderPage();

    await waitFor(() =>
      expect(view.container.textContent ?? "").toContain("Loading Company Atlas coverage"),
    );
    expectNoCounts(view.container);
    expect(view.container.textContent ?? "").not.toMatch(/\d/);
  });

  test("keeps the route into the review queue even when the coverage read fails", async () => {
    // The wrapper replaces its children wholesale on error, so the Facts card
    // sits outside it: a workspace whose counts won't load is precisely the one
    // whose admin needs to go look at the queue.
    respond = () => jsonResponse(SERVER_ERROR, 500);
    respondSlack = () => new Promise<Response>(() => {}); // hang: this arm is about the coverage read
    const view = renderPage();

    await waitFor(() => expect(view.container.textContent ?? "").toContain(REQUEST_ID));
    const hrefs = Array.from(view.container.querySelectorAll("a")).map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs).toContain("/admin/brain/facts");
  });
});

describe("Company Atlas overview — read-only by construction (#5066)", () => {
  test("touches no endpoint outside the two read-only GETs", async () => {
    // The durable half of "this is not a second review queue". A label regex is
    // defeated by a "Trust this claim" button; this is defeated only by not
    // calling a status-writing endpoint at all.
    const view = renderPage();
    await waitFor(() => expect(view.container.textContent).toContain("41"));

    expect(requested.length).toBeGreaterThan(0);
    for (const req of requested) {
      expect(ALLOWED.test(req.url)).toBe(true);
      expect(req.method).toBe("GET");
    }
  });

  test("clicking every control on the page still writes nothing", async () => {
    // The endpoint sweep above proves read-only ON MOUNT. A write wired to an
    // onClick behind an innocuous label ("Accept queue") passes both that and
    // the verb sweep below, so drive the surface before asserting.
    const view = renderPage();
    await waitFor(() => expect(view.container.textContent).toContain("41"));

    for (const el of view.container.querySelectorAll('button, [role="button"], a')) {
      fireEvent.click(el);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    for (const req of requested) {
      expect(ALLOWED.test(req.url)).toBe(true);
      expect(req.method).toBe("GET");
    }
  });

  test("offers no gate verb — no approve, reject, retract or publish control", async () => {
    const view = renderPage();
    await waitFor(() => expect(view.container.textContent).toContain("41"));

    // Every clickable shape, not just <button> — an `<a>Approve all</a>` is
    // the obvious way past a button-only sweep. Bare `a`, NOT `a:not([href])`:
    // a destructive action in this codebase is plausibly a `<Link href=… onClick=…>`,
    // so excluding anchors-with-href would miss the realistic shape. The false
    // positive that tempts you into excluding them is the Facts card's
    // DESCRIPTION, whose prose about the linked page contains "reject" and
    // "publish" — so strip descriptions from the label rather than dropping
    // whole elements from the sweep.
    const labels = Array.from(
      view.container.querySelectorAll('button, [role="button"], [type="submit"], a'),
    ).map((el) => {
      const clone = el.cloneNode(true) as HTMLElement;
      for (const d of clone.querySelectorAll('[data-slot="card-description"]')) d.remove();
      return clone.textContent ?? "";
    });
    for (const verb of [/approve/i, /reject/i, /retract/i, /publish/i]) {
      expect(labels.some((l) => verb.test(l))).toBe(false);
    }
  });
});
