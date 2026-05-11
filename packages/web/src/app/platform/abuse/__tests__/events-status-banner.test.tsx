/**
 * Regression guard for `EventsStatusBanner` (#1682 diagnostic channel UI).
 *
 * The banner is the final mile of the diagnostic channel — it turns the
 * wire signal (`AbuseDetail.eventsStatus`) into an operator-visible warning.
 * The backend half is covered by integration tests in
 * `packages/api/src/lib/security/__tests__/abuse.test.ts` and the route
 * layer test in `packages/api/src/api/__tests__/admin-abuse.test.ts`, but
 * the UI branch is where a prop-name typo, an early-return refactor, or a
 * styling-severity regression would ship silently — the rest of the
 * payload still renders, the banner just quietly doesn't.
 *
 * Invariants pinned below:
 *  - status="ok" → no banner (benign empty history)
 *  - status="load_failed" → destructive (red) banner, role=alert, the
 *    "Do not reinstate" copy operators are supposed to read
 *  - status="db_unavailable" → neutral advisory banner, still role=alert
 *    for a11y, but NOT the destructive styling (to keep the operator's
 *    attention to the genuinely dangerous `load_failed` case)
 */

import { describe, expect, test } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import { createElement } from "react";
import { EventsStatusBanner } from "../detail-panel";

function renderBanner(status: "ok" | "load_failed" | "db_unavailable") {
  return render(createElement(EventsStatusBanner, { status }));
}

describe("EventsStatusBanner", () => {
  test("renders nothing when status is 'ok'", () => {
    const { container } = renderBanner("ok");
    expect(container.textContent).toBe("");
    expect(container.querySelector("[role=alert]")).toBeNull();
    cleanup();
  });

  test("renders destructive banner on 'load_failed' with 'Do not reinstate' copy", () => {
    const { getByRole } = renderBanner("load_failed");
    const alert = getByRole("alert");
    expect(alert).toBeTruthy();
    // The destructive class token is what distinguishes this severity from
    // `db_unavailable` — a regression that reused the advisory styling
    // would lose the operator-alerting signal.
    expect(alert.className).toContain("border-destructive");
    expect(alert.className).toContain("bg-destructive");
    // Headline + actionable copy both render. The "Do not reinstate" guard
    // is the whole point of the banner — losing it reintroduces #1682.
    expect(alert.textContent).toContain("Event history failed to load");
    expect(alert.textContent).toContain("Do not reinstate");
    cleanup();
  });

  test("renders advisory (non-destructive) banner on 'db_unavailable'", () => {
    const { getByRole } = renderBanner("db_unavailable");
    const alert = getByRole("alert");
    expect(alert).toBeTruthy();
    // Advisory styling, NOT destructive — the self-hosted steady state
    // should not scream at the operator on every page load.
    expect(alert.className).not.toContain("border-destructive");
    expect(alert.className).not.toContain("bg-destructive");
    expect(alert.className).toContain("bg-muted");
    expect(alert.textContent).toContain("Event history is not persisted");
    expect(alert.textContent).toContain("DATABASE_URL");
    cleanup();
  });
});
