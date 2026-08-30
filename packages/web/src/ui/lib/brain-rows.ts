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
  /**
   * That this answer CHANGED, what it said before, and who changed it (#5461,
   * PRD finish condition 5) — `null` for a claim that never changed, which is
   * almost every row and must stay silent.
   *
   * Its own field rather than another clause appended to {@link secondary}: the
   * secondary line is metadata ABOUT the claim (age, decay, corroboration),
   * while this is a different claim that used to be the answer. Rendering them
   * as one run of dot-separated fragments would read as more metadata, and the
   * one thing this line has to do is not be skimmed past.
   */
  readonly changed: string | null;
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
 * Render an `actorIdentity` as a person, or say plainly that it cannot be.
 *
 * ⚠️ Never falls back to the raw `actor` handle. `slack:U0AQW6KF2EM` is the
 * vendor's own id, not a name, and putting it where a name goes tells a reader
 * they have been told who did this when they have not. The three states are
 * ADR-0036 T5's: `atlas` reads live, `directory` is a dated snapshot and says
 * so, `opaque` means Atlas cannot name them and says THAT.
 *
 * ⚠️ A FOURTH state renders here as of #5454: `machine`. It is not a person who
 * cannot be named — it is a positive statement that no person was involved, so
 * it returns `null` like `opaque` but for the opposite reason, and the caller
 * must not print it as an unnamed human. Kept as an explicit arm rather than
 * riding the `default` so a fifth state still falls through loudly.
 */
function actorName(identity: unknown): string | null {
  const row = identity != null && typeof identity === "object"
    ? (identity as Record<string, unknown>)
    : null;
  if (!row) return null;
  switch (row.state) {
    case "atlas":
      return str(row.name);
    case "directory": {
      const name = str(row.displayName) ?? str(row.realName);
      if (!name) return null;
      const at = formatDate(row.snapshotAt);
      // The date travels WITH the name, always: this person has no Atlas
      // account, so the name is a snapshot that may since have changed.
      return at ? `${name} (as of ${at})` : name;
    }
    // No person produced this. `null` here means "nobody to name", not
    // "somebody we cannot name" — see the header.
    case "machine":
      return null;
    case "opaque":
      return null;
    default:
      return null;
  }
}

/**
 * The changed-answer line (#5461).
 *
 * Reads `history` defensively like everything else here — this is a tool output
 * across an HTTP and streaming boundary, and a projection that throws takes the
 * whole card down.
 *
 * The four states are deliberately worded apart, because collapsing any two of
 * them tells the reader something untrue:
 *
 *   - a previous answer they may read, changed by a person — name them
 *   - the same, retired by the publish gate — say what happened, name NOBODY
 *     (the actor on a gate-retired claim never touched the old one)
 *   - a previous answer they may NOT read — "restricted", never "unknown"
 *   - changed more than once — say how many, since only the most recent
 *     earlier version is carried
 */
export function toChanged(raw: unknown): string | null {
  const history = raw != null && typeof raw === "object"
    ? ((raw as Record<string, unknown>).history as Record<string, unknown> | undefined)
    : undefined;
  const prior = history?.prior;
  if (prior == null || typeof prior !== "object") return null;
  const priorRow = prior as Record<string, unknown>;
  // Narrowed the same way `prior` is, one line up. The `?.` reads below are
  // safe against a primitive anyway, but a module whose header makes
  // defensive reading the point should not have one field checked and its
  // neighbour cast.
  const rawChangedBy = history?.changedBy;
  const changedBy =
    rawChangedBy != null && typeof rawChangedBy === "object"
      ? (rawChangedBy as Record<string, unknown>)
      : undefined;

  const when = formatDate(priorRow.validTo) ?? formatDate(changedBy?.at);
  const count = typeof history?.priorCount === "number" ? history.priorCount : 1;
  const parts: string[] = [];

  if (priorRow.visible === true) {
    const was = str(priorRow.object);
    parts.push(was ? `Previously ${was}` : "This answer changed");
  } else {
    // Existence without content. "Unknown" would be a different and false
    // statement about the record.
    parts.push("This answer changed — the earlier value is restricted");
  }
  if (when) parts.push(`until ${when}`);

  const by =
    changedBy?.kind === "correction"
      ? (() => {
          const name = actorName(changedBy.actorIdentity);
          return name ? `changed by ${name}` : "changed by someone this view cannot name";
        })()
      : changedBy?.kind === "promotion"
        ? "replaced when a newer claim was published"
        : null;
  if (by) parts.push(by);
  if (count > 1) parts.push(`changed ${count} times`);

  return parts.join(" · ");
}

/**
 * Project one fused row onto a line, by tier.
 */
export function toRow(raw: unknown, linked: boolean): ResultLine {
  const row = raw != null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const rawTier = typeof row.tier === "string" ? row.tier : "";
  // Pre-#5469 persisted rows spell the wire tiers `fact` / `raw-episode`
  // (`messages.content` is unversioned jsonb). Normalized here so every
  // downstream consumer — the chip-class map, the tier chips the partitioner
  // collects off these rows — speaks only the current vocabulary.
  const tier =
    rawTier === "fact" ? "attested" : rawTier === "raw-episode" ? "on-record" : rawTier;

  switch (tier) {
    case "attested": {
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
        changed: toChanged(row),
      };
    }
    case "on-record": {
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
        // Only a FACT makes a claim about what is true, so only a fact has a
        // previous answer. An episode is what was said and a document is
        // outside the truth ordering — neither is superseded by anything.
        changed: null,
      };
    }
    case "document": {
      return {
        tier,
        primary: str(row.title) ?? str(row.path) ?? "(untitled document)",
        secondary:
          [str(row.collection), stripHeadlineMarkup(row.snippet)].filter(Boolean).join(" · ") || null,
        linked,
        changed: null,
      };
    }
    default:
      // Deliberately still a row. See the module header.
      return {
        tier,
        primary: stripHeadlineMarkup(row.snippet) ?? str(row.title) ?? "(result could not be read)",
        secondary: null,
        linked,
        changed: null,
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
