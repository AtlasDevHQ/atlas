/**
 * Tests for the Salesforce Knowledge vendor client (#4397) — driven entirely
 * through an injected fixture {@link SalesforceKnowledgeApi}; NO test touches
 * a live org. Covers describe-driven body-field discovery, the EXPLICIT
 * PublishStatus filters (the unfiltered-query Draft+Archived leak guard), queryMore
 * paging + the anti-runaway page bound, the indexed SystemModstamp
 * incremental walk (non-Online / out-of-channel rows advance the mark but
 * emit nothing), channel visibility, malformed-row coverage flagging, and
 * REQUEST_LIMIT_EXCEEDED → ConnectorRateLimitError governor mapping.
 */

import { describe, expect, it } from "bun:test";
import {
  createSalesforceKnowledgeVendorClient,
  type SalesforceKnowledgeApi,
} from "@atlas/api/lib/knowledge/salesforce/client";
import { ConnectorRateLimitError } from "@atlas/api/lib/knowledge/connectors";
import { IntegrationReconnectRequiredError } from "@atlas/api/lib/effect/errors";
import type { SalesforceKnowledgeChannel } from "@atlas/api/lib/knowledge/salesforce/config";

const INSTANCE_URL = "https://acme.my.salesforce.com";

function field(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, type: "string", custom: false, extraTypeInfo: null, ...overrides };
}

/** A realistic Knowledge__kav describe: standard fields + two custom bodies. */
const DEFAULT_FIELDS: Record<string, unknown>[] = [
  field("Id", { type: "id" }),
  field("KnowledgeArticleId", { type: "reference" }),
  field("ArticleNumber"),
  field("Title"),
  field("Language", { type: "picklist" }),
  field("PublishStatus", { type: "picklist" }),
  field("SystemModstamp", { type: "datetime" }),
  field("Summary", { type: "textarea" }), // standard textarea — NOT a body field
  field("UrlName"),
  field("VersionNumber", { type: "int" }),
  field("IsMasterLanguage", { type: "boolean" }),
  field("IsVisibleInApp", { type: "boolean" }),
  field("IsVisibleInPkb", { type: "boolean" }),
  field("IsVisibleInCsp", { type: "boolean" }),
  field("IsVisibleInPrm", { type: "boolean" }),
  field("Body__c", { type: "textarea", custom: true, extraTypeInfo: "richtextarea" }),
  field("Details__c", { type: "textarea", custom: true, extraTypeInfo: "plaintextarea" }),
];

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Id: "ka0x001",
    KnowledgeArticleId: "kA0x001",
    ArticleNumber: "000001001",
    Title: "Getting Started",
    Language: "en_US",
    PublishStatus: "Online",
    // Salesforce's native offset format — normalization must canonicalize it.
    SystemModstamp: "2026-07-01T10:00:00.000+0000",
    Summary: "How to get started.",
    VersionNumber: 3,
    IsMasterLanguage: true,
    IsVisibleInPkb: true,
    Body__c: "<p>Welcome to the product. Follow the setup guide to begin.</p>",
    ...overrides,
  };
}

interface FixturePage {
  records: Record<string, unknown>[];
  done?: boolean;
  nextRecordsUrl?: string | null;
}

interface FixtureState {
  soql: string[];
  describeCalls: string[];
  queryMoreCalls: string[];
}

function makeApi(opts: {
  fields?: Record<string, unknown>[];
  /** Batches: queryPage serves [0]; each queryMorePage serves the next. */
  pages?: FixturePage[];
  describeError?: unknown;
  queryError?: unknown;
  queryMoreError?: unknown;
}): { api: SalesforceKnowledgeApi; state: FixtureState } {
  const state: FixtureState = { soql: [], describeCalls: [], queryMoreCalls: [] };
  const pages = opts.pages ?? [{ records: [row()], done: true, nextRecordsUrl: null }];
  let served = 0;
  const pageAt = (i: number) => {
    const page = pages[Math.min(i, pages.length - 1)];
    return {
      records: page.records,
      done: page.done !== false,
      nextRecordsUrl: page.nextRecordsUrl ?? null,
    };
  };
  const api: SalesforceKnowledgeApi = {
    async describeObject(objectName) {
      state.describeCalls.push(objectName);
      if (opts.describeError !== undefined) throw opts.describeError;
      return { fields: opts.fields ?? DEFAULT_FIELDS };
    },
    async queryPage(soql) {
      state.soql.push(soql);
      if (opts.queryError !== undefined) throw opts.queryError;
      served = 1;
      return pageAt(0);
    },
    async queryMorePage(nextRecordsUrl) {
      state.queryMoreCalls.push(nextRecordsUrl);
      if (opts.queryMoreError !== undefined) throw opts.queryMoreError;
      return pageAt(served++);
    },
  };
  return { api, state };
}

