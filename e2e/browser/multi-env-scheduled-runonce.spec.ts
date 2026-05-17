import { test, expect, type APIRequestContext } from "@playwright/test";
import {
  adminDelete,
  adminGet,
  adminPost,
  createAdminRequestContext,
  requireSeededGroups,
} from "./lib/multi-env-helpers";

/**
 * Real-API e2e — scheduled tasks run-once correctness (#2343 + #2418 / #2512
 * counterpart, #2443 deferred item).
 *
 * Creates a task scoped to `prod`, triggers `/run`, and asserts the dispatch
 * succeeds. We deliberately stop short of waiting for the agent loop to
 * complete — the LLM call is variable-duration and would flake the suite.
 * The unit + route layer (`scheduled-tasks.test.ts`, `executor.test.ts`,
 * `migrate-pg.test.ts`) already cover the resolveScheduledTaskConnection
 * → primary-member dispatch + result persistence; this layer's value is
 * "wired together with the post-#2512 validation gate so the dispatch
 * actually runs against the right group."
 */

interface CreatedTask {
  id: string;
  connectionGroupId: string | null;
}

interface TaskWithRuns extends CreatedTask {
  recentRuns: Array<{ id: string; startedAt: string; status: string }>;
}

test.describe("multi-env scheduled tasks — run-once dispatches against the bound group", () => {
  test.use({ baseURL: undefined });

  let request: APIRequestContext;

  test.beforeAll(async ({ playwright }) => {
    request = await createAdminRequestContext(playwright);
  });

  test.afterAll(async () => {
    await request?.dispose();
  });

  test("task scoped to prod accepts /run; group pointer round-trips on the row", async () => {
    const { prod } = await requireSeededGroups(request);

    const stamp = Date.now();
    const taskName = `rt_sched_${stamp}`;

    const created = await adminPost<CreatedTask>(request, "/api/v1/scheduled-tasks", {
      name: taskName,
      question: "select 1",
      // Cron is required by the schema; the schedule won't fire during
      // the test window — we trigger explicitly via /run.
      cronExpression: "0 9 * * 1",
      deliveryChannel: "webhook",
      recipients: [{ type: "webhook", url: "https://example.invalid/rt" }],
      connectionGroupId: prod.id,
    });
    expect(created.status, created.rawText).toBe(201);
    const taskId = created.body!.id;
    expect(created.body?.connectionGroupId, "task must persist its group binding").toBe(prod.id);

    try {
      // Trigger immediate execution. The dispatch path internally resolves
      // the group's primary member via resolveScheduledTaskConnection.
      const triggered = await adminPost<{ message: string; taskId: string }>(
        request,
        `/api/v1/scheduled-tasks/${taskId}/run`,
      );
      expect(triggered.status, triggered.rawText).toBe(200);
      expect(triggered.body?.taskId).toBe(taskId);

      // GET the task — the engine appends to recentRuns asynchronously.
      // Poll up to a few seconds, then accept either "run row materialized"
      // OR "dispatch acknowledged but run not yet flushed" — the second
      // shape still proves the routing gate passed (a cross-group / bad
      // group would have surfaced as a 4xx on /run).
      let runAppeared = false;
      for (let attempt = 0; attempt < 6 && !runAppeared; attempt++) {
        const fetched = await adminGet<TaskWithRuns>(request, `/api/v1/scheduled-tasks/${taskId}`);
        expect(fetched.status).toBe(200);
        expect(fetched.body?.connectionGroupId).toBe(prod.id);
        if ((fetched.body?.recentRuns?.length ?? 0) > 0) {
          runAppeared = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      // Either signal is acceptable — see comment above.
      if (!runAppeared) {
        console.warn(
          `[multi-env-scheduled-runonce] no run row after 3s; dispatch was acknowledged but persistence ` +
            `hadn't flushed. Group binding verified at create + GET; deeper run-row assertions live in ` +
            `executor.test.ts.`,
        );
      }
    } finally {
      await adminDelete(request, `/api/v1/scheduled-tasks/${taskId}`);
    }
  });

  test("post-#2512 cross-org connectionGroupId rejected at create time", async () => {
    // Sanity: the cross-org gate that #2513 shipped must still hold on
    // a multi-group workspace. Mirrors the unit fixture but proves the
    // wire contract end-to-end against the running API.
    await requireSeededGroups(request);

    const created = await adminPost<{ error: string }>(request, "/api/v1/scheduled-tasks", {
      name: `rt_sched_cross_${Date.now()}`,
      question: "select 1",
      cronExpression: "0 9 * * 1",
      deliveryChannel: "webhook",
      recipients: [{ type: "webhook", url: "https://example.invalid/rt" }],
      connectionGroupId: "g_does_not_exist_other_org",
    });
    expect(created.status, "cross-org pointer must 400 not 500 (#2512)").toBe(400);
    expect(created.body?.error).toBe("invalid_connection_group");
  });
});
