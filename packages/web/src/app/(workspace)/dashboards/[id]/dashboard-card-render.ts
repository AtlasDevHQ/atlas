/**
 * Dashboard card render batch (#2267 parameters, #3212 drilldown).
 *
 * Issues the view-time, parameter-aware `/render` for each CHART card with the
 * supplied override map bound server-side (#3136 — parameterized query, never
 * string-interpolated). Text / section-block cards are skipped (they have no
 * SQL; the render endpoint would short-circuit them anyway). One POST per card,
 * the same bound override map across all of them.
 *
 * Extracted from the dashboard view page so the batch — the thing that actually
 * refetches every card with the bound value — is unit-testable without mounting
 * the page. The page wraps this in its stale-batch sequence guards and folds the
 * entries into grid/comparison/error state.
 */
import type { DashboardCard, KpiComparisonResult } from "@/ui/lib/types";
import type { ParameterValues } from "@/ui/components/dashboards/dashboard-parameter-bar";

export interface CardRenderContext {
  apiUrl: string;
  dashboardId: string;
  isCrossOrigin: boolean;
  /**
   * #4315 — when `"draft"`, render the caller's DRAFT card SQL (the private
   * working copy being edited) instead of the published definition. Omitted /
   * `"published"` renders the published SQL. The server falls back to
   * published when no draft exists, so this is safe to pass whenever the
   * canvas is showing the draft view.
   */
  view?: "draft" | "published";
}

export type CardRenderEntry =
  | {
      cardId: string;
      ok: true;
      columns: string[];
      rows: Record<string, unknown>[];
      /** #3137 — present (possibly null) only for KPI cards; drives the delta chip. */
      comparison?: KpiComparisonResult | null;
    }
  | { cardId: string; ok: false; error: string };

/** Render ONE card's SQL with the override values bound server-side. Never
 *  throws — every failure (non-OK status, network error) maps to an `ok: false`
 *  entry so a single bad card can't reject the whole batch. */
export async function renderDashboardCard(
  card: DashboardCard,
  overrides: ParameterValues,
  ctx: CardRenderContext,
): Promise<CardRenderEntry> {
  try {
    const viewSuffix = ctx.view === "draft" ? "?view=draft" : "";
    const res = await fetch(`${ctx.apiUrl}/api/v1/dashboards/${ctx.dashboardId}/cards/${card.id}/render${viewSuffix}`, {
      method: "POST",
      credentials: ctx.isCrossOrigin ? "include" : "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parameters: overrides }),
    });
    if (!res.ok) {
      // Surface the backend reason (approval required, connection unavailable,
      // invalid parameters, …) instead of dropping it.
      let message = `Request failed (${res.status})`;
      try {
        const body = (await res.json()) as { message?: string; error?: string };
        message = body.message ?? body.error ?? message;
      } catch (parseError) {
        // Non-JSON error body — keep the status-based message, but surface the
        // parse failure for debugging rather than dropping it.
        console.debug("[dashboard] failed to parse render error body", {
          cardId: card.id,
          status: res.status,
          parseError: parseError instanceof Error ? parseError.message : String(parseError),
        });
      }
      return { cardId: card.id, ok: false, error: message };
    }
    const json = (await res.json()) as {
      columns: string[];
      rows: Record<string, unknown>[];
      comparison?: KpiComparisonResult | null;
    };
    return {
      cardId: card.id,
      ok: true,
      columns: json.columns,
      rows: json.rows,
      // Left undefined for a non-KPI card (the render endpoint omits the field);
      // a KPI card carries the block or `null`. Callers record only the KPI
      // cards, whose value is the comparison block or `null`.
      comparison: json.comparison,
    };
  } catch (err) {
    // The error is surfaced to the user via the returned entry (the affected
    // tile flips to labeled-stale / errored, #4321), but log it too so the
    // underlying network/parse failure stays visible in diagnostics.
    const message = err instanceof Error ? err.message : String(err);
    console.debug("[dashboard] card render failed", {
      cardId: card.id,
      dashboardId: ctx.dashboardId,
      error: message,
    });
    return { cardId: card.id, ok: false, error: message };
  }
}

/**
 * A card the render batch will actually POST for — a SQL-backed chart / kpi /
 * table card, not a `text` section block (which has no SQL). Shared so the
 * page's "flip to loading" set and this batch's render set are derived from the
 * SAME predicate and can't drift (a divergence would strand a card on the
 * loading spinner with no phase entry). (#4321)
 */
export function isRenderableCard(card: Pick<DashboardCard, "kind">): boolean {
  return card.kind !== "text";
}

/**
 * Render every CHART card in one batch (text cards skipped). The override map is
 * bound identically across cards. Resolves once all renders settle — each entry
 * carries its own ok/err so partial failures are reported per card, not as a
 * whole-batch rejection.
 */
export function renderDashboardCards(
  cards: DashboardCard[],
  overrides: ParameterValues,
  ctx: CardRenderContext,
): Promise<CardRenderEntry[]> {
  const chartCards = cards.filter(isRenderableCard);
  return Promise.all(chartCards.map((card) => renderDashboardCard(card, overrides, ctx)));
}
