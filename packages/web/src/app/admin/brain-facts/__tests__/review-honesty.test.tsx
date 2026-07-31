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
  episodeId: "ep-1",
  producer: "extraction:v1",
  // The attribution triple travels as a discriminated variant (#4836) — who
  // stated the claim first, where, and when, withheld as a unit from a reader
  // who reaches the fact only through publish-time grant widening.
  attribution: { visible: true, sourceId: "C1/17", actor: "U1", occurredAt: ISO },
  extractedAt: ISO,
  reconciledAt: ISO,
  provisional: false,
  unresolved: [],
  payloadComplete: true,
};

/** The same payload as seen by a reader gained by widening. */
const WITHHELD_ATTRIBUTION = { ...PROVENANCE, attribution: { visible: false } };

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
    // Read-time decay (#4914) — fresh by default so the queue renders quiet.
    decay: { level: "fresh", ageDays: 5, lastObservedAt: ISO },
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
  /\/api\/v1\/admin\/brain-facts\/oversight$/,
  /\/api\/v1\/admin\/brain-facts\/[^/]+\/retract$/,
  /\/api\/v1\/admin\/brain-facts(\?|$)/,
  /\/api\/v1\/admin\/publish-preview$/,
  /\/api\/v1\/admin\/publish$/,
];

/** Every request the page made, so a test can assert on its whole surface. */
let requested: Array<{ url: string; method: string }> = [];
/** Status the retract POST answers with. */
let retractStatus = 200;
/**
 * The 200 body the retract POST answers with (#4939).
 *
 * Retracting is the `retract` CORRECTION verb, and it FLAGS every claim
 * derived from the one withdrawn. Those flags reached `logAdminAction` and
 * nothing else, so the console reviewer — the only person who knows a
 * retraction just happened — was the one party told nothing.
 */
let retractBody: Record<string, unknown> = {
  id: "fact-1",
  invalidatedAt: ISO,
  correctionEpisodeId: "ep-corr-1",
  flaggedForReReview: [],
};

/**
 * The oversight payload (#4825). Defaults to "nothing hidden", so the
 * disclosure's ABSENCE is the baseline every other test in this file renders
 * against — a panel that shouted at an admin with a fully visible queue would
 * be as wrong as one that stayed silent on a hidden backlog.
 */
