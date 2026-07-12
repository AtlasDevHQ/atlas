import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * Semantic-Improve Elevation — review-loop browser drive (#4522, the milestone
 * gate for #4502).
 *
 * Drives the elevated `/admin/semantic/improve` decision surface against
 * DB-seeded proposals, so each leg is deterministic and carries no LLM cost
 * (the briefed-conversation → proposal leg is exercised by hand in the
 * milestone's human UX pass; here the proposal is seeded directly and only the
 * review surface is driven): the one pending queue → live-diff review card →
 * reject → the Rejected view → Reconsider → back to pending → approve, plus the
 * hash-carried stale-confirm seam (#4511) asserted at the review endpoint.
 *
 * Proposals are seeded straight into `learned_patterns`
 * (`type = 'semantic_amendment'`) — the row shape the expert agent's
 * `proposeAmendment` tool persists (through `insertSemanticAmendment`) — via
 * the internal Postgres, mirroring the
 * `multi-env` specs' `pg.Client` pattern. Auth is ambient (the chromium
 * project's stored admin session). Each test clears the org's improve queue and
 * seeds exactly the row it needs, so "the card" is unambiguous, and asserts
 * against a reloaded page (server truth) rather than optimistic client state.
 */

const INTERNAL_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://atlas:atlas@localhost:5432/atlas";
const ADMIN_EMAIL = process.env.ATLAS_ADMIN_EMAIL ?? "admin@useatlas.dev";

const SEED_ENTITY = "orders";
// Run-unique so the live diff always shows the measure as a genuine addition
// and the approve leg applies a real change — the approve test writes the
// measure into the (gitignored, dev-only) org semantic layer, so a fixed name
// would produce an empty diff on the next run.
const SEED_MEASURE = `e2e_improve_measure_${Date.now().toString(36)}`;
const SEED_MARKER = "E2E semantic-improve review-loop seed";

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

function amendmentPayload(): string {
  return JSON.stringify({
    amendmentType: "add_measure",
    entityName: SEED_ENTITY,
    confidence: 0.72,
    amendment: {
      name: SEED_MEASURE,
      sql: "AVG(total_cents)",
      type: "avg",
      description: "Average order value in cents — mean of total_cents across orders.",
    },
    rationale: `${SEED_MARKER}: adds a mean-order-value measure to exercise the review loop deterministically.`,
  });
}

async function clearAmendments(c: Client, orgId: string): Promise<void> {
  await c.query(`DELETE FROM learned_patterns WHERE type = 'semantic_amendment' AND org_id = $1`, [orgId]);
}

/** Seed one amendment in the given status; `rejected` stamps the reviewer fields. */
async function seedAmendment(c: Client, orgId: string, status: "pending" | "rejected"): Promise<string> {
  const reviewed = status === "rejected";
  // Column list mirrors learned_patterns (schema.ts) — pattern_sql is the only
  // NOT NULL column without a default, so it is set. A future migration adding
  // a NOT NULL column without a default will break this seed (the browser-e2e
  // analog of the -pg fixture-drift rule); no required CI gate catches it (the
  // browser suite isn't wired into a workflow — see #4615).
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO learned_patterns
       (id, type, status, org_id, source_entity, connection_group_id, confidence,
        description, pattern_sql, proposed_by, reviewed_by, reviewed_at,
        amendment_payload, created_at, updated_at)
     VALUES
       (gen_random_uuid(), 'semantic_amendment', $2, $1, $3, NULL, 0.72,
        $4, 'n/a', 'e2e', $5, $6,
        $7::jsonb, now(), now())
     RETURNING id`,
    [
      orgId,
      status,
      SEED_ENTITY,
      `[add_measure] ${SEED_ENTITY}: ${SEED_MARKER}`,
      reviewed ? "admin" : null,
      reviewed ? new Date(Date.now() - 3_600_000).toISOString() : null,
      amendmentPayload(),
    ],
  );
  return rows[0].id;
}

async function statusOf(c: Client, id: string): Promise<string | null> {
  const { rows } = await c.query<{ status: string }>(`SELECT status FROM learned_patterns WHERE id = $1`, [id]);
  return rows[0]?.status ?? null;
}

// Serial: the tests share the org's improve queue, so they must not run
// concurrently against the same DB state.
test.describe.configure({ mode: "serial", timeout: 60_000 });

test.describe("semantic-improve — review loop", () => {
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
    await withInternalDb((c) => clearAmendments(c, orgId));
  });

  test.afterAll(async () => {
    await withInternalDb((c) => clearAmendments(c, orgId));
  });

  test("pending card renders in the one queue with a live diff and decide actions", async ({ page }) => {
    await withInternalDb((c) => seedAmendment(c, orgId, "pending"));
    await page.goto("/admin/semantic/improve");
    await page.getByRole("tab", { name: /Pending/ }).click();

    // The seeded proposal renders: entity, amendment-type badge, rationale, and
    // the recomputed live diff (#4511) with the new measure.
    await expect(page.getByText(SEED_MARKER, { exact: false })).toBeVisible();
    await expect(page.getByText("add measure", { exact: false })).toBeVisible();
    // `.first()` — the run-unique measure name appears on the diff's `name:`
    // line; scope to avoid a strict-mode multi-match if it recurs.
    await expect(page.getByText(SEED_MEASURE, { exact: false }).first()).toBeVisible();

    // Both decide actions are present on the card.
    await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Reject", exact: true })).toBeVisible();
  });

  test("reject moves the proposal to the Rejected view with a Reconsider control", async ({ page }) => {
    const id = await withInternalDb((c) => seedAmendment(c, orgId, "pending"));
    await page.goto("/admin/semantic/improve");
    await page.getByRole("tab", { name: /Pending/ }).click();
    await expect(page.getByText(SEED_MARKER, { exact: false })).toBeVisible();

    await page.getByRole("button", { name: "Reject", exact: true }).click();

    // The Rejected view (#4512) surfaces it with a Reconsider control...
    await page.getByRole("tab", { name: /Rejected/ }).click();
    await expect(page.getByText(SEED_MARKER, { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: /Reconsider/i })).toBeVisible();

    // ...and it is persisted rejected, out of the pending queue (server truth).
    await expect
      .poll(() => withInternalDb((c) => statusOf(c, id)), { timeout: 10_000 })
      .toBe("rejected");
  });

  test("Reconsider returns a rejected proposal to the pending queue as actionable", async ({ page }) => {
    const id = await withInternalDb((c) => seedAmendment(c, orgId, "rejected"));
    await page.goto("/admin/semantic/improve");

    await page.getByRole("tab", { name: /Rejected/ }).click();
    await expect(page.getByText(SEED_MARKER, { exact: false })).toBeVisible();
    await page.getByRole("button", { name: /Reconsider/i }).click();

    // Persisted back to pending (reviewer fields cleared) — server truth.
    await expect
      .poll(() => withInternalDb((c) => statusOf(c, id)), { timeout: 10_000 })
      .toBe("pending");

    // A reload reflects it in the pending queue as an actionable card again.
    await page.reload();
    await page.getByRole("tab", { name: /Pending/ }).click();
    await expect(page.getByText(SEED_MARKER, { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
  });

  test("approve applies the proposal and clears it from the pending queue", async ({ page }) => {
    const id = await withInternalDb((c) => seedAmendment(c, orgId, "pending"));
    await page.goto("/admin/semantic/improve");
    await page.getByRole("tab", { name: /Pending/ }).click();
    await expect(page.getByText(SEED_MARKER, { exact: false })).toBeVisible();

    await page.getByRole("button", { name: "Approve", exact: true }).click();

    // Approved-means-applied by construction (#4506): the row reaches the
    // terminal `approved` status (its YAML was written), never silently
    // re-queued — a compensated re-queue back to pending always carries
    // last_apply_error, so `approved` (not merely "not pending") is the
    // assertion that catches a failed claim-then-apply.
    await expect
      .poll(() => withInternalDb((c) => statusOf(c, id)), { timeout: 15_000 })
      .toBe("approved");

    // ...and the actionable card leaves the pending queue in the UI.
    await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeHidden();
  });

  test("forced stale-confirm: a 409 swaps in the confirm prompt and Confirm re-submits with the fresh hash", async ({ page }) => {
    const id = await withInternalDb((c) => seedAmendment(c, orgId, "pending"));
    await page.goto("/admin/semantic/improve");
    await page.getByRole("tab", { name: /Pending/ }).click();
    await expect(page.getByText(SEED_MARKER, { exact: false })).toBeVisible();

    // Drive the live-diff (#4511) stale path through the UI deterministically:
    // the first approve POST returns 409 `stale_baseline` (entity moved since
    // render, carrying the fresh diff + hash); the Confirm re-submit then
    // succeeds. Route-mocked — bodies mirror the real endpoint shapes
    // (admin-semantic-improve.ts: the 409 at :926-936, the 200 at :954) — so the
    // UI continuation (classifyReviewResult `stale` branch → the "changed while
    // you were reviewing" prompt → Confirm re-approving with the fresh hash) is
    // exercised without racing the server's cached baseline. This proves the
    // CLIENT half; the next test guards the real-server 409 contract. The two
    // are bound only by these mirrored shapes (no shared type is exported), so
    // keep them in sync if the stale_baseline body ever changes.
    const FRESH_HASH = "f".repeat(64);
    let reviewCalls = 0;
    let confirmBody: Record<string, unknown> | null = null;
    await page.route(`**/api/v1/admin/semantic-improve/amendments/${id}/review`, async (route) => {
      reviewCalls += 1;
      if (reviewCalls === 1) {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            error: "stale_baseline",
            message: "This entity changed while you were reviewing. Review the updated change and confirm.",
            diff: "Index: semantic/entities/orders.yml\n@@ -1,1 +1,2 @@\n   measures:\n+  - name: fresh_baseline_measure\n",
            baselineHash: FRESH_HASH,
            requestId: "e2e-stale",
          }),
        });
      } else {
        confirmBody = route.request().postDataJSON() as Record<string, unknown>;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, id, decision: "approved" }),
        });
      }
    });

    // Approve → stale: the card swaps to the confirm prompt, Approve → Confirm.
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(page.getByText(/changed while you were reviewing/i)).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirm", exact: true })).toBeVisible();

    // Confirm re-submits — and carries the FRESH baseline hash from the 409, the
    // wiring that makes the confirm an informed re-approve rather than a replay.
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect.poll(() => reviewCalls).toBe(2);
    expect(confirmBody).toMatchObject({ decision: "approved", baselineHash: FRESH_HASH });
    // The continuation resolves — the stale prompt clears.
    await expect(page.getByText(/changed while you were reviewing/i)).toBeHidden();
  });

  test("approving with a stale baseline hash is refused (409 stale_baseline)", async ({ page }) => {
    // The live diff (#4511) carries a per-render baseline hash; approving with a
    // hash that no longer matches the entity's current baseline must 409 rather
    // than apply against a moved baseline. Needs a resolvable baseline (a real
    // entity YAML) to produce a current hash to mismatch against — skip cleanly
    // when the demo semantic layer isn't present in this environment.
    const id = await withInternalDb((c) => seedAmendment(c, orgId, "pending"));
    const pending = await page.request.get("/api/v1/admin/semantic-improve/pending");
    expect(pending.ok()).toBeTruthy();
    const body = (await pending.json()) as { amendments: Array<{ id: string; baselineHash: string | null }> };
    const seeded = body.amendments.find((a) => a.id === id);
    expect(seeded, "seeded amendment should be in the pending queue").toBeTruthy();
    test.skip(
      !seeded?.baselineHash,
      "No live-diff baseline for the seeded entity (demo semantic layer absent) — stale-confirm seam not exercisable here",
    );

    const res = await page.request.post(
      `/api/v1/admin/semantic-improve/amendments/${id}/review`,
      { data: { decision: "approved", baselineHash: "0".repeat(64) } },
    );
    expect(res.status()).toBe(409);
    const err = (await res.json()) as { error?: string; baselineHash?: string | null };
    expect(err.error).toBe("stale_baseline");
    // The 409 carries the fresh baseline hash so the card can present inline
    // update-and-confirm (#4511) rather than dead-ending the review.
    expect(err.baselineHash).toBeTruthy();
  });
});
