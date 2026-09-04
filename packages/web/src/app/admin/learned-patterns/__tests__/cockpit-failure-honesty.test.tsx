import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { render, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { AtlasProvider, type AtlasAuthClient } from "@/ui/context";

/**
 * Cockpit failure honesty (#4574): an approve / reject / delete that fails must
 * surface the error INSIDE the surface the admin acted in — the detail sheet or
 * the delete confirmation dialog — not in a page-body banner rendered behind the
 * open overlay. A failed review that looks like a success is the exact bug this
 * page fixes, so these are DOM-level pins on *where* the alert lands and on the
 * honest Retry / Dismiss affordances.
 */

void mock.module("next/navigation", () => ({
  usePathname: () => "/admin/learned-patterns",
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const stubAuthClient: AtlasAuthClient = {
  signIn: { email: async () => ({}) },
  signUp: { email: async () => ({}) },
  signOut: async () => {},
  useSession: () => ({ data: null, isPending: false }),
};

const LearnedPatternsPage = (await import("../page")).default;

let testQueryClient: QueryClient;

function Wrapper({ children }: { children: ReactNode }) {
  return createElement(
    NuqsAdapter,
    null,
    createElement(
      QueryClientProvider,
      { client: testQueryClient },
      createElement(
        AtlasProvider,
        {
          config: {
            apiUrl: "http://localhost:3001",
            isCrossOrigin: false as const,
            authClient: stubAuthClient,
          },
          children,
        },
      ),
    ),
  );
}

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const PATTERN = {
  id: "lp-1",
  orgId: null,
  connectionGroupId: null,
  patternSql: "SELECT 1",
  description: "Top customers by revenue",
  sourceEntity: "orders",
  sourceQueries: null,
  confidence: 0.9,
  repetitionCount: 3,
  status: "pending" as const,
  proposedBy: "agent" as const,
  reviewedBy: null,
  reviewedByLabel: null,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
  reviewedAt: null,
  type: "query_pattern" as const,
  amendmentPayload: null,
  autoPromoted: false,
  avgDurationMs: 12,
  injectionCount: 0,
};

const LIST_ENVELOPE = { patterns: [PATTERN], total: 1, limit: 50, offset: 0 };
const SUMMARY_ENVELOPE = {
  stats: { total: 1, pending: 1, approved: 0, rejected: 0 },
  entities: ["orders"],
  multiGroup: false,
};

interface MutationHandlers {
  /** Response for PATCH /learned-patterns/:id (status change). */
  patch?: () => Response;
  /** Response for DELETE /learned-patterns/:id. */
  del?: () => Response;
  /** Response for POST /learned-patterns/bulk. */
  bulk?: () => Response;
}

/**
 * All GETs to the list base path (the list itself + the aux stats/entities
 * fetches) return the same envelope. PATCH / DELETE delegate to caller
 * handlers; the returned `counters.patch` / `counters.del` tallies prove a
 * genuine Retry re-issues the mutation rather than silently dismissing it.
 */
function mockLearnedPatternsApi(handlers: MutationHandlers) {
  const counters = { patch: 0, del: 0, bulk: 0 };
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const isItemPath = /\/api\/v1\/admin\/learned-patterns\/lp-1$/.test(url);

    if (method === "POST" && url.endsWith("/api/v1/admin/learned-patterns/bulk")) {
      counters.bulk += 1;
      if (!handlers.bulk) throw new Error(`unexpected POST ${url}`);
      return Promise.resolve(handlers.bulk());
    }
    if (method === "PATCH" && isItemPath) {
      counters.patch += 1;
      if (!handlers.patch) throw new Error(`unexpected PATCH ${url}`);
      return Promise.resolve(handlers.patch());
    }
    if (method === "DELETE" && isItemPath) {
      counters.del += 1;
      if (!handlers.del) throw new Error(`unexpected DELETE ${url}`);
      return Promise.resolve(handlers.del());
    }
    if (method === "GET" && /\/api\/v1\/admin\/learned-patterns\/summary/.test(url)) {
      return Promise.resolve(jsonResponse(SUMMARY_ENVELOPE));
    }
    if (method === "GET" && /\/api\/v1\/admin\/learned-patterns\/pending-count/.test(url)) {
      return Promise.resolve(jsonResponse({ count: SUMMARY_ENVELOPE.stats.pending }));
    }
    if (method === "GET" && url.includes("/api/v1/admin/learned-patterns")) {
      return Promise.resolve(jsonResponse(LIST_ENVELOPE));
    }
    throw new Error(`unexpected ${method} ${url}`);
  }) as unknown as typeof fetch;
  return counters;
}

const SHEET = '[data-slot="sheet-content"]';
const DELETE_DIALOG = '[data-slot="alert-dialog-content"]';

function findButtonIn(root: ParentNode, label: string): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined;
}

/** Open the detail sheet by clicking the row's (non-button) description cell. */
async function openDetailSheet() {
  const cell = await waitFor(() => {
    const el = Array.from(document.querySelectorAll("td")).find((td) =>
      td.textContent?.includes("Top customers by revenue"),
    );
    if (!el) throw new Error("pattern row not rendered");
    return el;
  });
  await act(async () => {
    fireEvent.click(cell);
  });
  await waitFor(() => {
    const sheet = document.querySelector(SHEET);
    if (!sheet || !findButtonIn(sheet, "Approve")) throw new Error("sheet not open");
  });
}

describe("/admin/learned-patterns cockpit failure honesty (#4574)", () => {
  beforeEach(() => {
    testQueryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { retry: false },
      },
    });
  });

  afterEach(() => {
    testQueryClient.clear();
    cleanup();
    globalThis.fetch = originalFetch;
  });

  test("a failed Approve from the sheet renders the error inside the sheet, not behind it", async () => {
    mockLearnedPatternsApi({
      patch: () =>
        jsonResponse({ message: "Pattern is locked", requestId: "req-lp-500" }, 500),
    });

    render(<LearnedPatternsPage />, { wrapper: Wrapper });
    await openDetailSheet();

    const sheet = document.querySelector(SHEET)!;
    await act(async () => {
      fireEvent.click(findButtonIn(sheet, "Approve")!);
    });

    // The alert lands inside the still-open sheet — the whole point of the fix.
    const alert = await waitFor(() => {
      const el = document.querySelector(`${SHEET} [role="alert"]`);
      if (!el) throw new Error("in-sheet alert not rendered");
      return el;
    });
    expect(alert.textContent).toContain("Pattern is locked");
    expect(alert.textContent).toContain("req-lp-500");

    // Sheet is still open and the action button is back to being actionable —
    // a failed review is never mistaken for a completed one.
    expect(document.querySelector(SHEET)).not.toBeNull();
    expect(findButtonIn(document.querySelector(SHEET)!, "Approve")).toBeDefined();
    // Exactly one alert — no duplicate page-body banner rendered behind the sheet.
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1);
  });

  test('the in-sheet "Retry" genuinely re-issues the mutation; "Dismiss" only clears', async () => {
    const counters = mockLearnedPatternsApi({
      patch: () => jsonResponse({ message: "Transient failure" }, 503),
    });

    render(<LearnedPatternsPage />, { wrapper: Wrapper });
    await openDetailSheet();

    const sheet = document.querySelector(SHEET)!;
    await act(async () => {
      fireEvent.click(findButtonIn(sheet, "Approve")!);
    });
    await waitFor(() => {
      if (!document.querySelector(`${SHEET} [role="alert"]`)) throw new Error("no alert");
    });
    expect(counters.patch).toBe(1);

    // Retry fires the PATCH again (still failing) — a real retry, not a dismiss.
    const alertRoot = document.querySelector(`${SHEET} [role="alert"]`)!;
    await act(async () => {
      fireEvent.click(findButtonIn(alertRoot, "Retry")!);
    });
    await waitFor(() => {
      if (counters.patch < 2) throw new Error("retry did not re-issue the mutation");
    });
    expect(counters.patch).toBe(2);

    // Dismiss clears the alert without issuing another request.
    const afterRetry = document.querySelector(`${SHEET} [role="alert"]`)!;
    await act(async () => {
      fireEvent.click(findButtonIn(afterRetry, "Dismiss")!);
    });
    await waitFor(() => {
      if (document.querySelector(`${SHEET} [role="alert"]`)) throw new Error("alert not dismissed");
    });
    expect(counters.patch).toBe(2);
    // Sheet stays open after dismiss.
    expect(document.querySelector(SHEET)).not.toBeNull();
  });

  test("a successful Approve closes/updates without any error surface", async () => {
    mockLearnedPatternsApi({
      patch: () => jsonResponse({ ...PATTERN, status: "approved" }),
    });

    render(<LearnedPatternsPage />, { wrapper: Wrapper });
    await openDetailSheet();

    const sheet = document.querySelector(SHEET)!;
    await act(async () => {
      fireEvent.click(findButtonIn(sheet, "Approve")!);
    });

    // No error alert anywhere; the sheet reflects the new approved status.
    await waitFor(() => {
      const s = document.querySelector(SHEET);
      if (!s || !s.textContent?.includes("Approved")) throw new Error("status not updated");
    });
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  test("a failed Delete keeps the confirm dialog open with the error inside it, and Retry re-issues", async () => {
    const counters = mockLearnedPatternsApi({
      del: () => jsonResponse({ message: "Delete blocked", requestId: "req-del-9" }, 409),
    });

    render(<LearnedPatternsPage />, { wrapper: Wrapper });
    await openDetailSheet();

    // Sheet → Delete opens the confirm dialog.
    const sheet = document.querySelector(SHEET)!;
    await act(async () => {
      fireEvent.click(findButtonIn(sheet, "Delete")!);
    });
    const dialog = await waitFor(() => {
      const el = document.querySelector(DELETE_DIALOG);
      if (!el) throw new Error("delete dialog not open");
      return el;
    });

    // Confirm the delete → it fails.
    await act(async () => {
      fireEvent.click(findButtonIn(dialog, "Delete")!);
    });

    // Error renders inside the dialog and the dialog stays open (not silently
    // closed as if the delete had gone through).
    const alert = await waitFor(() => {
      const el = document.querySelector(`${DELETE_DIALOG} [role="alert"]`);
      if (!el) throw new Error("in-dialog alert not rendered");
      return el;
    });
    expect(alert.textContent).toContain("Delete blocked");
    expect(document.querySelector(DELETE_DIALOG)).not.toBeNull();
    expect(counters.del).toBe(1);

    // The in-dialog Retry genuinely re-issues the DELETE (still failing).
    await act(async () => {
      fireEvent.click(findButtonIn(alert, "Retry")!);
    });
    await waitFor(() => {
      if (counters.del < 2) throw new Error("delete retry did not re-issue");
    });
    expect(counters.del).toBe(2);
    expect(document.querySelector(DELETE_DIALOG)).not.toBeNull();
  });

  test("a successful Delete closes the confirm dialog with no error surface", async () => {
    mockLearnedPatternsApi({ del: () => new Response(null, { status: 204 }) });

    render(<LearnedPatternsPage />, { wrapper: Wrapper });
    await openDetailSheet();

    const sheet = document.querySelector(SHEET)!;
    await act(async () => {
      fireEvent.click(findButtonIn(sheet, "Delete")!);
    });
    const dialog = await waitFor(() => {
      const el = document.querySelector(DELETE_DIALOG);
      if (!el) throw new Error("delete dialog not open");
      return el;
    });

    await act(async () => {
      fireEvent.click(findButtonIn(dialog, "Delete")!);
    });

    // The success path must close the dialog (the preventDefault guard only
    // holds it open on failure) and surface no error.
    await waitFor(() => {
      if (document.querySelector(DELETE_DIALOG)) throw new Error("dialog did not close on success");
    });
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  test("a bulk approve partial-failure surfaces a page banner whose Retry re-issues the bulk call", async () => {
    // Server returns 200 with the failed row in `notFound` — a partial success
    // the page must not read as a clean sweep.
    const counters = mockLearnedPatternsApi({
      bulk: () => jsonResponse({ updated: [], notFound: ["lp-1"], errors: [] }),
    });

    render(<LearnedPatternsPage />, { wrapper: Wrapper });

    // Select the row, then run a bulk approve from the toolbar.
    const checkbox = await waitFor(() => {
      const el = document.querySelector('[aria-label="Select row"]');
      if (!el) throw new Error("row checkbox not rendered");
      return el as HTMLElement;
    });
    await act(async () => {
      fireEvent.click(checkbox);
    });
    const bulkApprove = await waitFor(() => {
      const el = Array.from(document.querySelectorAll("button")).find((b) =>
        b.textContent?.trim().startsWith("Approve 1"),
      );
      if (!el) throw new Error("bulk approve button not shown");
      return el as HTMLButtonElement;
    });
    await act(async () => {
      fireEvent.click(bulkApprove);
    });

    // Partial failure → page-body alert (no overlay open, so the page surface is
    // correct and visible).
    const alert = await waitFor(() => {
      const el = document.querySelector('[role="alert"]');
      if (!el) throw new Error("bulk partial-failure alert not rendered");
      return el;
    });
    expect(counters.bulk).toBe(1);

    // Retry re-issues the bulk POST (selection was narrowed to the failed id).
    await act(async () => {
      fireEvent.click(findButtonIn(alert, "Retry")!);
    });
    await waitFor(() => {
      if (counters.bulk < 2) throw new Error("bulk retry did not re-issue");
    });
    expect(counters.bulk).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Merged from cockpit-visibility.test.tsx (#4578) — same source module
// (`../page`) and the same single `next/navigation` mock, so the harness
// above (stubAuthClient, Wrapper, jsonResponse, originalFetch, SHEET) is
// shared. The moved suite's own fixtures keep a `VISIBILITY_` prefix where
// they would otherwise collide with the failure-honesty ones.
// ---------------------------------------------------------------------------

/**
 * Cockpit visibility (#4578): the page-level rendering of the acceptance
 * criteria that unit/wire tests can't pin — the approval-consequence explainer,
 * the reviewer resolved to a name/email (never a raw UUID), the connection-group
 * column shown only for multi-group workspaces, the stats bar fed from the
 * summary, and a summary load failure surfaced instead of a vanished stats row.
 */

// A distinctive reviewer UUID so "the UUID must not render" is an unambiguous
// assertion — the UI must show `reviewedByLabel`, never this.
const REVIEWER_UUID = "usr_00000000-dead-beef-0000-cafe12345678";

const REVIEWED_PATTERN = {
  id: "lp-9",
  orgId: null,
  connectionGroupId: "prod",
  patternSql: "SELECT 1",
  description: "Revenue by region",
  sourceEntity: "orders",
  sourceQueries: null,
  confidence: 0.9,
  repetitionCount: 4,
  status: "approved" as const,
  proposedBy: "agent" as const,
  reviewedBy: REVIEWER_UUID,
  reviewedByLabel: "Ada Lovelace",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-02T00:00:00.000Z",
  reviewedAt: "2026-07-02T00:00:00.000Z",
  type: "query_pattern" as const,
  amendmentPayload: null,
  autoPromoted: false,
  avgDurationMs: 12,
  injectionCount: 7,
};

const VISIBILITY_LIST_ENVELOPE = { patterns: [REVIEWED_PATTERN], total: 1, limit: 50, offset: 0 };

function makeSummary(multiGroup: boolean) {
  return {
    stats: { total: 3, pending: 1, approved: 1, rejected: 1 },
    entities: ["orders"],
    multiGroup,
  };
}

/**
 * Route GETs. `summaryStatus` lets a test drive a summary failure; otherwise the
 * summary reflects `multiGroup`. The list + pending-count return fixed shapes.
 */
function mockApi(opts: { multiGroup: boolean; summaryStatus?: number }) {
  globalThis.fetch = mock((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (/\/api\/v1\/admin\/learned-patterns\/summary/.test(url)) {
      if (opts.summaryStatus && opts.summaryStatus >= 400) {
        return Promise.resolve(jsonResponse({ message: "Forbidden", requestId: "req-sum-1" }, opts.summaryStatus));
      }
      return Promise.resolve(jsonResponse(makeSummary(opts.multiGroup)));
    }
    if (/\/api\/v1\/admin\/learned-patterns\/pending-count/.test(url)) {
      return Promise.resolve(jsonResponse({ count: 1 }));
    }
    if (url.includes("/api/v1/admin/learned-patterns")) {
      return Promise.resolve(jsonResponse(VISIBILITY_LIST_ENVELOPE));
    }
    throw new Error(`unexpected GET ${url}`);
  }) as unknown as typeof fetch;
}

async function openVisibilityDetailSheet() {
  const cell = await waitFor(() => {
    const el = Array.from(document.querySelectorAll("td")).find((td) =>
      td.textContent?.includes("Revenue by region"),
    );
    if (!el) throw new Error("pattern row not rendered");
    return el;
  });
  await act(async () => {
    fireEvent.click(cell);
  });
  await waitFor(() => {
    if (!document.querySelector(SHEET)) throw new Error("sheet not open");
  });
}

describe("/admin/learned-patterns cockpit visibility (#4578)", () => {
  beforeEach(() => {
    testQueryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { retry: false },
      },
    });
  });

  afterEach(() => {
    testQueryClient.clear();
    cleanup();
    globalThis.fetch = originalFetch;
  });

  test("states the approval consequence in one sentence on the page", async () => {
    mockApi({ multiGroup: false });
    render(<LearnedPatternsPage />, { wrapper: Wrapper });
    const explainer = await waitFor(() => {
      const el = Array.from(document.querySelectorAll("p")).find((p) =>
        /injects it into the agent/i.test(p.textContent ?? ""),
      );
      if (!el) throw new Error("approval-consequence explainer not rendered");
      return el;
    });
    expect(explainer.textContent).toMatch(/regardless of its confidence/i);
  });

  test("renders the stats bar from the summary (query-pattern counts)", async () => {
    mockApi({ multiGroup: false });
    render(<LearnedPatternsPage />, { wrapper: Wrapper });
    // The stats bar shows lowercase "pending"/"approved" labels (the filter
    // buttons are capitalized), so a lowercase substring pins the bar itself.
    // `textContent` concatenates the stat spans without spaces, so match the
    // count + label pairs rather than a word-boundary form.
    await waitFor(() => {
      const bar = document.body.textContent ?? "";
      if (!bar.includes("pending") || !bar.includes("approved")) {
        throw new Error("stats bar not rendered");
      }
    });
  });

  test("surfaces the per-pattern injection count in the list column and detail sheet (#4573)", async () => {
    mockApi({ multiGroup: false });
    render(<LearnedPatternsPage />, { wrapper: Wrapper });

    // List: the "Injected (30d)" column header + the fixture's count cell (7).
    await waitFor(() => {
      const headers = Array.from(document.querySelectorAll("th")).map((h) => h.textContent ?? "");
      if (!headers.some((h) => h.includes("Injected (30d)"))) {
        throw new Error("injection-count column header not rendered");
      }
      const cell = Array.from(document.querySelectorAll("td")).some((td) => td.textContent?.trim() === "7");
      if (!cell) throw new Error("injection-count cell not rendered");
    });

    // Detail sheet: the "Injected (30d)" field label + its value. Pin the value
    // to the field's own <p> (the sibling of the label span) rather than the
    // whole sheet text — ISO dates elsewhere in the sheet also contain "7".
    await openVisibilityDetailSheet();
    const sheet = document.querySelector(SHEET)!;
    const valueEl = await waitFor(() => {
      const label = Array.from(sheet.querySelectorAll("span")).find(
        (s) => s.textContent?.trim() === "Injected (30d)",
      );
      const value = label?.parentElement?.querySelector("p");
      if (!value) throw new Error("injection-count field not in sheet");
      return value;
    });
    expect(valueEl.textContent?.trim()).toBe("7");
  });

  test("resolves the reviewer to a name/email in the sheet — never the raw UUID", async () => {
    mockApi({ multiGroup: false });
    render(<LearnedPatternsPage />, { wrapper: Wrapper });
    await openVisibilityDetailSheet();

    const sheet = document.querySelector(SHEET)!;
    await waitFor(() => {
      if (!sheet.textContent?.includes("Reviewed by")) throw new Error("review history not shown");
    });
    expect(sheet.textContent).toContain("Ada Lovelace");
    // The raw reviewer UUID must never leak into the UI (#4578).
    expect(document.body.textContent).not.toContain(REVIEWER_UUID);
  });

  test("shows the connection-group column + sheet field only for multi-group workspaces", async () => {
    mockApi({ multiGroup: true });
    render(<LearnedPatternsPage />, { wrapper: Wrapper });

    // Column header appears.
    await waitFor(() => {
      const hasGroupHeader = Array.from(document.querySelectorAll("th")).some((th) =>
        th.textContent?.includes("Group"),
      );
      if (!hasGroupHeader) throw new Error("Group column header not rendered");
    });
    // Row cell shows the group slug.
    expect(
      Array.from(document.querySelectorAll("td")).some((td) => td.textContent?.trim() === "prod"),
    ).toBe(true);

    // The detail sheet also surfaces the group for the multi-group case.
    await openVisibilityDetailSheet();
    const sheet = document.querySelector(SHEET)!;
    await waitFor(() => {
      if (!sheet.textContent?.includes("Group")) throw new Error("sheet group field not shown");
    });
    expect(sheet.textContent).toContain("prod");
  });

  test("hides the connection-group column for a single-group workspace", async () => {
    mockApi({ multiGroup: false });
    render(<LearnedPatternsPage />, { wrapper: Wrapper });
    await waitFor(() => {
      const el = Array.from(document.querySelectorAll("td")).find((td) =>
        td.textContent?.includes("Revenue by region"),
      );
      if (!el) throw new Error("row not rendered");
    });
    const hasGroupHeader = Array.from(document.querySelectorAll("th")).some((th) =>
      th.textContent?.trim() === "Group",
    );
    expect(hasGroupHeader).toBe(false);
  });

  test("surfaces a summary load failure instead of a silently vanished stats row", async () => {
    mockApi({ multiGroup: false, summaryStatus: 403 });
    render(<LearnedPatternsPage />, { wrapper: Wrapper });
    const alert = await waitFor(() => {
      const el = Array.from(document.querySelectorAll('[role="alert"]')).find((n) =>
        /couldn.t load pattern summary/i.test(n.textContent ?? ""),
      );
      if (!el) throw new Error("summary error not surfaced");
      return el;
    });
    expect(alert.textContent).toMatch(/couldn.t load pattern summary/i);
  });
});