let oversight: Record<string, unknown> = {
  buckets: [],
  workspaceTotals: {
    awaitingReview: 3,
    published: 12,
    retracted: 0,
    provisional: 1,
    inTension: 1,
  },
  reviewableAwaitingReview: 3,
  countsConsistent: true,
  distinctAudiences: 1,
  bucketsTruncated: false,
};
/** Withheld brain-fact count the publish preview reports. */
let withheldFacts = 0;
/** Whether that count is an Atlas fault rather than an audience boundary. */
let scopeUnavailable = false;
/** How many published facts the publish preview says a publish will supersede (#4912). */
let willSupersedeCount = 0;

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
          ? jsonResponse(retractBody)
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
    // BEFORE the bare `/brain-facts` arm: `.includes` would otherwise match the
    // list endpoint and answer the oversight fetch with a candidate page.
    if (url.includes("/api/v1/admin/brain-facts/oversight")) {
      return Promise.resolve(jsonResponse(oversight));
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
          brainFactsWithheld: withheldFacts,
          brainFactsScopeUnavailable: scopeUnavailable,
          brainFactsWillSupersede: willSupersedeCount,
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
  retractBody = {
    id: "fact-1",
    invalidatedAt: ISO,
    correctionEpisodeId: "ep-corr-1",
    flaggedForReReview: [],
  };
  withheldFacts = 0;
  scopeUnavailable = false;
  willSupersedeCount = 0;
  oversight = {
    buckets: [],
    workspaceTotals: {
      awaitingReview: 3,
      published: 12,
      retracted: 0,
      provisional: 1,
      inTension: 1,
    },
    reviewableAwaitingReview: 3,
    countsConsistent: true,
    distinctAudiences: 1,
    bucketsTruncated: false,
  };
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

  // #4939. The three tests below are one property split by arm: the reviewer
  // learns that a retraction had consequences beyond the row they clicked, and
  // learns it in the only place they will ever be told.
  test("reports the claims a retraction flagged for re-review", async () => {
    retractBody = {
      id: "fact-1",
      invalidatedAt: ISO,
      correctionEpisodeId: "ep-corr-1",
      flaggedForReReview: ["dep-1", "dep-2"],
    };
    const view = await renderPage([candidate()]);
    clickButton(view, /Reject/i);
    await waitFor(() => expect(document.body.textContent).toContain("Reject this claim?"));
    await confirmReject();

    // The dialog closes on success, so a notice rendered inside it would be
    // destroyed at the moment it had something to say. This has to OUTLIVE it.
    await waitFor(() => expect(document.body.textContent).not.toContain("Reject this claim?"));
    await waitFor(() => expect(document.body.textContent).toContain("2 other claims"));

    // Scoped to the notice, not to the document. The queue re-renders the same
    // claim in its own row, so a body-wide `toContain` for the claim text
    // passes off the TABLE — the notice could name nothing and still go green.
    const notice = Array.from(document.querySelectorAll('[role="alert"]')).find((el) =>
      /other claims/.test(el.textContent ?? ""),
    );
    expect(notice, "the flagged-dependent notice did not render as an alert").toBeTruthy();
    // Named, so the reviewer knows which rejection caused it, and honest about
    // the cascade that did NOT happen.
    expect(notice!.textContent).toContain("Acme uses Postgres");
    expect(notice!.textContent).toMatch(/nothing was withdrawn automatically/i);
  });

  test("stays silent when a retraction flagged nothing — silence is the baseline", async () => {
    // An always-on "0 other claims" line trains a reviewer to skip the banner,
    // which is precisely how the non-zero case gets missed.
    const view = await renderPage([candidate()]);
    clickButton(view, /Reject/i);
    await waitFor(() => expect(document.body.textContent).toContain("Reject this claim?"));
    await confirmReject();

    await waitFor(() => expect(document.body.textContent).not.toContain("Reject this claim?"));
    expect(document.body.textContent).not.toMatch(/other claims?\b/i);
  });

  test("claims nothing when the response body does not carry the flags", async () => {
    // An older API — or a drifted one — answers the pre-#4939 shape. Rendering
    // "0 other claims" off a missing field would be a fabricated all-clear on
    // the one surface whose job is not to reassure falsely.
    retractBody = { id: "fact-1", invalidatedAt: ISO };
    const view = await renderPage([candidate()]);
    clickButton(view, /Reject/i);
    await waitFor(() => expect(document.body.textContent).toContain("Reject this claim?"));
    await confirmReject();

    await waitFor(() => expect(document.body.textContent).not.toContain("Reject this claim?"));
    expect(document.body.textContent).not.toMatch(/other claims?\b/i);
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

describe("withheld attribution is named, never blank (#4836)", () => {
  test("labels the restricted attribution in the list", async () => {
    const view = await renderPage([candidate({ provenance: WITHHELD_ATTRIBUTION })]);
    expect(view.container.textContent).toContain("Attribution restricted");
  });

  test("does not render the author slot as an em-dash", async () => {
    // The whole reason the wire carries a variant rather than three nulls: a
    // dash reads as "the evidence has no author", which is a claim about the
    // DATA and is false. The reviewer has to be able to tell "nobody recorded
    // this" from "you are not entitled to it".
    const view = await renderPage([candidate({ provenance: WITHHELD_ATTRIBUTION })]);
    fireEvent.click(view.container.querySelectorAll("tbody tr")[0]!);
    await waitFor(() => expect(document.body.textContent).toContain("Fact candidate"));

    const text = document.body.textContent ?? "";
    expect(text).toContain("Attribution restricted");
    // The three withheld field labels are gone entirely, not blanked.
    expect(text).not.toContain("Asserted by");
    expect(text).not.toContain("Source ID");
    expect(text).not.toContain("Said at");
  });

  test("leaks nothing when paired with the withheld episode production always pairs it with", async () => {
    // The two withholdings are near-perfectly CORRELATED, not independent: a
    // fact's provenance names its first episode, and that episode's grant IS
    // the fact's pre-widening grant — so a reader who fails the attribution
    // check fails the episode check too, off `loadEpisodes`' own predicate.
    // This is therefore the shape production actually produces, and the only
    // one where "no value leaked anywhere on the page" is a meaningful claim.
    //
    // Asserted as a pair on purpose. The inverse fixture (withheld attribution
    // + VISIBLE episode) is unreachable for a widened fact, and in it `U1`
    // legitimately renders in the episode panel — the episode is separately
    // ACL-gated, so a reader entitled to the evidence is entitled to its
    // author. Withholding there would be the fact's grant overriding the
    // episode's, which is exactly the coupling `candidates.ts` refuses.
    const view = await renderPage([
      candidate({
        provenance: WITHHELD_ATTRIBUTION,
        episode: { visible: false, id: "ep-1" },
      }),
    ]);
    fireEvent.click(view.container.querySelectorAll("tbody tr")[0]!);
    await waitFor(() => expect(document.body.textContent).toContain("Fact candidate"));

    const text = document.body.textContent ?? "";
    expect(text).toContain("Attribution restricted");
    expect(text).not.toContain("C1/17");
    expect(text).not.toContain("U1");
  });

  test("keeps the non-attributing half of the provenance visible", async () => {
    // Withholding the triple must not blank the row: `source` is a connector
    // class and `producer` a pipeline stage, and a reviewer who lost them
    // could no longer say where the claim came from at all.
    const view = await renderPage([candidate({ provenance: WITHHELD_ATTRIBUTION })]);
    fireEvent.click(view.container.querySelectorAll("tbody tr")[0]!);
    await waitFor(() => expect(document.body.textContent).toContain("Fact candidate"));

    const text = document.body.textContent ?? "";
    expect(text).toContain("slack");
    expect(text).toContain("extraction:v1");
  });

  test("distinguishes restricted ATTRIBUTION from restricted EVIDENCE", async () => {
    // Two different withholdings off two different grants — the fact's
    // pre-widening grant and the episode's own — that on a widened fact will
    // usually fire together. They carry the same icon, so if the labels ever
    // collapsed into one a reviewer would lose the distinction entirely, and
    // the two have different remedies.
    const view = await renderPage([
      candidate({
        provenance: WITHHELD_ATTRIBUTION,
        episode: { visible: false, id: "ep-1" },
      }),
    ]);
    const text = view.container.textContent ?? "";
    expect(text).toContain("Attribution restricted");
    expect(text).toContain("Evidence restricted");
  });

  test("reports a drifted payload and a withheld attribution as separate facts", async () => {
    // `payloadComplete` is about the record at rest; attribution is about the
    // reader. Collapsing either into the other tells the reviewer something
    // false — that Atlas has a data-integrity problem, or that it does not.
    const view = await renderPage([
      candidate({ provenance: { ...WITHHELD_ATTRIBUTION, payloadComplete: false } }),
    ]);
    const text = view.container.textContent ?? "";
    expect(text).toContain("Attribution restricted");
    expect(text).toContain("Incomplete provenance");
  });

  test("leaves a disclosed candidate showing full attribution", async () => {
    // The negative. A fix that withheld across the board would satisfy every
    // assertion above.
    const view = await renderPage([candidate()]);
    fireEvent.click(view.container.querySelectorAll("tbody tr")[0]!);
    await waitFor(() => expect(document.body.textContent).toContain("Fact candidate"));

    const text = document.body.textContent ?? "";
    expect(text).not.toContain("Attribution restricted");
    expect(text).toContain("Asserted by");
    expect(text).toContain("C1/17");
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
            validTo: null,
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
    // No language that RANKS one side — that ban is permanent and outlives
    // M2. What is no longer banned is the word "superseded": #4935 made it a
    // lifecycle LABEL on a rival's own closed window, the exact peer of the
    // "Withdrawn" badge, and labelling what already happened to a claim is not
    // pre-empting arbitration. The label must still stay off a LIVE rival,
    // which this fixture is — so both lifecycle badges are asserted absent
    // here, and each is asserted PRESENT on its own fixture below.
    expect(text).not.toMatch(/preferred|winner|more reliable/i);
    expect(text).not.toContain("Superseded");
    expect(text).not.toContain("Withdrawn");
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
            validTo: null,
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
    // The axes are distinct verbs and must not share a badge.
    expect(document.body.textContent).not.toContain("Superseded");
    // The strike-through, which predates #4935 but whose condition #4935
    // widened to `withdrawn || superseded`. Unasserted, the retraction arm can
    // be dropped while the supersession fixture keeps every test green.
    expect(document.querySelector(".line-through")?.textContent).toContain("MySQL");
  });

  test("labels a SUPERSEDED rival, which its status alone cannot show either (#4935)", async () => {
    // Reached with no human action on the counterpart at all: the publish gate
    // stamps `validTo` on the claim it retires, leaves that row's `status`
    // alone, and nothing deletes the `in-tension-with` edge — so this
    // counterpart otherwise renders exactly like a live rival ("Published", no
    // tombstone) and the reviewer is shown a conflict they themselves already
    // arbitrated as still open.
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
            validTo: ISO,
            ingestedAt: ISO,
            invalidatedAt: null,
            corroborationCount: 1,
            provenance: PROVENANCE,
          },
        ],
      }),
    ]);
    fireEvent.click(view.container.querySelectorAll("tbody tr")[0]!);
    await waitFor(() => expect(document.body.textContent).toContain("Conflicting claims"));

    const text = document.body.textContent ?? "";
    expect(text).toContain("Superseded");
    expect(text).not.toContain("Withdrawn");
    // The claim is struck through, the treatment retraction already had. The
    // badge carries WHICH verb; the strike carries "not the current claim" —
    // and it is the half no text assertion can see.
    expect(document.querySelector(".line-through")?.textContent).toContain("MySQL");
    // Labelled, not ranked: the surviving candidate gains no "preferred"
    // marker and the cluster still names no winner.
    expect(text).not.toMatch(/preferred|winner|more reliable/i);
    expect(text).toContain("is not choosing between them");
  });

  test("does NOT call a rival superseded while its window is still open (#4935)", async () => {
    // The inverse failure, and the one a `validTo !== null` label walks
    // straight into. `brainFactCurrentClause` is `valid_to IS NULL OR valid_to
    // > now()`, so a FUTURE-dated stamp — a region import can carry one — is a
    // fact the search surface still serves as current. Badging it settled
    // would hide an open conflict from the reviewer, which is worse than the
    // bug this issue fixes: an unlabelled live rival is merely unhelpful, a
    // mislabelled one is a lie the reviewer acts on.
    const future = new Date(Date.now() + 86_400_000).toISOString();
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
            validTo: future,
            ingestedAt: ISO,
            invalidatedAt: null,
            corroborationCount: 1,
            provenance: PROVENANCE,
          },
        ],
      }),
    ]);
    fireEvent.click(view.container.querySelectorAll("tbody tr")[0]!);
    await waitFor(() => expect(document.body.textContent).toContain("Conflicting claims"));
    expect(document.body.textContent).not.toContain("Superseded");
    expect(document.body.textContent).not.toContain("Withdrawn");
    // Not struck through either — a live rival must read as a live rival on
    // every channel this card uses, not just the badge row.
    expect(document.querySelector(".line-through")).toBeNull();
  });

  test("labels a rival retired on BOTH axes with both badges (#4935)", async () => {
    // Reachable, and asserted because the badges are independent `&&` arms
    // that an `else if` refactor would silently collapse: `supersede` refuses
    // a target whose window is already closed, but `retract` does not refuse a
    // superseded one, so supersede-then-retract reaches this state. Every
    // other fixture in this file pins exactly-one badge, which is precisely
    // the shape that lets a dropped label pass.
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
            validTo: ISO,
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

    const text = document.body.textContent ?? "";
    expect(text).toContain("Withdrawn");
    expect(text).toContain("Superseded");
    // Two labels are still not a ranking.
    expect(text).not.toMatch(/preferred|winner|more reliable/i);
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

describe("hidden-backlog disclosure (#4825)", () => {
  test("stays silent when this reader can review the whole workspace", async () => {
    // The baseline, and it has to be asserted: a panel that always claimed
    // something was hidden would "pass" every test below while telling every
    // admin in every workspace something untrue.
    const view = await renderPage([candidate()]);
    // Wait for a marker the panel ALWAYS renders once its query resolves.
    // `renderPage` only waits on the list query, so a bare negative here could
    // not tell "loaded and correctly silent" from "not mounted yet" — and would
    // pass with <OversightPanel /> deleted from the page outright.
    await waitFor(() =>
      expect(view.container.textContent ?? "").toContain("Workspace breakdown"),
    );
    expect(view.container.textContent ?? "").not.toContain("not in your queue");
  });

  test("states the delta when the workspace holds drafts this reader cannot see", async () => {
    // The 26 / 32 soak reading, at the surface an admin actually looks at.
    oversight = {
      buckets: [
        {
          key: "org",
          kind: "org",
          label: "org",
          labelPolicy: "intrinsic",
          awaitingReview: 26,
          published: 40,
          retracted: 0,
          provisional: 0,
          inTension: 0,
        },
      ],
      workspaceTotals: {
        awaitingReview: 32,
        published: 40,
        retracted: 0,
        provisional: 0,
        inTension: 0,
      },
      reviewableAwaitingReview: 26,
      countsConsistent: true,
      distinctAudiences: 1,
      bucketsTruncated: false,
    };
    const view = await renderPage([candidate()]);
    await waitFor(() =>
      expect(view.container.textContent ?? "").toContain(
        "6 drafts awaiting review are not in your queue",
      ),
    );
    // And it says publish reaches them anyway — the half that changes what the
    // admin does next. A number with no consequence attached is trivia.
    expect(view.container.textContent ?? "").toContain("workspace-wide");
  });

  test("renders a withheld audience as an opaque handle with its counts", async () => {
    // The well-behaved payload: the API sends no id at all, so the panel has
    // nothing to leak. This pins that it does not invent one from `key` or from
    // the kind, and that the COUNTS still get through — an oversight row that
    // withheld the number as well as the name would disclose nothing at all.
    oversight = {
      buckets: [
        {
          key: "discovered-1",
          kind: "audience",
          labelPolicy: "discovered",
          awaitingReview: 6,
          published: 0,
          retracted: 0,
          provisional: 0,
          inTension: 0,
        },
      ],
      workspaceTotals: {
        awaitingReview: 9,
        published: 0,
        retracted: 0,
        provisional: 0,
        inTension: 0,
      },
      reviewableAwaitingReview: 3,
      countsConsistent: true,
      distinctAudiences: 1,
      bucketsTruncated: false,
    };
    const view = await renderPage([candidate()]);
    await waitFor(() => expect(view.container.textContent ?? "").toContain("not in your queue"));
    clickButton(view, /Workspace breakdown/i);
    await waitFor(() => expect(view.container.textContent ?? "").toContain("discovered-1"));
    // The counts are there; the channel is not.
    expect(view.container.textContent ?? "").toContain("6");
    expect(view.container.textContent ?? "").not.toContain("chat-channel");
  });

  test("names a configured audience, and explains each withheld kind", async () => {
    // The nameable arm has no coverage otherwise — every other fixture is `org`
    // (which takes the "Everyone in the workspace" branch) or `discovered`. A
    // regression that opaque-handled EVERYTHING would pass every other test in
    // this file while making the breakdown useless, which is the same
    // "satisfied by a component that discloses nothing" failure the API-side
    // header warns about, one layer out.
    const bucket = (over: Record<string, unknown>) => ({
      awaitingReview: 1,
      published: 0,
      retracted: 0,
      provisional: 0,
      inTension: 0,
      ...over,
    });
    oversight = {
      buckets: [
        bucket({ key: "org", kind: "org", labelPolicy: "intrinsic", label: "org" }),
        bucket({
          key: "audience:chat-channel:slack:C0PRIVATE1",
          kind: "audience",
          labelPolicy: "configured",
          label: "audience:chat-channel:slack:C0PRIVATE1",
        }),
        bucket({ key: "discovered-1", kind: "user", labelPolicy: "discovered" }),
        bucket({ key: "discovered-2", kind: "malformed", labelPolicy: "discovered" }),
      ],
      workspaceTotals: {
        awaitingReview: 4,
        published: 0,
        retracted: 0,
        provisional: 0,
        inTension: 0,
      },
      reviewableAwaitingReview: 4,
      countsConsistent: true,
      distinctAudiences: 4,
      bucketsTruncated: false,
    };
    const view = await renderPage([candidate()]);
    await waitFor(() => expect(view.container.textContent ?? "").toContain("Workspace breakdown"));
    clickButton(view, /Workspace breakdown/i);
    // The channel the admin configured IS named — that is the whole point of
    // the configured/discovered split.
    await waitFor(() =>
      expect(view.container.textContent ?? "").toContain(
        "audience:chat-channel:slack:C0PRIVATE1",
      ),
    );
    // And the two withheld kinds render their handles, not their tokens.
    expect(view.container.textContent ?? "").toContain("discovered-1");
    expect(view.container.textContent ?? "").toContain("discovered-2");
    // THE non-vacuity guard. On the disclosable arms `key === label`, so the
    // assertions above are ALSO satisfied by a component that opaque-handled
    // everything — the exact regression this test claims to catch. The `org`
    // arm's prose has no such twin: it renders only when the branch genuinely
    // took the disclosable path.
    expect(view.container.textContent ?? "").toContain("Everyone in the workspace");
  });

  test("refuses to render a withheld bucket that smuggles its label", async () => {
    // The HOSTILE payload — a `discovered` bucket carrying the very id the
    // policy withheld, i.e. what a producer regressed to a flat
    // `label: string | null` would emit. The BUCKET schema stays strict on the
    // client (only the envelope is additive-tolerant) precisely so this fails
    // closed: the panel drops to its error state and the token never reaches
    // the DOM. An admin losing a breakdown is recoverable; a leaked private
    // channel name is not.
    oversight = {
      buckets: [
        {
          key: "discovered-1",
          kind: "audience",
          labelPolicy: "discovered",
          label: "audience:chat-channel:slack:C0SECRET99",
          awaitingReview: 6,
          published: 0,
          retracted: 0,
          provisional: 0,
          inTension: 0,
        },
      ],
      workspaceTotals: {
        awaitingReview: 9,
        published: 0,
        retracted: 0,
        provisional: 0,
        inTension: 0,
      },
      reviewableAwaitingReview: 3,
      countsConsistent: true,
      distinctAudiences: 1,
      bucketsTruncated: false,
    };
    const view = await renderPage([candidate()]);
    await waitFor(() =>
      expect(view.container.textContent ?? "").toContain(
        "can't tell you whether drafts exist outside your queue",
      ),
    );
    expect(view.container.textContent ?? "").not.toContain("C0SECRET99");
    expect(view.container.textContent ?? "").not.toContain("chat-channel");
  });

  test("tolerates an ADDITIVE envelope field rather than blanking the disclosure", async () => {
    // The other half of the strict/loose split. During an api/web deploy skew a
    // new envelope field must not take the hidden-backlog alert down with it —
    // failing closed for confidentiality there would mean failing OPEN for the
    // disclosure, which is the thing this whole surface exists to make.
    oversight = {
      buckets: [],
      workspaceTotals: {
        awaitingReview: 32,
        published: 0,
        retracted: 0,
        provisional: 0,
        inTension: 0,
      },
      reviewableAwaitingReview: 26,
      countsConsistent: true,
      distinctAudiences: 1,
      bucketsTruncated: false,
      someFutureField: "added by a newer API",
    };
    const view = await renderPage([candidate()]);
    await waitFor(() =>
      expect(view.container.textContent ?? "").toContain(
        "6 drafts awaiting review are not in your queue",
      ),
    );
  });

  test("says it cannot compute the delta rather than clamping it to a reassuring zero", async () => {
    // The producer refuses to clamp; the first cut of the panel undid that with
    // `Math.max(0, …)` and rendered a clean page out of a state that proves
    // nothing — #4825's defect reproduced by its own fix.
    oversight = {
      buckets: [],
      workspaceTotals: {
        awaitingReview: 5,
        published: 0,
        retracted: 0,
        provisional: 0,
        inTension: 0,
      },
      reviewableAwaitingReview: 9,
      countsConsistent: false,
      distinctAudiences: 0,
      bucketsTruncated: false,
    };
    const view = await renderPage([candidate()]);
    await waitFor(() =>
      expect(view.container.textContent ?? "").toContain("two counts of the same workspace"),
    );
    // And it must NOT quietly claim the all-clear.
    expect(view.container.textContent ?? "").not.toContain("not in your queue");
  });

  test("reports the true audience count when the breakdown is clipped", async () => {
    // `buckets.length` would read "1 audience" over a workspace with 250, with
    // the correction hidden behind a collapsed disclosure triangle.
    oversight = {
      buckets: [
        {
          key: "org",
          kind: "org",
          label: "org",
          labelPolicy: "intrinsic",
          awaitingReview: 1,
          published: 0,
          retracted: 0,
          provisional: 0,
          inTension: 0,
        },
      ],
      workspaceTotals: {
        awaitingReview: 1,
        published: 0,
        retracted: 0,
        provisional: 0,
        inTension: 0,
      },
      reviewableAwaitingReview: 1,
      countsConsistent: true,
      distinctAudiences: 250,
      bucketsTruncated: true,
    };
    const view = await renderPage([candidate()]);
    await waitFor(() => expect(view.container.textContent ?? "").toContain("250 audiences"));
    clickButton(view, /Workspace breakdown/i);
    await waitFor(() =>
      expect(view.container.textContent ?? "").toContain("more distinct audiences"),
    );
  });

  test("the publish modal states the withheld count BEFORE the confirm button", async () => {
    // The acceptance criterion in as many words: an admin must not learn the
    // blast radius from the response.
    withheldFacts = 6;
    const view = await renderPage([candidate()]);
    clickButton(view, /Review & publish/i);
    await waitFor(() =>
      expect(document.body.textContent).toContain("6 brain facts here aren't shown to you"),
    );
    // Folded into the button, so the number the admin confirms is the real one.
    // Exact, not `toContain("6")`: the button reads "Publish all (0)" without
    // the fold, and "0" would not match, but neither would a coincidental 6
    // somewhere else in the label.
    const confirm = Array.from(document.body.querySelectorAll("button")).find((b) =>
      /Publish all/.test(b.textContent ?? ""),
    );
    expect(confirm?.textContent?.trim()).toBe("Publish all (6)");
  });

  test("offers a retry that actually refetches, not an inert instruction", async () => {
    // The degraded arm is a 200, so the modal's error-path Retry never renders,
    // and "close and reopen this dialog" is inert inside TanStack's 30s
    // staleTime — it replays the identical degraded response during exactly the
    // window a transient fault would have cleared. So the button has to be real.
    withheldFacts = 4;
    scopeUnavailable = true;
    const view = await renderPage([candidate()]);
    clickButton(view, /Review & publish/i);
    await waitFor(() =>
      expect(document.body.textContent).toContain("couldn't work out which of these"),
    );

    const before = requested.filter((r) => r.url.includes("publish-preview")).length;
    const retry = Array.from(document.body.querySelectorAll("button")).find(
      (b) => /Try again/.test(b.textContent ?? ""),
    );
    expect(retry).toBeTruthy();
    fireEvent.click(retry!);
    await waitFor(() =>
      expect(requested.filter((r) => r.url.includes("publish-preview")).length).toBeGreaterThan(
        before,
      ),
    );
  });

  test("says an Atlas fault is an Atlas fault, not a channel-membership boundary", async () => {
    // Both causes withhold everything, and only one is about Slack. Printing the
    // audience explanation over an infrastructure fault tells an admin who can
    // read every fact in the workspace that none of them are theirs to see.
    withheldFacts = 4;
    scopeUnavailable = true;
    const view = await renderPage([candidate()]);
    clickButton(view, /Review & publish/i);
    await waitFor(() =>
      expect(document.body.textContent).toContain("couldn't work out which of these"),
    );
    expect(document.body.textContent).not.toContain("audience you're not part of");
  });
});

describe("will-supersede disclosure (#4912)", () => {
  test("stays silent when the next publish supersedes nothing — including on an older API", async () => {
    // The default oversight fixture carries NO `willSupersede` at all, which is
    // exactly what an older API sends during a deploy window. The panel must
    // render the pre-#4912 page, not crash the whole oversight surface.
    const view = await renderPage([candidate()]);
    await waitFor(() =>
      expect(view.container.textContent ?? "").toContain("Workspace breakdown"),
    );
    expect(view.container.textContent ?? "").not.toContain("supersede");
  });

  test("renders each replacement as a pair — new claim, old claim — before the publish", async () => {
    oversight = {
      ...oversight,
      willSupersede: {
        total: 2,
        pairs: [
          {
            draftId: "d1",
            draftLabel: "alice manager carol",
            supersededId: "o1",
            supersededLabel: "alice manager bob",
          },
        ],
        withheld: 1,
        truncated: false,
      },
    };
    const view = await renderPage([candidate()]);
    await waitFor(() =>
      expect(view.container.textContent ?? "").toContain(
        "Publishing will supersede 2 published facts",
      ),
    );
    const text = view.container.textContent ?? "";
    // Both halves of the pair — the disclosure IS the replacement, not a count.
    expect(text).toContain("alice manager carol");
    expect(text).toContain("alice manager bob");
    // The ACL-hidden remainder is a sentence with a number, never a row.
    expect(text).toContain("1 of these replacements involves facts");
    // And nothing claims deletion: the copy must say the history survives.
    expect(text).toContain("Nothing is deleted");
  });

  test("admits truncation without dressing it as an ACL boundary", async () => {
    oversight = {
      ...oversight,
      willSupersede: {
        total: 130,
        pairs: [
          {
            draftId: "d1",
            draftLabel: "alice manager carol",
            supersededId: "o1",
            supersededLabel: "alice manager bob",
          },
        ],
        withheld: 0,
        truncated: true,
      },
    };
    const view = await renderPage([candidate()]);
    await waitFor(() =>
      expect(view.container.textContent ?? "").toContain("did not fit in one response"),
    );
    // Nothing was ACL-withheld, so the audience sentence must NOT render —
    // truncation relabelled as an audience boundary would send the admin
    // hunting for private channels that do not exist.
    expect(view.container.textContent ?? "").not.toContain("audiences you are not part of");
  });

  test("the publish modal states the workspace-wide count before the confirm button", async () => {
    // The modal is the confirm surface; an admin who never visits the review
    // page must still learn a publish will retire published beliefs. The
    // withheld count is set too — a supersession implies a live single draft,
    // and for THIS reader the preview reports it as withheld.
    willSupersedeCount = 3;
    withheldFacts = 1;
    const view = await renderPage([candidate()]);
    clickButton(view, /Review & publish/i);
    await waitFor(() =>
      expect(document.body.textContent).toContain("Publishing will supersede 3 published facts"),
    );
    // Scope statement, not a scare: it points at the per-pair disclosure.
    expect(document.body.textContent).toContain("Brain facts");
  });
});

describe("staleness decay is surfaced, never alarming (#4914)", () => {
  test("flags a stale claim in the queue", async () => {
    const view = await renderPage([
      candidate({ decay: { level: "stale", ageDays: 400, lastObservedAt: ISO } }),
    ]);
    expect(view.container.textContent).toContain("Stale");
  });

  test("stays quiet for a fresh claim — fresh is the queue's default state", async () => {
    const view = await renderPage([candidate()]);
    expect(view.container.textContent).not.toContain("Stale");
    expect(view.container.textContent).not.toContain("Aging");
  });

  test("flags an aging claim too — the chip is not stale-only", async () => {
    const view = await renderPage([
      candidate({ decay: { level: "aging", ageDays: 60, lastObservedAt: ISO } }),
    ]);
    expect(view.container.textContent).toContain("Aging");
  });

  test("labels a fallback-anchored age honestly, and never as withheld", async () => {
    // ageDays without an observation = the anchor fell back to the claim's
    // validity start or ingest. This arm is distinguished from the withheld
    // arm only by `ageDays` nullity, so a reordered ternary would show a
    // fully-entitled reviewer "withheld with attribution" — a false ACL claim.
    const view = await renderPage([
      candidate({ decay: { level: "aging", ageDays: 50, lastObservedAt: null } }),
    ]);
    fireEvent.click(view.container.querySelectorAll("tbody tr")[0]!);
    await waitFor(() => expect(document.body.textContent).toContain("Staleness"));
    const text = document.body.textContent ?? "";
    expect(text).toContain("About 50 days old");
    expect(text).toContain("validity start");
    expect(text).not.toContain("withheld");
  });

  test("says when the claim was last observed in the detail sheet", async () => {
    const view = await renderPage([
      candidate({ decay: { level: "stale", ageDays: 400, lastObservedAt: ISO } }),
    ]);
    fireEvent.click(view.container.querySelectorAll("tbody tr")[0]!);
    await waitFor(() => expect(document.body.textContent).toContain("Staleness"));
    expect(document.body.textContent).toContain("Last observed");
  });

  test("explains a withheld age instead of rendering a blank", async () => {
    // A widened-in reader gets the coarse level only (#4836): a day-precision
    // age restates the withheld "when". The UI must say WHY the numbers are
    // missing — an em-dash would read as "no age exists".
    const view = await renderPage([
      candidate({
        provenance: WITHHELD_ATTRIBUTION,
        decay: { level: "stale", ageDays: null, lastObservedAt: null },
      }),
    ]);
    fireEvent.click(view.container.querySelectorAll("tbody tr")[0]!);
    await waitFor(() => expect(document.body.textContent).toContain("Staleness"));
    const text = document.body.textContent ?? "";
    expect(text).toContain("Stale");
    expect(text).toContain("Exact age withheld with attribution");
  });

  test("admits an unknown age rather than fabricating one", async () => {
    const view = await renderPage([
      candidate({ decay: { level: "unknown", ageDays: null, lastObservedAt: null } }),
    ]);
    fireEvent.click(view.container.querySelectorAll("tbody tr")[0]!);
    await waitFor(() => expect(document.body.textContent).toContain("Staleness"));
    expect(document.body.textContent).toContain("Age unknown");
  });
});
