import { test, expect, type Page, type Route } from "@playwright/test";

/**
 * Browser **integration** test for the Coverage Surface (#5215, ADR-0041).
 *
 * Named `.integration.` deliberately, per #2420: every API call here is stubbed
 * via `page.route`, so what is exercised is the rendered UI against a
 * deterministic in-test fixture. That is UI integration, not e2e — a real
 * workspace's snapshots are the milestone's prod-verification job (#5216), and
 * this file must not be mistaken for it.
 *
 * ## What it covers, and why in a browser rather than in jsdom
 *
 * The component suite (`packages/web/src/app/admin/brain/__tests__/`) already
 * asserts the sentences. What only a real page can falsify is that the three
 * states and the degraded arms survive the WHOLE surface — the wire schema the
 * browser re-parses, the `AdminContentWrapper` between the fetch and the tiles,
 * and the layout that could hide a mark below a fold or collapse two verdicts
 * into one chip. Concretely:
 *
 *   - **The three states render, distinctly**: a surveyed ratio with its
 *     credential-relative caption and its date, an enumerated-but-unsurveyed
 *     count, and the unenumerable as a MARK carrying no number.
 *   - **The degraded arm renders as an arm, never a zero**: `cannot-establish`,
 *     `never-enumerated`, and the `countsConsistent: false` caveat all reach the
 *     screen, and none of them prints a count.
 *
 * The `@llm` tag is deliberately absent — no model call happens here, and CI
 * tier selection routes on that tag.
 */

/** The chat class, carrying all three ADR-0041 states at once. */
function chatArm(overrides: Record<string, unknown> = {}) {
  return {
    state: "enumerated",
    asOf: "2026-08-19T02:00:00.000Z",
    ratio: {
      // State 1 (surveyed) and state 2 (enumerated) share one unit, so they make
      // a ratio. Nothing on this page ever adds them to another class's.
      surveyed: 3,
      enumerated: 4,
      enumerable: 7,
      inPerimeterWithoutEvidence: 1,
      unit: "chat-channel-roster",
    },
    freshness: { current: 1, stale: 1, unverified: 1 },
    units: [
      {
        state: "surveyed",
        unitId: "C0001",
        label: "#general",
        clause: "vendor-public",
        newestEvidenceAt: "2026-08-18T09:00:00.000Z",
        freshness: { kind: "current", checkedAt: "2026-08-19T01:00:00.000Z" },
      },
      {
        state: "surveyed",
        unitId: "C0002",
        label: "#launch",
        clause: "vendor-public",
        newestEvidenceAt: "2026-07-02T09:00:00.000Z",
        freshness: {
          kind: "stale",
          vendorActivityAt: "2026-08-17T12:00:00.000Z",
          newestEvidenceAt: "2026-07-02T09:00:00.000Z",
          lagMs: 4_071_600_000,
          cadenceMs: 3_600_000,
        },
      },
      {
        state: "surveyed",
        unitId: "C0003",
        label: "#archive",
        clause: "deliberate-act",
        newestEvidenceAt: "2026-05-01T09:00:00.000Z",
        freshness: {
          kind: "unverified-since",
          since: "2026-08-12T02:00:00.000Z",
          reason: "not-probed",
        },
      },
      {
        state: "enumerated",
        unitId: "C0004",
        label: "#incidents",
        clause: "vendor-public",
        inPerimeter: false,
      },
    ],
    unitsWithheld: 3,
    unitsTruncated: false,
    // State 3 — the map edge. A mark, and the fixture asserts it stays one.
    mapEdges: ["chat-public-roster-truncated"],
    unavailable: null,
    ...overrides,
  };
}

function buildCoverage(overrides: Record<string, unknown> = {}) {
  const availability = overrides.availability as Record<string, unknown> | undefined;
  const envelope = { ...overrides };
  delete envelope.availability;
  return {
    availability: {
      chat: chatArm(),
      transcript: {
        state: "never-enumerated",
        reason: "no-cycle-recorded",
        lastAttemptAt: null,
        unavailableReason: null,
      },
      email: {
        state: "never-enumerated",
        reason: "no-successful-cycle",
        lastAttemptAt: "2026-08-19T02:00:00.000Z",
        unavailableReason: "Microsoft Graph refused the mailbox listing.",
      },
      // The "cannot establish" arm — a bug, and one an admin must be able to
      // tell apart from a class that simply has nothing in it.
      warehouse: { state: "cannot-establish", reason: "unresolvable-class" },
      human: { state: "not-surveyable", reason: "non-surveyable-class" },
      ...availability,
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
      reviewableAwaitingReview: 4,
      countsConsistent: true,
      distinctAudiences: 0,
      bucketsTruncated: false,
    },
    countsConsistent: true,
    ...envelope,
  };
}

async function installMocks(page: Page, coverage: unknown): Promise<void> {
  await page.route(/\/api\/v1\/admin\/brain-coverage(?:\?|\/?$)/, async (route: Route) => {
    if (route.request().method() !== "GET") {
      await route.abort("failed");
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(coverage),
    });
  });

  // The Slack ingest card fetches independently. Stubbed healthy so its own
  // error arm cannot be mistaken for one of the coverage arms under test.
  await page.route(/\/api\/v1\/admin\/brain-slack\/channels(?:\?|$)/, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        scopeMode: "membership",
        inScopeCount: 0,
        sync: null,
        channels: [],
      }),
    });
  });
}

