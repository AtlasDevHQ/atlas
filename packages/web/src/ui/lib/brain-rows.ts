/**
 * Projecting a `searchBrain` tool output onto rendered lines (#5451).
 *
 * Pure and dependency-free, extracted from the two `search-brain-card` copies
 * so the projection is ONE definition per package instead of ~90 duplicated
 * lines inside a component. `packages/react` cannot import
 * `@useatlas/schemas` (published package, published-tarball `@useatlas/types`),
 * so the boundary still forces a mirror — but a mirror of a small pure module
 * can be pinned by BEHAVIOUR, which `brain-rows-mirror.test.ts` does: both
 * copies are driven through the same fixtures and must agree.
 *
 * ⚠️ Reads defensively rather than casting to `BrainSearchResult`. This is a
 * tool output crossing an HTTP + streaming boundary, and a projection that
 * throws on a shape surprise takes the tier chip down with it — which is the
 * bug, not a symptom of it.
 */

/**
 * One rendered line: the tier chip plus what the row says.
 *
 * ⚠️ NOT named `Brain*`. `check-docs-brain-snippets.ts` reserves the exported
 * `Brain*` namespace for published contracts and compares each such name
 * against one declaration — so exporting the same `BrainRow` from two packages
 * made the comparison depend on scan order and failed the gate. This is a local
 * presentation shape, not a published Brain contract, and it should never have
 * been in that namespace.
 */
export interface ResultLine {
  /**
   * The raw wire value, NOT narrowed. Passing `string` straight to the badge is
   * what makes an unrecognized tier visible instead of absent.
   */
  readonly tier: string;
  readonly primary: string;
  readonly secondary: string | null;
  /** True for a 1-hop link-graph expansion result rather than a direct match. */
  readonly linked: boolean;
}

export function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Collapse `ts_headline` markup to plain text — the snippet arrives with `<b>`
 * tags. Named for what it does: the old name (`plain`) described the output and
 * left the reader to discover the Postgres-specific reason from the body.
 */
export function stripHeadlineMarkup(value: unknown): string | null {
  const s = str(value);
  return s ? s.replace(/<\/?b>/g, "") : null;
}

export function formatDate(value: unknown): string | null {
  const s = str(value);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString();
}

/**
 * Project one fused row onto a line, by tier.
 */
export function toRow(raw: unknown, linked: boolean): ResultLine {
  const row = raw != null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const tier = typeof row.tier === "string" ? row.tier : "";

  switch (tier) {
    case "fact": {
      const claim = [str(row.subject), str(row.predicate), str(row.object)]
        .filter(Boolean)
        .join(" ");
      const age = formatDate(row.validFrom);
      const decayLevel = str((row.decay as Record<string, unknown> | undefined)?.level);
      // `unknown` is a real decay level meaning "no age signal", not a missing
      // value — showing it as a chip caption would read as a defect.
      const decay = decayLevel && decayLevel !== "unknown" ? decayLevel : null;
      const corroboration =
        typeof row.corroborationCount === "number" && row.corroborationCount > 1
          ? `${row.corroborationCount} sources`
          : null;
      return {
        tier,
        primary: claim || stripHeadlineMarkup(row.snippet) || "(claim unavailable)",
        secondary:
          [age && `since ${age}`, decay, corroboration].filter(Boolean).join(" · ") || null,
        linked,
      };
    }
    case "raw-episode": {
      const said = stripHeadlineMarkup(row.snippet) ?? str(row.body) ?? str(row.locator);
      const who = str(row.sourceActor);
      const when = formatDate(row.occurredAt);
      const extraction = row.extraction === "pending" ? "not yet distilled" : null;
      return {
        tier,
        primary: said ?? "(source material unavailable)",
        secondary:
          [str(row.source), who, when, extraction].filter(Boolean).join(" · ") || null,
        linked,
      };
    }
    case "document": {
      return {
        tier,
        primary: str(row.title) ?? str(row.path) ?? "(untitled document)",
        secondary:
          [str(row.collection), stripHeadlineMarkup(row.snippet)].filter(Boolean).join(" · ") || null,
        linked,
      };
    }
    default:
      // Deliberately still a row. See the module header.
      return {
        tier,
        primary: stripHeadlineMarkup(row.snippet) ?? str(row.title) ?? "(result could not be read)",
        secondary: null,
        linked,
      };
  }
}

export function toRows(result: Record<string, unknown> | null): ResultLine[] {
  if (!result) return [];
  const results = Array.isArray(result.results) ? result.results : [];
  const neighbors = Array.isArray(result.neighbors) ? result.neighbors : [];
  return [
    ...results.map((r) => toRow(r, false)),
    ...neighbors.map((n) => toRow(n, true)),
  ];
}