function client(
  opts: Parameters<typeof makeApi>[0] = {},
  config: { channel?: SalesforceKnowledgeChannel | null; articleObject?: string } = {},
) {
  const { api, state } = makeApi(opts);
  const c = createSalesforceKnowledgeVendorClient(api, {
    collectionSlug: "sf-kb",
    articleObject: config.articleObject ?? "Knowledge__kav",
    channel: config.channel ?? null,
    instanceUrl: INSTANCE_URL,
  });
  return { c, state };
}

describe("fetchAll (reconciliation)", () => {
  it("emits one document per Online version row with the max SystemModstamp as the mark", async () => {
    const { c, state } = client({
      pages: [
        {
          records: [
            row(),
            row({
              Id: "ka0x002",
              ArticleNumber: "000001002",
              Title: "Billing FAQ",
              SystemModstamp: "2026-07-05T08:00:00.000+0000",
              Body__c: "<p>Billing answers for common questions live here.</p>",
            }),
          ],
        },
      ],
    });
    const changes = await c.fetchAll();
    expect(changes.documents.map((d) => d.path)).toEqual([
      "sf-kb/en-us/getting-started-000001001.md",
      "sf-kb/en-us/billing-faq-000001002.md",
    ]);
    expect(changes.highWaterMark).toBe("2026-07-05T08:00:00.000Z");
    expect(changes.coverageIncomplete).toBe(false);
    expect(changes.cursor).toBeNull();
    // Explicit published-only filter — the unfiltered-query Draft+Archived leak guard.
    expect(state.soql[0]).toContain("PublishStatus = 'Online'");
    expect(state.soql[0]).toContain("FROM Knowledge__kav");
    // Discovered custom body fields are selected; no channel clause configured.
    expect(state.soql[0]).toContain("Body__c");
    expect(state.soql[0]).toContain("Details__c");
    expect(state.soql[0]).not.toContain("IsVisibleInPkb = true");
  });

  it("adds the channel visibility clause when a channel is configured", async () => {
    const { c, state } = client({}, { channel: "pkb" });
    await c.fetchAll();
    expect(state.soql[0]).toContain("PublishStatus = 'Online' AND IsVisibleInPkb = true");
  });

  it("walks queryMore batches to exhaustion", async () => {
    const { c, state } = client({
      pages: [
        {
          records: [row()],
          done: false,
          nextRecordsUrl: "/services/data/v60.0/query/01gxx-2000",
        },
        {
          records: [row({ Id: "ka0x002", ArticleNumber: "000001002", Title: "Second" })],
          done: true,
        },
      ],
    });
    const changes = await c.fetchAll();
    expect(changes.documents).toHaveLength(2);
    expect(state.queryMoreCalls).toEqual(["/services/data/v60.0/query/01gxx-2000"]);
  });

  it("fails loud on a locator that never terminates (page bound)", async () => {
    const { c } = client({
      pages: [{ records: [], done: false, nextRecordsUrl: "/services/data/v60.0/query/stuck" }],
    });
    await expect(c.fetchAll()).rejects.toThrow(/did not terminate/i);
  });

  it("counts a malformed row and flags coverage incomplete", async () => {
    const { c } = client({
      pages: [
        {
          records: [
            row(),
            row({ Id: "ka0x002", ArticleNumber: null }), // malformed — no number
          ],
        },
      ],
    });
    const changes = await c.fetchAll();
    expect(changes.documents).toHaveLength(1);
    expect(changes.coverageIncomplete).toBe(true);
  });

  it("a malformed row can NEVER advance the high-water mark past itself", async () => {
    // Load-bearing ordering: if the malformed row's (newer) SystemModstamp
    // advanced the mark, the fixed row would never be refetched incrementally.
    const { c } = client({
      pages: [
        {
          records: [
            row(),
            row({
              Id: "ka0x002",
              ArticleNumber: null, // malformed — but carries the newest stamp
              SystemModstamp: "2026-07-08T12:00:00.000+0000",
            }),
          ],
        },
      ],
    });
    const changes = await c.fetchAll();
    expect(changes.highWaterMark).toBe("2026-07-01T10:00:00.000Z");
    expect(changes.coverageIncomplete).toBe(true);
  });

  it("describes the article object once per client across both cadences (shape cache)", async () => {
    const { c, state } = client();
    await c.fetchAll();
    await c.fetchChanges({ since: "2026-07-06T00:00:00.000Z", cursor: null });
    expect(state.describeCalls).toEqual(["Knowledge__kav"]);
  });

  it("selects at most the body-field cap, warning-counted rather than silent", async () => {
    const manyBodies = Array.from({ length: 25 }, (_, i) =>
      field(`Body${i}__c`, { type: "textarea", custom: true, extraTypeInfo: "richtextarea" }),
    );
    const { c, state } = client({ fields: [...DEFAULT_FIELDS, ...manyBodies] });
    await c.fetchAll();
    // DEFAULT_FIELDS already carries 2 custom bodies → 18 more fit the cap of 20.
    expect(state.soql[0]).toContain("Body17__c");
    expect(state.soql[0]).not.toContain("Body18__c");
  });

  it("converts rich bodies via the shared converter and passes plain bodies through", async () => {
    const { c } = client({
      pages: [
        {
          records: [
            row({
              Body__c: "<p>Rich <strong>body</strong> paragraph with enough prose.</p>",
              Details__c: "Plain details paragraph.\n\nWith a second block of text.",
            }),
          ],
        },
      ],
    });
    const changes = await c.fetchAll();
    const content = changes.documents[0].content;
    expect(content).toContain("Rich **body** paragraph");
    expect(content).toContain("Plain details paragraph.");
    expect(content).toContain("With a second block of text.");
  });

  it("never selects a describe field whose name fails the SOQL identifier pattern", async () => {
    const { c, state } = client({
      fields: [
        ...DEFAULT_FIELDS,
        field("Weird Name__c", { type: "textarea", custom: true, extraTypeInfo: "richtextarea" }),
      ],
    });
    await c.fetchAll();
    expect(state.soql[0]).not.toContain("Weird Name__c");
  });
});

