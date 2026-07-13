import { test, expect, type Locator, type Page } from "@playwright/test";
import { Client } from "pg";

/**
 * Learned-Patterns Elevation — cockpit browser drive (#4584, the milestone gate
 * for #4570).
 *
 * Drives the elevated `/admin/learned-patterns` cockpit against DB-seeded
 * `query_pattern` rows, so each leg is deterministic and carries no LLM cost
 * (proposal capture is exercised by the agent loop elsewhere; here the pattern
 * is seeded directly and only the review/curation surface is driven). The full
 * loop, in order of the issue's acceptance criteria:
 *   nav entry announces the queue → sort by confidence → filter by a confidence
 *   range → open a pattern's sheet KEYBOARD-ONLY → approve a low-confidence
 *   pattern and watch it become injectable (approval is an eligibility bypass,
 *   not a confidence write) → force a failed review and see the error surface
 *   INSIDE the sheet (#4574) → verify per-pattern injection counts render
 *   (#4573) → flip the workspace auto-promotion knob (#4582) and observe a
 *   promotion.
 *
 * "Observe a promotion" is decomposed honestly, mirroring how the sibling
 * semantic-improve gate split its stale-confirm seam into a UI half and a
 * server-contract half. The auto-promote/decay pass is a background fiber
 * (`runPromoteDecayTick`, lib/learn/promote-decay-scheduler.ts) with NO HTTP
 * trigger — its pure decision and I/O are pinned by `promote-decay.test.ts` and
 * the scheduler test. What a browser CAN observe deterministically is the two
 * halves this gate asserts: (a) the workspace opt-in knob flips in the UI and
 * PERSISTS (server truth), and (b) an auto-promoted row surfaces in the cockpit
 * with the distinct violet "Auto-approved" badge (#3636) — a machine promotion
 * never masquerading as a human "Approved".
 *
 * Rows are seeded straight into `learned_patterns` (`type = 'query_pattern'`) —
 * the shape the proposer upserts — via the internal Postgres, mirroring the
 * `multi-env` / semantic-improve specs' `pg.Client` pattern. Injection
 * attribution is seeded into `learned_pattern_injections` (#4573, migration
 * 0173). Auth is ambient (the chromium project's stored admin session). Each
 * test clears the org's pattern set and seeds exactly the rows it needs, so
 * "the row" is unambiguous, and asserts against server truth (a reloaded page /
 * a DB poll) rather than optimistic client state.
 */

const INTERNAL_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://atlas:atlas@localhost:5432/atlas";
const ADMIN_EMAIL = process.env.ATLAS_ADMIN_EMAIL ?? "admin@useatlas.dev";

// Run-unique marker so a seeded row's description is unambiguous in the table
// and a stale row from a crashed prior run can never shadow this run's assertions.
const RUN = Date.now().toString(36);
const MARKER = `E2E-LP-${RUN}`;
const PROMOTE_DECAY_KEY = "ATLAS_LEARN_PROMOTE_DECAY_ENABLED";

// Above REPEATED_PATTERN_MIN_REPETITIONS (2) so seeded pending rows clear the
// seen-once (#4581) hide and count toward the nav-badge queue / default view.
const SEEN = 3;

async function withInternalDb<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: INTERNAL_DATABASE_URL, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
  } catch (err) {
    test.skip(true, `Internal Postgres not reachable: ${err instanceof Error ? err.message : String(err)}`);
    throw new Error("unreachable");
  }
  try {
    return await fn(client);
  } finally {
    // intentionally ignored: best-effort socket teardown.
    await client.end().catch(() => {});
  }
}

interface SeedOpts {
  /** 0–1. Default 0.5. */
  confidence?: number;
  status?: "pending" | "approved" | "rejected";
  /** True → an approved row the nightly job promoted (violet "Auto-approved"). */
  autoPromoted?: boolean;
  /** Rolling-mean latency (ms), or null (renders "—"). */
  avgDurationMs?: number | null;
  /** Extra description suffix so several seeded rows stay distinguishable. */
  tag?: string;
}

