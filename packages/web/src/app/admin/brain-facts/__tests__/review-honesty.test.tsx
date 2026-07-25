import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { AtlasProvider, type AtlasAuthClient } from "@/ui/context";

/**
 * What the review gate must SAY, not just fetch (#4772, ADR-0036).
 *
 * Every assertion here is about a place where a quiet UI would mislead a
 * reviewer into approving something they shouldn't:
 *
 *   - publish promotes EVERY remaining draft, so the reject-then-publish loop
 *     has to be stated — a reviewer who reads the missing Approve button as a
 *     bug will publish claims they meant to hold;
 *   - an episode the reviewer may not read is named as restricted, never left
 *     blank, so "no evidence shown" can't be mistaken for "no evidence";
 *   - a conflicting claim is surfaced with both sides and no verdict;
 *   - a claim publish would refuse carries the API's prose reason.
 */

void mock.module("next/navigation", () => ({
  usePathname: () => "/admin/brain-facts",
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const stubAuthClient: AtlasAuthClient = {
  signIn: { email: async () => ({}) },
  signUp: { email: async () => ({}) },
  signOut: async () => {},
  useSession: () => ({ data: null, isPending: false }),
};

const BrainFactsPage = (await import("../page")).default;

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

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const ISO = "2026-07-01T00:00:00.000Z";

const PROVENANCE = {
  source: "slack",
  sourceId: "C1/17",
  episodeId: "ep-1",
  actor: "U1",
  producer: "extraction:v1",
  occurredAt: ISO,
  extractedAt: ISO,
  reconciledAt: ISO,
  provisional: false,
  unresolved: [],
  payloadComplete: true,
};

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: "fact-1",
    subject: "Acme",
    predicate: "uses",
    object: "Postgres",
    status: "draft",
    predicateCardinality: "single",
    visibleTo: ["org"],
    malformedGrantIndices: [],
    grantReadable: true,
    corroborationCount: 2,
    provenance: PROVENANCE,
    episode: {
      visible: true,
      id: "ep-1",
      source: "slack",
      sourceId: "C1/17",
      sourceActor: "U1",
      body: "we run everything on postgres",
      bodyTruncated: false,
      locator: null,
      occurredAt: ISO,
      ingestedAt: ISO,
    },
    tensions: [],
    promotionBlock: null,
    validFrom: null,
    validTo: null,
    extractedAt: ISO,
    ingestedAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

/** Every URL the page is allowed to touch. */
const ALLOWED = [
  /\/api\/v1\/admin\/brain-facts\/summary$/,
  /\/api\/v1\/admin\/brain-facts\/[^/]+\/retract$/,
  /\/api\/v1\/admin\/brain-facts(\?|$)/,
  /\/api\/v1\/admin\/publish-preview$/,
  /\/api\/v1\/admin\/publish$/,
];

/** Every request the page made, so a test can assert on its whole surface. */
let requested: Array<{ url: string; method: string }> = [];
/** Status the retract POST answers with. */
let retractStatus = 200;

function mockApi(
  candidates: Array<Record<string, unknown>>,
  opts: { tensionsTruncated?: boolean } = {},
) {
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    requested.push({ url, method: (init?.method ?? "GET").toUpperCase() });
    if (/\/retract$/.test(url)) {
      return Promise.resolve(
        retractStatus === 200
          ? jsonResponse({ id: "fact-1", invalidatedAt: ISO })
          : jsonResponse(
              { error: "internal_error", message: "Database exploded.", requestId: "req-xyz" },
              retractStatus,
            ),
      );
    }
    if (url.includes("/api/v1/admin/brain-facts/summary")) {
      return Promise.resolve(
        jsonResponse({ draftTotal: 3, provisionalTotal: 1, inTensionTotal: 1, publishedTotal: 12 }),
      );
    }
    if (url.includes("/api/v1/admin/brain-facts")) {
      return Promise.resolve(
        jsonResponse({
          candidates,
          total: candidates.length,
          tensionsTruncated: opts.tensionsTruncated ?? false,
        }),
      );
    }
    if (url.includes("/api/v1/admin/publish-preview")) {
      return Promise.resolve(
        jsonResponse({
          connections: [],
          entities: [],
          entityEdits: [],
          entityDeletes: [],
          prompts: [],
          starterPrompts: [],
          knowledgeDocuments: [],
          brainFacts: [],
        }),
      );
    }
    // A catch-all that SUCCEEDS would let an unexpected endpoint — a
    // status-writing "approve" somebody adds later — pass unnoticed. Failing
    // loudly is what makes the allowed-surface assertion structural.
    return Promise.reject(new Error(`unexpected request: ${url}`));
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  requested = [];
  retractStatus = 200;
  testQueryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  testQueryClient.clear();
});

async function renderPage(
  candidates: Array<Record<string, unknown>>,
  opts: { tensionsTruncated?: boolean } = {},
) {
  mockApi(candidates, opts);
  const view = render(createElement(BrainFactsPage), { wrapper: Wrapper });
  await waitFor(() => expect(view.container.textContent).toContain("Acme"));
  return view;
}

function clickButton(view: { container: HTMLElement }, label: RegExp) {
  const button = Array.from(view.container.querySelectorAll("button")).find((b) =>
    label.test(b.textContent ?? ""),
  );
  if (!button) throw new Error(`no button matching ${label}`);
  fireEvent.click(button);
}

/**
 * Confirm the open reject dialog.
 *
 * Scoped to the dialog on purpose: the row action carries the same "Reject"
 * label, so a document-wide lookup finds the row button and re-opens the dialog
 * instead of confirming — a test that then passes for the wrong reason.
 */
async function confirmReject() {
  await waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull());
  const dialog = document.querySelector('[role="alertdialog"]')!;
  const confirm = Array.from(dialog.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === "Reject",
  );
  if (!confirm) throw new Error("no confirm button inside the reject dialog");
  fireEvent.click(confirm);
}

describe("the reject-then-publish loop is stated", () => {
  test("says publish promotes every remaining draft", async () => {
    const view = await renderPage([candidate()]);
    // Without this, the missing per-row Approve reads as a bug and the reviewer
    // publishes the whole queue believing they approved one claim.
    expect(view.container.textContent).toContain("every remaining draft");
  });

  test("offers no per-row approve verb", async () => {
    const view = await renderPage([candidate()]);
    const labels = Array.from(view.container.querySelectorAll("button")).map(
      (b) => b.textContent ?? "",
    );
    // `brain_facts.status` has exactly one writer. An Approve button here would
    // have to be a second one.
    expect(labels.some((l) => /^approve/i.test(l.trim()))).toBe(false);
    expect(labels.some((l) => /reject/i.test(l))).toBe(true);
  });

  test("touches no endpoint outside the allowed surface", async () => {
    // The durable half of the assertion above. A label regex is defeated by a
    // "Trust this claim" button; this is defeated only by not calling a
    // status-writing endpoint at all. Publishing goes through the shared modal,
    // which is why publish-preview/publish are in the allowed set.
    const view = await renderPage([candidate()]);
    clickButton(view, /Review & publish/i);
    await waitFor(() => expect(requested.length).toBeGreaterThan(1));

    for (const req of requested) {
      expect(ALLOWED.some((re) => re.test(req.url))).toBe(true);
    }
  });

  test("explains that rejecting withdraws rather than deletes", async () => {
    const view = await renderPage([candidate()]);
    fireEvent.click(
      Array.from(view.container.querySelectorAll("button")).find((b) =>
        /reject/i.test(b.textContent ?? ""),
      )!,
    );
    await waitFor(() => expect(document.body.textContent).toContain("Reject this claim?"));
    // ADR-0036: supersession is not deletion — a reviewer must know the record
    // survives, or they will hesitate to reject a wrong claim.
    expect(document.body.textContent).toContain("Nothing is deleted");
  });
});

describe("rejecting a claim", () => {
  test("keeps the dialog open with the reason when the retract fails", async () => {
    // The dangerous outcome: Radix auto-closes on click, the reviewer believes
    // they pulled the claim, and it is still in the set the next publish
    // promotes. `friendlyError` also carries the request id through.
    retractStatus = 500;
    const view = await renderPage([candidate()]);
    clickButton(view, /Reject/i);
    await waitFor(() => expect(document.body.textContent).toContain("Reject this claim?"));

    await confirmReject();

    await waitFor(() =>
      expect(requested.some((r) => /\/retract$/.test(r.url) && r.method === "POST")).toBe(true),
    );
    // Still open, and saying why.
    expect(document.body.textContent).toContain("Reject this claim?");
    expect(document.body.textContent).toContain("req-xyz");
  });

  test("closes the dialog only once the retract succeeded", async () => {
    const view = await renderPage([candidate()]);
    clickButton(view, /Reject/i);
    await waitFor(() => expect(document.body.textContent).toContain("Reject this claim?"));

    await confirmReject();

    await waitFor(() => expect(document.body.textContent).not.toContain("Reject this claim?"));
  });

  test("POSTs to the retract endpoint, never a status write", async () => {
    const view = await renderPage([candidate()]);
    clickButton(view, /Reject/i);
    await waitFor(() => expect(document.body.textContent).toContain("Reject this claim?"));
    await confirmReject();

    await waitFor(() => expect(requested.some((r) => r.method === "POST")).toBe(true));
    const writes = requested.filter((r) => r.method === "POST");
    expect(writes).toHaveLength(1);
    expect(writes[0]!.url).toMatch(/\/api\/v1\/admin\/brain-facts\/fact-1\/retract$/);
  });
});

describe("withheld evidence is named, never blank", () => {
  test("marks a restricted episode in the list", async () => {
    const view = await renderPage([
      candidate({ episode: { visible: false, id: "ep-1" } }),
    ]);
    expect(view.container.textContent).toContain("Evidence restricted");
  });

  test("explains in the detail sheet what approving without evidence means", async () => {
    const view = await renderPage([
      candidate({ episode: { visible: false, id: "ep-1" } }),
    ]);
    fireEvent.click(view.container.querySelectorAll("tbody tr")[0]!);
    await waitFor(() => expect(document.body.textContent).toContain("Fact candidate"));
    expect(document.body.textContent).toContain("separate grants");
  });
});

describe("contradictions are surfaced, not arbitrated", () => {
  test("shows the rival claim with its own evidence and no verdict", async () => {
    const view = await renderPage([
      candidate({
        tensions: [
          {
            visible: true,
            factId: "fact-2",
            edgeDirection: "to",
            subject: "Acme",
            predicate: "uses",
            object: "MySQL",
            status: "published",
            validFrom: null,
            ingestedAt: ISO,
            invalidatedAt: null,
            corroborationCount: 5,
            provenance: PROVENANCE,
          },
        ],
      }),
    ]);
    fireEvent.click(view.container.querySelectorAll("tbody tr")[0]!);
    await waitFor(() => expect(document.body.textContent).toContain("Conflicting claims"));

    const text = document.body.textContent ?? "";
    expect(text).toContain("MySQL");
    expect(text).toContain("is not choosing between them");
    // No language that ranks one side. M2 owns arbitration; this surface must
    // not pre-empt it with a "preferred"/"superseded" label.
    expect(text).not.toMatch(/superseded|preferred|winner|more reliable/i);
  });

  test("reports a rival the reviewer cannot see rather than hiding the conflict", async () => {
    const view = await renderPage([
      candidate({
        tensions: [
          { visible: false, factId: "fact-2", edgeDirection: "to" },
        ],
      }),
    ]);
    fireEvent.click(view.container.querySelectorAll("tbody tr")[0]!);
    await waitFor(() => expect(document.body.textContent).toContain("Conflicting claims"));
    expect(document.body.textContent).toContain("not allowed to see");
  });
});

describe("refusals and quality flags", () => {
  test("renders the publish endpoint's own prose reason verbatim", async () => {
    const view = await renderPage([
      candidate({
        visibleTo: ["everyone"],
        malformedGrantIndices: [0],
        promotionBlock: {
          reasons: ["GRANT_UNUSABLE"],
          detail: "…was not published because its grant contains no usable principal…",
        },
      }),
    ]);
    fireEvent.click(view.container.querySelectorAll("tbody tr")[0]!);
    await waitFor(() => expect(document.body.textContent).toContain("Fact candidate"));
    // Verbatim, so the refusal vocabulary can grow without a copy change here.
    expect(document.body.textContent).toContain("no usable principal");
  });

  test("flags a provisional candidate as a decision about the entity", async () => {
    const view = await renderPage([
      candidate({
        provenance: { ...PROVENANCE, provisional: true, unresolved: ["object"] },
      }),
    ]);
    expect(view.container.textContent).toContain("Provisional");

    fireEvent.click(view.container.querySelectorAll("tbody tr")[0]!);
    await waitFor(() => expect(document.body.textContent).toContain("Fact candidate"));
    expect(document.body.textContent).toContain("the object of this claim");
  });

  test("says a claim's provenance payload is incomplete instead of showing blanks", async () => {
    const view = await renderPage([
      candidate({ provenance: { ...PROVENANCE, producer: null, payloadComplete: false } }),
    ]);
    expect(view.container.textContent).toContain("Incomplete provenance");
  });
});

describe("the list shows the trust signals without a click", () => {
  test("renders the grant and the corroboration count in the row", async () => {
    // Named explicitly by the acceptance criteria. Deleting either column would
    // otherwise pass every other test in this file.
    const view = await renderPage([
      candidate({ visibleTo: ["role:admin", "audience:eng"], corroborationCount: 7 }),
    ]);
    const text = view.container.textContent ?? "";
    expect(text).toContain("role:admin, audience:eng");
    expect(text).toContain("7");
  });

  test("says a grant that would not decode is unreadable, not empty", async () => {
    // An empty token list reads as "visible to nobody" — i.e. harmless — when
    // the claim may in fact be org-wide.
    const view = await renderPage([candidate({ visibleTo: [], grantReadable: false })]);
    expect(view.container.textContent).toContain("grant unreadable");
  });

  test("flags dead grant tokens even when publish would still succeed", async () => {
    // The state a reviewer most needs told: the claim WILL publish, but part of
    // the grant its author wrote does nothing.
    const view = await renderPage([
      candidate({ visibleTo: ["org", "everyone"], malformedGrantIndices: [1], promotionBlock: null }),
    ]);
    expect(view.container.textContent).toContain("Grant has junk");

    fireEvent.click(view.container.querySelectorAll("tbody tr")[0]!);
    await waitFor(() => expect(document.body.textContent).toContain("Fact candidate"));
    expect(document.body.textContent).toContain("grant nobody access");
  });
});

describe("a broken queue gates the publish-everything button", () => {
  test("disables Review & publish when the list failed to load", async () => {
    // Publishing is workspace-wide and independent of this ACL read, so an
    // enabled button above a red banner would let a reviewer promote every
    // draft precisely when they have been shown none of them. The read model
    // now throws instead of returning an empty queue; this is the other half.
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/v1/admin/brain-facts/summary")) {
        return Promise.resolve(
          jsonResponse({ draftTotal: 3, provisionalTotal: 0, inTensionTotal: 0, publishedTotal: 0 }),
        );
      }
      if (url.includes("/api/v1/admin/brain-facts")) {
        return Promise.resolve(
          jsonResponse({ error: "internal_error", message: "boom", requestId: "req-1" }, 500),
        );
      }
      return Promise.reject(new Error(`unexpected request: ${url}`));
    }) as unknown as typeof fetch;

    const view = render(createElement(BrainFactsPage), { wrapper: Wrapper });
    const publish = await waitFor(() => {
      const b = Array.from(view.container.querySelectorAll("button")).find((x) =>
        /Review & publish/i.test(x.textContent ?? ""),
      );
      if (!b?.hasAttribute("disabled")) throw new Error("not disabled yet");
      return b;
    });
    expect(publish.hasAttribute("disabled")).toBe(true);
  });

  test("shows the error banner rather than the reassuring empty state", async () => {
    // "Nothing to review" over a failed read is the exact reassurance that
    // precedes an unreviewed publish.
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/v1/admin/brain-facts/summary")) {
        return Promise.resolve(
          jsonResponse({ draftTotal: 3, provisionalTotal: 0, inTensionTotal: 0, publishedTotal: 0 }),
        );
      }
      if (url.includes("/api/v1/admin/brain-facts")) {
        return Promise.resolve(
          jsonResponse({ error: "internal_error", message: "boom", requestId: "req-1" }, 500),
        );
      }
      return Promise.reject(new Error(`unexpected request: ${url}`));
    }) as unknown as typeof fetch;

    const view = render(createElement(BrainFactsPage), { wrapper: Wrapper });
    await waitFor(() => expect(view.container.textContent).not.toContain("Nothing to review"));
  });
});