describe("fetchChanges (incremental)", () => {
  it("walks SystemModstamp with the explicit three-status filter (seconds precision)", async () => {
    const { c, state } = client();
    const changes = await c.fetchChanges({ since: "2026-07-06T00:00:00.000Z", cursor: null });
    expect(changes.documents).toHaveLength(1);
    // Unquoted SOQL datetime literal, milliseconds stripped.
    expect(state.soql[0]).toContain("SystemModstamp > 2026-07-06T00:00:00Z");
    expect(state.soql[0]).toContain("PublishStatus IN ('Online', 'Draft', 'Archived')");
    expect(state.soql[0]).not.toContain("PublishStatus = 'Online'");
  });

  it("advances the mark for a version that flipped to Archived but emits nothing", async () => {
    const { c } = client({
      pages: [
        {
          records: [
            row({ PublishStatus: "Archived", SystemModstamp: "2026-07-07T09:00:00.000+0000" }),
          ],
        },
      ],
    });
    const changes = await c.fetchChanges({ since: "2026-07-06T00:00:00.000Z", cursor: null });
    expect(changes.documents).toHaveLength(0);
    expect(changes.highWaterMark).toBe("2026-07-07T09:00:00.000Z");
  });

  it("skips an out-of-channel row per config but still advances the mark", async () => {
    const { c } = client(
      { pages: [{ records: [row({ IsVisibleInPkb: false })] }] },
      { channel: "pkb" },
    );
    const changes = await c.fetchChanges({ since: "2026-07-06T00:00:00.000Z", cursor: null });
    expect(changes.documents).toHaveLength(0);
    expect(changes.highWaterMark).toBe("2026-07-01T10:00:00.000Z");
  });

  it("serves a null since as a full crawl (defensive)", async () => {
    const { c, state } = client();
    const changes = await c.fetchChanges({ since: null, cursor: null });
    expect(changes.documents).toHaveLength(1);
    expect(state.soql[0]).toContain("PublishStatus = 'Online'");
    expect(state.soql[0]).not.toContain("SystemModstamp >");
  });

  it("fails loud on an unparseable since instant", async () => {
    const { c } = client();
    await expect(c.fetchChanges({ since: "not-a-date", cursor: null })).rejects.toThrow(
      /unparseable since instant/i,
    );
  });

  it("returns an empty quiet cycle when nothing changed", async () => {
    const { c } = client({ pages: [{ records: [], done: true }] });
    const changes = await c.fetchChanges({ since: "2026-07-06T00:00:00.000Z", cursor: null });
    expect(changes.documents).toHaveLength(0);
    expect(changes.highWaterMark).toBeNull();
  });
});

