import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { render, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { AtlasProvider, type AtlasAuthClient } from "@/ui/context";

/**
 * Cockpit visibility (#4578): the page-level rendering of the acceptance
 * criteria that unit/wire tests can't pin — the approval-consequence explainer,
 * the reviewer resolved to a name/email (never a raw UUID), the connection-group
 * column shown only for multi-group workspaces, the stats bar fed from the
 * summary, and a summary load failure surfaced instead of a vanished stats row.
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

const LIST_ENVELOPE = { patterns: [REVIEWED_PATTERN], total: 1, limit: 50, offset: 0 };

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
      return Promise.resolve(jsonResponse(LIST_ENVELOPE));
    }
    throw new Error(`unexpected GET ${url}`);
  }) as unknown as typeof fetch;
}

const SHEET = '[data-slot="sheet-content"]';

async function openDetailSheet() {
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
    await openDetailSheet();
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
    await openDetailSheet();

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
    await openDetailSheet();
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