/**
 * Seed one `query_pattern` row for the given org. `pattern_sql` is run-unique
 * (the partial unique index over query_pattern rows is on
 * (org_id, connection_group_id, md5(pattern_sql)) with NULLS NOT DISTINCT), so
 * every seed is a genuine insert rather than an ON-CONFLICT increment. Column
 * list mirrors learned_patterns (schema.ts); a future NOT NULL column without a
 * default will break this seed (the browser-e2e analog of the -pg fixture-drift
 * rule) — no required CI gate catches it (the browser suite isn't wired into a
 * workflow; #4615 is deferred).
 */
async function seedPattern(c: Client, orgId: string, opts: SeedOpts = {}): Promise<string> {
  const {
    confidence = 0.5,
    status = "pending",
    autoPromoted = false,
    avgDurationMs = null,
    tag = "",
  } = opts;
  const reviewed = status !== "pending";
  const description = `${MARKER}${tag ? ` ${tag}` : ""}`;
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO learned_patterns
       (id, type, status, org_id, source_entity, connection_group_id, confidence,
        repetition_count, description, pattern_sql, proposed_by,
        reviewed_by, reviewed_at, avg_duration_ms, last_seen_at, auto_promoted,
        created_at, updated_at)
     VALUES
       (gen_random_uuid(), 'query_pattern', $2, $1, 'orders', NULL, $3,
        ${SEEN}, $4, $5, 'agent',
        $6, $7, $8, $9, $10,
        now(), now())
     RETURNING id`,
    [
      orgId,
      status,
      confidence,
      description,
      // Run+row-unique SQL keeps the identity index happy across seeds.
      `SELECT ${confidence} AS c /* ${MARKER} ${tag || "row"} ${Math.random().toString(36).slice(2)} */`,
      // Mirror the nightly job: an auto-promotion stamps the AUTO_PROMOTE_REVIEWER
      // sentinel (db/internal.ts), a human review stamps a user id ("admin" here).
      autoPromoted ? "atlas-auto-promote" : reviewed ? "admin" : null,
      reviewed ? new Date(Date.now() - 3_600_000).toISOString() : null,
      avgDurationMs,
      // Recent last_seen_at so a would-be promote/decay pass treats it as fresh.
      avgDurationMs === null ? null : new Date(Date.now() - 60_000).toISOString(),
      autoPromoted,
    ],
  );
  return rows[0].id;
}

/** Seed `n` recent injection-attribution rows for a pattern (last-30d count). */
async function seedInjections(c: Client, patternId: string, orgId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await c.query(
      `INSERT INTO learned_pattern_injections
         (id, pattern_id, org_id, connection_group_id, injected_at)
       VALUES (gen_random_uuid(), $1, $2, NULL, now() - ($3 || ' minutes')::interval)`,
      [patternId, orgId, String(i * 5)],
    );
  }
}

async function clearPatterns(c: Client, orgId: string): Promise<void> {
  // learned_pattern_injections cascades on the pattern delete (FK ON DELETE CASCADE).
  await c.query(`DELETE FROM learned_patterns WHERE type = 'query_pattern' AND org_id = $1`, [orgId]);
}

async function statusOf(c: Client, id: string): Promise<string | null> {
  const { rows } = await c.query<{ status: string }>(`SELECT status FROM learned_patterns WHERE id = $1`, [id]);
  return rows[0]?.status ?? null;
}

async function settingValue(c: Client, orgId: string, key: string): Promise<string | null> {
  const { rows } = await c.query<{ value: string }>(
    `SELECT value FROM settings WHERE key = $1 AND org_id = $2`,
    [key, orgId],
  );
  return rows[0]?.value ?? null;
}

// The seeded row's clickable table row. `interactiveRowProps` makes each `<tr>`
// a focusable role="button" (Enter/Space activation); the description cell
// carries the run marker.
function seededRow(page: Page, tag?: string): Locator {
  const text = tag ? `${MARKER} ${tag}` : MARKER;
  return page.locator('tr[role="button"]').filter({ hasText: text });
}

// All rows this run seeded (shared marker), in current table order.
function seededRows(page: Page): Locator {
  return page.locator('tr[role="button"]').filter({ hasText: MARKER });
}

// The detail sheet (shadcn Sheet → dialog with this slot).
const SHEET = '[data-slot="sheet-content"]';

// The toolbar "Confidence" is the range-FILTER trigger; the table has a separate
// "Confidence" column SORT header. Scope each so the two never collide.
function confidenceFilterButton(page: Page): Locator {
  // The filter bar is the flex row holding the status buttons; the "All" button's
  // parent is that bar. The sort header lives in the table, not here.
  return page
    .getByRole("button", { name: "All", exact: true })
    .locator("..")
    .getByRole("button", { name: /^Confidence/ });
}
function confidenceSortHeader(page: Page): Locator {
  return page.getByRole("columnheader", { name: "Confidence" }).getByRole("button");
}

// Serial: the tests share the org's pattern set, so they must not run
// concurrently against the same DB state.
test.describe.configure({ mode: "serial", timeout: 60_000 });

test.describe("learned-patterns cockpit — full curation loop", () => {
  let orgId: string;

  test.beforeAll(async () => {
    await withInternalDb(async (c) => {
      const { rows } = await c.query<{ org: string | null }>(
        `SELECT m."organizationId" AS org
           FROM member m JOIN "user" u ON u.id = m."userId"
          WHERE u.email = $1
          ORDER BY m."createdAt" ASC NULLS LAST
          LIMIT 1`,
        [ADMIN_EMAIL],
      );
      const org = rows[0]?.org;
      test.skip(!org, `No org membership for ${ADMIN_EMAIL} — is the workspace seeded?`);
      orgId = org!;
    });
  });

  test.beforeEach(async () => {
    await withInternalDb((c) => clearPatterns(c, orgId));
  });

  test.afterAll(async () => {
    await withInternalDb(async (c) => {
      await clearPatterns(c, orgId);
      // Leave the workspace knob as we found it (default off) so the gate is
      // idempotent across runs.
      await c.query(`DELETE FROM settings WHERE key = $1 AND org_id = $2`, [PROMOTE_DECAY_KEY, orgId]);
    });
  });

  test("the queue announces itself: pending-count endpoint + the nav entry reaches the cockpit", async ({ page }) => {
    await withInternalDb(async (c) => {
      await seedPattern(c, orgId, { tag: "nav-a", confidence: 0.4 });
      await seedPattern(c, orgId, { tag: "nav-b", confidence: 0.6 });
    });

    // The badge's data source: the reviewable-pending count endpoint (#4578).
    // Both seeded rows are repetition_count ≥ 2, so neither is hidden as seen-once.
    const res = await page.request.get("/api/v1/admin/learned-patterns/pending-count");
    expect(res.ok()).toBeTruthy();
    expect((await res.json()).count).toBe(2);

    // Discoverability: land on a sibling Intelligence page (the group is expanded
    // there), follow the Learned Patterns nav entry to the cockpit, and see the
    // seeded queue. NOTE: the numeric pending-count BADGE glyph does not render
    // even when the count is > 0 — filed separately (cockpit-visibility); this
    // leg asserts the endpoint + the nav entry that feed it, not the badge glyph.
    await page.goto("/admin/prompts");
    const navLink = page.getByRole("link", { name: "Learned Patterns" });
    await expect(navLink).toBeVisible();
    await navLink.click();
    await expect(page).toHaveURL(/\/admin\/learned-patterns/);
    await expect(seededRow(page, "nav-a")).toBeVisible();
    await expect(seededRow(page, "nav-b")).toBeVisible();
  });

  test("sorting by confidence reorders the queue (server-driven sort param + visual order)", async ({ page }) => {
    await withInternalDb(async (c) => {
      await seedPattern(c, orgId, { tag: "lo", confidence: 0.2 });
      await seedPattern(c, orgId, { tag: "hi", confidence: 0.9 });
    });
    await page.goto("/admin/learned-patterns");
    await expect(seededRow(page, "lo")).toBeVisible();

    // Open the Confidence column menu and choose Desc — the cockpit maps the
    // sortable column id to the whitelisted `sort=confidence` API param.
    const descResponse = page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/admin/learned-patterns?") &&
        /[?&]sort=confidence(&|$)/.test(r.url()) &&
        /[?&]dir=desc(&|$)/.test(r.url()),
    );
    await confidenceSortHeader(page).click();
    await page.getByRole("menuitemcheckbox", { name: "Desc" }).click();
    await descResponse;

    // Highest confidence first: the "hi" (90%) row precedes the "lo" (20%) row.
    await expect(seededRows(page).nth(0)).toContainText("hi");
    await expect(seededRows(page).nth(1)).toContainText("lo");

    // Flip to Asc — lowest first.
    const ascResponse = page.waitForResponse(
      (r) => r.url().includes("/api/v1/admin/learned-patterns?") && /[?&]dir=asc(&|$)/.test(r.url()),
    );
    await confidenceSortHeader(page).click();
    await page.getByRole("menuitemcheckbox", { name: "Asc" }).click();
    await ascResponse;
    await expect(seededRows(page).nth(0)).toContainText("lo");
    await expect(seededRows(page).nth(1)).toContainText("hi");
  });

  test("the confidence-range filter narrows the queue to the band", async ({ page }) => {
    await withInternalDb(async (c) => {
      await seedPattern(c, orgId, { tag: "weak", confidence: 0.3 });
      await seedPattern(c, orgId, { tag: "strong", confidence: 0.95 });
    });
    await page.goto("/admin/learned-patterns");
    await expect(seededRow(page, "weak")).toBeVisible();
    await expect(seededRow(page, "strong")).toBeVisible();

    // Apply a min of 70% — the 30% row falls out, the 95% row stays.
    await confidenceFilterButton(page).click();
    await page.locator("#confidence-min").fill("70");
    await page.getByRole("button", { name: "Apply" }).click();

    await expect(seededRow(page, "strong")).toBeVisible();
    await expect(seededRow(page, "weak")).toBeHidden();
    // The active filter is reflected on the trigger label.
    await expect(page.getByRole("button", { name: /Confidence 70–100%/ })).toBeVisible();
  });

  test("a low-confidence pattern opens KEYBOARD-ONLY and approval makes it injectable", async ({ page }) => {
    // 20% confidence — far below any auto-promote gate. Approval is an
    // ELIGIBILITY bypass (CONTEXT.md § Learned query patterns): the human's
    // approve makes it injectable immediately, regardless of the score.
    const id = await withInternalDb((c) => seedPattern(c, orgId, { tag: "kbd", confidence: 0.2 }));
    await page.goto("/admin/learned-patterns");

    const row = seededRow(page, "kbd");
    await expect(row).toBeVisible();

    // Keyboard-only: focus the row (a focusable role="button") and activate with
    // Enter — no pointer. The sheet must open.
    await row.focus();
    await expect(row).toBeFocused();
    await page.keyboard.press("Enter");

    const sheet = page.locator(SHEET);
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText("20%")).toBeVisible(); // confidence surfaced in the sheet

    // Approve from the sheet.
    await sheet.getByRole("button", { name: "Approve", exact: true }).click();

    // Server truth: the row reaches the terminal `approved` status — injectable
    // by construction, the confidence score notwithstanding.
    await expect
      .poll(() => withInternalDb((c) => statusOf(c, id)), { timeout: 15_000 })
      .toBe("approved");
    // The sheet reflects the human "Approved" badge (not "Auto-approved").
    await expect(sheet.getByText("Approved", { exact: true })).toBeVisible();
  });

  test("a failed review surfaces the error INSIDE the sheet, not behind it (#4574)", async ({ page }) => {
    const id = await withInternalDb((c) => seedPattern(c, orgId, { tag: "fail", confidence: 0.5 }));
    await page.goto("/admin/learned-patterns");
    const row = seededRow(page, "fail");
    await expect(row).toBeVisible();
    await row.click();
    const sheet = page.locator(SHEET);
    await expect(sheet).toBeVisible();

    // Force the first approve PATCH to fail; the retry falls through to the real
    // server. The cockpit pins the error to the surface the admin acted in — a
    // failed review must never read as a completed one.
    let calls = 0;
    await page.route(`**/api/v1/admin/learned-patterns/${id}`, async (route) => {
      if (route.request().method() === "PATCH") {
        calls += 1;
        if (calls === 1) {
          await route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ message: "Pattern store is locked", requestId: "e2e-lp-500" }),
          });
          return;
        }
      }
      await route.continue();
    });

    await sheet.getByRole("button", { name: "Approve", exact: true }).click();

    // The alert lands inside the still-open sheet, carrying the message + the
    // requestId for log correlation.
    const alert = sheet.locator('[role="alert"]');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText("Pattern store is locked");
    await expect(alert).toContainText("e2e-lp-500");
    // Exactly one alert carries the error — no duplicate page-body banner rendered
    // behind the sheet. (Scoped to the error text: the app always has a persistent
    // empty notification-region [role="alert"] that a bare count would double-count.)
    await expect(page.getByRole("alert").filter({ hasText: "Pattern store is locked" })).toHaveCount(1);
    // The action is still actionable — the review didn't silently "succeed".
    await expect(sheet.getByRole("button", { name: "Approve", exact: true })).toBeVisible();

    // Retry genuinely re-issues the mutation; the 2nd call reaches the real
    // server and the approve lands (server truth).
    await alert.getByRole("button", { name: "Retry" }).click();
    await expect
      .poll(() => withInternalDb((c) => statusOf(c, id)), { timeout: 15_000 })
      .toBe("approved");
  });

  test("per-pattern injection counts render in the row and the sheet (#4573)", async ({ page }) => {
    await withInternalDb(async (c) => {
      const pid = await seedPattern(c, orgId, {
        tag: "inject",
        status: "approved",
        confidence: 0.8,
        avgDurationMs: 420,
      });
      await seedInjections(c, pid, orgId, 5);
    });

    await page.goto("/admin/learned-patterns");
    const row = seededRow(page, "inject");
    await expect(row).toBeVisible();
    // The "Injected (30d)" column cell shows the 5 seeded attributions.
    await expect(row).toContainText("5");

    // The sheet's payoff panel labels it explicitly, and the perf columns are wired.
    await row.click();
    const sheet = page.locator(SHEET);
    await expect(sheet).toBeVisible();
    const injectedGroup = sheet.locator("div.space-y-1").filter({ hasText: "Injected (30d)" });
    await expect(injectedGroup.locator("p")).toHaveText("5");
    await expect(sheet.getByText("420ms")).toBeVisible();
  });

  test("the workspace auto-promotion knob flips in the UI and persists (#4582)", async ({ page }) => {
    // Start from a known-off state (the default) so the flip is unambiguous and
    // the test is re-runnable regardless of a prior run's residue.
    await withInternalDb((c) =>
      c.query(`DELETE FROM settings WHERE key = $1 AND org_id = $2`, [PROMOTE_DECAY_KEY, orgId]),
    );
    await page.goto("/admin/settings");

    // The workspace-scoped promote-decay toggle surfaces under Dynamic Learning.
    const row = page.locator("div.group").filter({ hasText: "Auto-Promote Learned Patterns" });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Edit" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Edit Auto-Promote Learned Patterns")).toBeVisible();
    // Drive the switch to ON regardless of its persisted starting value — the
    // settings registry's ~30s hot-reload cache can serve a prior run's value, so
    // a blind toggle is non-deterministic. Assert via aria-checked, then Save.
    const knob = dialog.getByRole("switch");
    if ((await knob.getAttribute("aria-checked")) !== "true") await knob.click();
    await expect(knob).toHaveAttribute("aria-checked", "true");
    await dialog.getByRole("button", { name: "Save" }).click();

    // Server truth: the workspace override persisted true (the fiber's opt-in).
    await expect
      .poll(() => withInternalDb((c) => settingValue(c, orgId, PROMOTE_DECAY_KEY)), { timeout: 15_000 })
      .toBe("true");
  });

  test("an auto-promoted pattern surfaces with the distinct Auto-approved badge (#3636)", async ({ page }) => {
    // The browser-observable half of "observe a promotion": a row the nightly
    // fiber promoted (status approved + auto_promoted) must read distinctly from
    // a human approval, in both the table and the sheet.
    await withInternalDb((c) =>
      seedPattern(c, orgId, {
        tag: "autopromoted",
        status: "approved",
        autoPromoted: true,
        confidence: 0.85,
        avgDurationMs: 300,
      }),
    );
    await page.goto("/admin/learned-patterns");

    const row = seededRow(page, "autopromoted");
    await expect(row).toBeVisible();
    // Table status cell: the violet machine badge, never a plain "Approved".
    await expect(row.getByText("Auto-approved")).toBeVisible();

    // Sheet header carries the same distinction, and the Review History resolves
    // the machine reviewer to a readable label — never the misleading
    // "Reviewed by: Unknown" a bare user-id join produced for the sentinel
    // (fixed in the #4584 cockpit pass).
    await row.click();
    const sheet = page.locator(SHEET);
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText("Auto-approved")).toBeVisible();
    await expect(sheet.getByText("Atlas auto-promotion")).toBeVisible();
    await expect(sheet.getByText("Reviewed by: Unknown")).toBeHidden();
  });
});