describe("describe-driven shape resolution", () => {
  it("fails actionably when the object lacks the article-version fields", async () => {
    const { c } = client({ fields: [field("Id"), field("Name")] });
    await expect(c.fetchAll()).rejects.toThrow(/missing required article-version fields/i);
  });

  it("fails actionably when the configured channel's visibility field is absent", async () => {
    const { c } = client(
      { fields: DEFAULT_FIELDS.filter((f) => f.name !== "IsVisibleInPrm") },
      { channel: "prm" },
    );
    await expect(c.fetchAll()).rejects.toThrow(/has no IsVisibleInPrm field/i);
  });

  it("wraps a describe failure with actionable Knowledge-enablement context", async () => {
    const { c } = client({ describeError: new Error("INVALID_TYPE: sObject type not supported") });
    await expect(c.fetchAll()).rejects.toThrow(/could not describe Knowledge__kav/i);
  });

  it("tolerates an org without the optional standard fields", async () => {
    const { c, state } = client({
      fields: DEFAULT_FIELDS.filter(
        (f) => !["Summary", "UrlName", "VersionNumber", "IsMasterLanguage"].includes(String(f.name)),
      ),
    });
    const changes = await c.fetchAll();
    expect(changes.documents).toHaveLength(1);
    expect(state.soql[0]).not.toContain("Summary");
  });
});

describe("governor-limit mapping", () => {
  it("maps a REQUEST_LIMIT_EXCEEDED message to ConnectorRateLimitError", async () => {
    const { c } = client({
      queryError: new Error("REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded."),
    });
    const err = await c.fetchAll().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConnectorRateLimitError);
  });

  it("maps a jsforce errorCode REQUEST_LIMIT_EXCEEDED to ConnectorRateLimitError", async () => {
    const limitError = Object.assign(new Error("TotalRequests Limit exceeded."), {
      errorCode: "REQUEST_LIMIT_EXCEEDED",
    });
    const { c } = client({ queryMoreError: limitError, pages: [
      { records: [row()], done: false, nextRecordsUrl: "/services/data/v60.0/query/01gxx-2000" },
    ] });
    const err = await c.fetchAll().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConnectorRateLimitError);
  });

  it("wraps other query failures with actionable context (original as cause)", async () => {
    const { c } = client({ queryError: new Error("MALFORMED_QUERY: unexpected token") });
    await expect(c.fetchAll()).rejects.toThrow(/Salesforce Knowledge query .* failed/i);
  });

  it("passes a mid-crawl reconnect-required error through UNWRAPPED (its message is the actionable one)", async () => {
    const reconnect = new IntegrationReconnectRequiredError({
      message: "Salesforce install needs to be reconnected.",
      workspaceId: "org-1",
      platform: "salesforce",
      upstreamError: "invalid_grant",
    });
    const { c } = client({ queryError: reconnect });
    const err = await c.fetchAll().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBe(reconnect);
  });
});