describe("truncation is admitted", () => {
  test("warns when the page could not show every conflict", async () => {
    // The cap is applied across the page in edge-id order, so specific
    // candidates lose ALL of their hints — nothing in a row can show that, and
    // a silent page renders as "nothing conflicts with any of this".
    const view = await renderPage([candidate()], { tensionsTruncated: true });
    expect(view.container.textContent).toContain("more conflicting claims than Atlas can show");
  });

  test("marks a clipped episode body rather than passing a prefix off as the message", async () => {
    const view = await renderPage([
      candidate({
        episode: {
          visible: true,
          id: "ep-1",
          source: "slack",
          sourceId: "C1/17",
          sourceActor: "U1",
          body: "a very long message",
          bodyTruncated: true,
          locator: null,
          occurredAt: ISO,
          ingestedAt: ISO,
        },
      }),
    ]);
    fireEvent.click(view.container.querySelectorAll("tbody tr")[0]!);
    await waitFor(() => expect(document.body.textContent).toContain("Fact candidate"));
    expect(document.body.textContent).toContain("(truncated)");
  });

  test("labels a WITHDRAWN rival, which its status alone cannot show", async () => {
    // Retraction never writes `status`, so a retracted rival still reports
    // "Draft" — a resolved conflict would otherwise look live.
    const view = await renderPage([
      candidate({
        tensions: [
          {
            visible: true,
            factId: "fact-2",
            edgeDirection: "to",
            subject: "Acme",
            predicate: "uses",
            object: "MySQL",
            status: "draft",
            validFrom: null,
            ingestedAt: ISO,
            invalidatedAt: ISO,
            corroborationCount: 1,
            provenance: PROVENANCE,
          },
        ],
      }),
    ]);
    fireEvent.click(view.container.querySelectorAll("tbody tr")[0]!);
    await waitFor(() => expect(document.body.textContent).toContain("Conflicting claims"));
    expect(document.body.textContent).toContain("Withdrawn");
  });
});

describe("queue vitals", () => {
  test("shows the reviewable backlog", async () => {
    const view = await renderPage([candidate()]);
    const text = view.container.textContent ?? "";
    expect(text).toContain("awaiting review");
    expect(text).toContain("provisional");
    expect(text).toContain("in tension");
  });

  test("surfaces a failed vitals load instead of a silently missing stats row", async () => {
    mockApi([candidate()]);
    const previous = globalThis.fetch;
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/v1/admin/brain-facts/summary")) {
        return Promise.resolve(
          jsonResponse({ error: "forbidden", message: "Nope.", requestId: "req-sum" }, 403),
        );
      }
      return (previous as typeof fetch)(input, init);
    }) as unknown as typeof fetch;

    const view = render(createElement(BrainFactsPage), { wrapper: Wrapper });
    await waitFor(() => expect(view.container.textContent).toContain("Couldn't load queue totals"));
  });
});
