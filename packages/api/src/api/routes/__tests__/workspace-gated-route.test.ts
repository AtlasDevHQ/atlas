/**
 * #5191 — an ungated workspace route must not COMPILE.
 *
 * `__tests__/dashboards-permission.test.ts` already proves every REGISTERED
 * dashboards route enforces a flag, by reading the composed app. That is the
 * right instrument for read-vs-write correctness and the wrong one for
 * presence: it answers only when the suite runs, so a route added without a
 * gate is ungated in the tree until then.
 *
 * `createGatedRoute` moves presence to the type checker. The assertions that
 * matter here are therefore TYPE assertions, and `bun run type` is the gate
 * that runs them — `src/**\/*.ts` includes this file, so a `@ts-expect-error`
 * that stops being an error fails the build with "Unused '@ts-expect-error'
 * directive". That inversion is the whole point: this file cannot rot into a
 * test that passes by asserting nothing, because the directive fails when the
 * property it guards disappears.
 *
 * The runtime block below is thin on purpose — it exists to pin that the
 * wrapper is still `createRoute` underneath and did not quietly stop producing
 * a usable route config.
 */

import { describe, it, expect } from "bun:test";
import { z } from "@hono/zod-openapi";
import { createGatedRoute, requireWorkspacePermission } from "../workspace-router";

const GATE = [requireWorkspacePermission("dashboards:read")];

const PARAMS = {
  params: z.object({
    id: z.string().openapi({ param: { name: "id", in: "path" } }),
  }),
};

const RESPONSES = {
  200: {
    description: "ok",
    content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
  },
} as const;

// ── The property: no gate, no compile ────────────────────────────────

// @ts-expect-error -- `middleware` is REQUIRED. If this line ever stops being
// an error, `tsc` fails on the now-unused directive rather than passing
// silently, which is the only shape of guard that cannot rot into a no-op.
void createGatedRoute({
  method: "get",
  path: "/{id}/ungated",
  request: PARAMS,
  responses: RESPONSES,
});

// An EMPTY gate array is not the same hole and is deliberately allowed by the
// type: `middleware: []` is a route someone typed a gate list for and left
// empty, which the runtime route table in `dashboards-permission.test.ts`
// catches (it sees zero `checkPermission` calls). Recorded so the next reader
// does not "fix" the type to reject it and assume the runtime check is now
// redundant — the two guards cover different mistakes.
void createGatedRoute({
  method: "get",
  path: "/{id}/empty-gate",
  middleware: [],
  request: PARAMS,
  responses: RESPONSES,
});

// ── The positive control ─────────────────────────────────────────────

const gatedRoute = createGatedRoute({
  method: "get",
  path: "/{id}/gated",
  middleware: GATE,
  request: PARAMS,
  responses: RESPONSES,
});

describe("#5191 — createGatedRoute", () => {
  it("still produces a real route config", () => {
    // Without this the wrapper could return anything and the type assertions
    // above would still hold — `createRoute`'s contribution is `getRoutingPath`
    // and the config passthrough, and `.openapi(route, handler)` needs both.
    expect(gatedRoute.method).toBe("get");
    expect(gatedRoute.path).toBe("/{id}/gated");
    expect(typeof gatedRoute.getRoutingPath).toBe("function");
    expect(gatedRoute.getRoutingPath()).toBe("/:id/gated");
  });

  it("passes the declared gate through as route middleware", () => {
    // The gate has to survive the wrapper — a wrapper that type-checked the
    // field and then dropped it would satisfy every assertion above while
    // shipping every route ungated.
    expect(gatedRoute.middleware).toBe(GATE);
    expect(gatedRoute.middleware).toHaveLength(1);
  });
});