test.describe("Coverage Surface — the three states (#5215)", () => {
  test("renders surveyed, enumerated and unenumerable as three different things", async ({
    page,
  }) => {
    await installMocks(page, buildCoverage());
    await page.goto("/admin/brain");

    const chat = page.getByTestId("coverage-class-chat");
    await expect(chat).toBeVisible();

    // State 1 + 2 — the ratio, and the two things that make it a true statement.
    await expect(chat.getByTestId("coverage-ratio")).toHaveText("3 of 7 chat channels");
    await expect(chat.getByTestId("coverage-denominator-caption")).toContainText(
      "of the channels Atlas's chat credentials can see",
    );
    await expect(chat.getByTestId("coverage-denominator-caption")).toContainText("as of");
    await expect(chat).toContainText("4 are visible to Atlas and unsurveyed");

    // State 3 — a MARK. Asserted digit-free rather than merely
    // percentage-free: a count of what is beyond the edge is the same
    // fabrication in a different notation.
    const marks = chat.getByTestId("coverage-map-edges");
    await expect(marks).toBeVisible();
    await expect(marks).toContainText("beyond the ones counted here");
    expect(await marks.innerText()).not.toMatch(/\d/);

    // Withheld units are a count and never a list — naming a mailbox is naming
    // a person, and the same clause governs private channels.
    await expect(chat.getByTestId("coverage-withheld")).toContainText("3 further chat channels");
  });

  test("the three freshness verdicts stay three renderings, not one badge", async ({ page }) => {
    await installMocks(page, buildCoverage());
    await page.goto("/admin/brain");

    const chat = page.getByTestId("coverage-class-chat");
    // Stale carries its own arithmetic, so a reader can check the verdict.
    await expect(chat.getByTestId("coverage-freshness-stale")).toContainText("the source moved on");
    // Unverified carries a real date and its reason, and is never called stale.
    await expect(chat.getByTestId("coverage-freshness-unverified")).toContainText(
      "unverified since",
    );
    // Current says WHEN the source was asked — a present-tense verdict resting
    // on a reading of unbounded age would be the flattering arm being opaque.
    await expect(chat.getByTestId("coverage-freshness-current")).toContainText(
      "the source was asked on",
    );
  });

  test("states no percentage anywhere on the page", async ({ page }) => {
    // ADR-0041's citable refusal, as an assertion. The single number will be
    // proposed as a ring, a score, or "an approximate blend"; each arrives on
    // screen as a `%`.
    await installMocks(page, buildCoverage());
    await page.goto("/admin/brain");
    const surface = page.getByTestId("coverage-surface");
    await expect(surface).toBeVisible();

    expect(await surface.innerText()).not.toContain("%");
  });
});

test.describe("Coverage Surface — the degraded arms (#5215)", () => {
  test("cannot-establish and never-enumerated render as arms, never as zeros", async ({
    page,
  }) => {
    await installMocks(page, buildCoverage());
    await page.goto("/admin/brain");

    const warehouse = page.getByTestId("coverage-class-warehouse");
    await expect(warehouse).toContainText("cannot establish anything about");
    // A zero here would read as a measured empty roster rather than a class this
    // deployment cannot account for.
    expect(await warehouse.innerText()).not.toMatch(/\d/);
    await expect(warehouse.locator('[role="alert"]')).toHaveCount(1);

    const transcript = page.getByTestId("coverage-class-transcript");
    await expect(transcript).toContainText("Never enumerated");
    expect(await transcript.innerText()).not.toMatch(/\d/);

    // Tried and never once succeeded — a different sentence, carrying the
    // enumerator's own admin-facing reason.
    await expect(page.getByTestId("coverage-class-email")).toContainText(
      "Microsoft Graph refused the mailbox listing.",
    );
  });

  test("a degraded response is a caveat ON the statement, not a blank page", async ({ page }) => {
    await installMocks(page, buildCoverage({ countsConsistent: false }));
    await page.goto("/admin/brain");

    const caveat = page.getByTestId("coverage-caveat");
    await expect(caveat).toBeVisible();
    await expect(caveat).toHaveAttribute("role", "alert");
    // Every part is still the best statement Atlas can make, so the arms are
    // still beneath it.
    await expect(page.getByTestId("coverage-statement-availability")).toContainText(
      "Atlas surveys",
    );
    await expect(page.getByTestId("coverage-class-chat")).toBeVisible();
  });

  test("an enumeration that has since failed captions the counts instead of clearing them", async ({
    page,
  }) => {
    await installMocks(
      page,
      buildCoverage({
        availability: {
          chat: chatArm({
            unavailable: {
              since: "2026-08-19T02:00:00.000Z",
              reason: "Slack returned 429 for the channel listing.",
            },
          }),
        },
      }),
    );
    await page.goto("/admin/brain");

    const chat = page.getByTestId("coverage-class-chat");
    // The dated counts survive — they are the last ones that succeeded, and
    // they are not wrong, only older than they look.
    await expect(chat.getByTestId("coverage-ratio")).toHaveText("3 of 7 chat channels");
    await expect(chat.getByTestId("coverage-unavailable")).toContainText(
      "Enumeration unavailable since",
    );
    await expect(chat.getByTestId("coverage-unavailable")).toContainText(
      "Slack returned 429 for the channel listing.",
    );
  });
});
