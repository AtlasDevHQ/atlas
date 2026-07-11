/**
 * The Briefing — turn-one context for an Improvement conversation (#4514, PRD
 * #4502; CONTEXT.md § Semantic improvement).
 *
 * A PURE assembly module: it takes the workspace's already-known state — the
 * anchor (health + counts), tracked-profile freshness, the analyzer's findings,
 * recent query activity, rejection memory, the pending review queue, and the
 * most-recent panel decisions (approved/rejected) — and renders the deterministic
 * context block that is front-loaded at turn one of every Improvement conversation.
 *
 * It does **no I/O**: no database, no LLM, no clock. Profile freshness arrives
 * pre-computed (`describeProfileFreshness` in `connection-profile.ts` owns the
 * `now` injection), so this seam is trivially unit-testable and its output is a
 * function of its inputs alone. The impure gather that fills these inputs from
 * tracked profiles + audit patterns + the amendment queue lives in
 * `briefing-inputs.ts`.
 *
 * Why front-load it: without the briefing the expert agent had to spend tool
 * calls just to learn the health score, the analyzer's findings, and what was
 * already queued (#4508's prompt). With it, the agent orients from the block and
 * spends its steps on evidence-gathering for the next Amendment instead. Because
 * it is re-assembled each turn from live inputs, a panel decision (an admin
 * approving/rejecting in the review queue mid-conversation) shows up in the next
 * turn's block — via the most-recent-decisions feed — WITHOUT any synthetic
 * message being injected into the transcript.
 */

import type { AnalysisResult, AuditPattern } from "./types";
import type { SemanticHealthScore } from "./health";
import type { BriefingAnchor } from "./anchor";

/**
 * The health discriminator — a parse-failure zero ("corrupt") is not the same
 * as a no-data zero ("no_entities"). The single source of the three literals:
 * the type below derives from it, the route's OpenAPI enum reuses it, and the
 * widget mirrors it (the web package can't import `@atlas/api`, so its own copy
 * is the one exception — kept in lockstep by hand).
 */
export const SEMANTIC_HEALTH_STATUSES = ["ok", "no_entities", "corrupt"] as const;

export type SemanticHealthStatus = (typeof SEMANTIC_HEALTH_STATUSES)[number];

/**
 * One tracked connection's anchor line: which connection, its engine, and how
 * fresh its baseline profile is. `freshness` is pre-rendered ("profiled N days
 * ago") so this module stays clock-free; `null` means never successfully
 * baseline-profiled.
 */
export interface BriefingProfileLine {
  readonly connection: string;
  readonly dbType: string | null;
  readonly freshness: string | null;
  readonly tableCount: number | null;
}

/** A pending Amendment awaiting review, trimmed to what the block shows. */
export interface BriefingPendingItem {
  readonly entityName: string;
  readonly amendmentType: string | null;
  readonly confidence: number;
  readonly rationale: string | null;
}

/** A decision the admin made in the review panel (approved/rejected). */
export interface BriefingDecision {
  readonly entityName: string;
  readonly amendmentType: string | null;
  readonly decision: "approved" | "rejected";
}

/** Everything the pure assembler needs — a function of these inputs alone. */
export interface BriefingInputs {
  readonly health: SemanticHealthScore;
  /**
   * The discriminator is DERIVED by `deriveHealthStatus` (briefing-inputs.ts)
   * from these same `parseFailures`/`totalRows` counts (which come out of
   * `loadAnalysisContext`), so the three agree by construction:
   * `healthStatus === "corrupt"` implies `parseFailures === totalRows > 0`.
   * `deriveHealthStatus` is the canonical producer of the discriminator — don't
   * set `healthStatus` independently of the counts it's derived from.
   */
  readonly healthStatus: SemanticHealthStatus;
  /** DB rows that failed YAML parse (drives the corruption caption). */
  readonly parseFailures: number;
  /** DB rows considered (the corruption denominator). */
  readonly totalRows: number;
  /** Tracked-profile anchor lines, one per connection. */
  readonly profiles: readonly BriefingProfileLine[];
  /** Analyzer output, already score-sorted (highest first). */
  readonly findings: readonly AnalysisResult[];
  /** Audit-log query patterns — summarised into "most-queried tables". */
  readonly auditPatterns: readonly AuditPattern[];
  /** The pending review queue. */
  readonly pending: readonly BriefingPendingItem[];
  /** Decisions made in the panel recently (approved/rejected). */
  readonly recentDecisions: readonly BriefingDecision[];
  /** How many previously-rejected identities are suppressed (rejection memory). */
  readonly rejectionMemoryCount: number;
  /**
   * The resolved anchor this conversation started from (#4519), or undefined for
   * an anchorless sweep. A group anchor front-loads the group's entity inventory;
   * an entity anchor front-loads that entity's YAML + profile. Resolved upstream
   * (`resolveBriefingAnchor`) from the same entities/profiles this briefing loads,
   * so the pure assembler just renders it.
   */
  readonly anchor?: BriefingAnchor;
}

/** How many list items each section shows — bounded so the block stays compact. */
const MAX_FINDINGS = 5;
const MAX_PENDING = 8;
const MAX_DECISIONS = 8;
const MAX_QUERIED_TABLES = 5;
const MAX_ANCHOR_ENTITIES = 25;

/** 0–1 → whole-percent string. Clamps out-of-range and non-finite to 0–100. */
function pct(value: number): string {
  if (!Number.isFinite(value)) return "0%";
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

/** Collapse a rationale to a single trimmed line so a row can't blow up the block. */
function oneLine(text: string | null, max = 160): string {
  if (!text) return "";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function renderHealth(inputs: BriefingInputs): string[] {
  const { health, healthStatus, parseFailures, totalRows } = inputs;
  const lines = [
    `### Health: ${health.overall}/100`,
    `- Coverage ${health.coverage}% · Descriptions ${health.descriptionQuality}% · Measures ${health.measureCoverage}% · Joins ${health.joinCoverage}%`,
    `- ${health.entityCount} entities · ${health.dimensionCount} dimensions · ${health.measureCount} measures · ${health.glossaryTermCount} glossary terms`,
  ];
  // The load-bearing discriminator (#4514 AC4): a zero from parse failure is a
  // corruption signal ("fix the YAML"), NOT the empty-layer signal ("go build
  // the layer"). Say which, in words, so the agent acts on the right one.
  if (healthStatus === "corrupt") {
    lines.push(
      `- ⚠ ${parseFailures} of ${totalRows} entity ${totalRows === 1 ? "row" : "rows"} failed to parse — the layer is corrupt, not empty. Fix the malformed YAML before proposing changes.`,
    );
  } else if (healthStatus === "no_entities") {
    lines.push(`- The semantic layer has no entities yet — it is empty, not corrupt.`);
  }
  return lines;
}

function renderProfiles(profiles: readonly BriefingProfileLine[]): string[] {
  if (profiles.length === 0) return [];
  const lines = ["### Tracked profiles"];
  for (const p of profiles) {
    const engine = p.dbType ? ` (${p.dbType})` : "";
    const freshness = p.freshness ?? "never profiled";
    const tables =
      p.tableCount != null ? `, ${p.tableCount} ${p.tableCount === 1 ? "table" : "tables"}` : "";
    lines.push(`- ${p.connection}${engine}: ${freshness}${tables}`);
  }
  // Make the "no live query" contract explicit so the agent doesn't re-profile
  // the customer database just to start the chat (#4514 AC3).
  lines.push(
    "_These are tracked profiles — no live customer-database query was run to build this briefing._",
  );
  return lines;
}

function renderFindings(findings: readonly AnalysisResult[]): string[] {
  const lines = ["### Top findings"];
  if (findings.length === 0) {
    lines.push("- None — the analyzer surfaced no improvements from the tracked inputs.");
    return lines;
  }
  findings.slice(0, MAX_FINDINGS).forEach((f, i) => {
    lines.push(
      `${i + 1}. [${f.category}] ${f.entityName}: ${oneLine(f.rationale)} (impact ${pct(f.impact)}, confidence ${pct(f.confidence)})`,
    );
  });
  const extra = findings.length - MAX_FINDINGS;
  if (extra > 0) lines.push(`- …and ${extra} more.`);
  return lines;
}

function renderQueryActivity(patterns: readonly AuditPattern[]): string[] {
  if (patterns.length === 0) return [];
  // Sum query counts per table across all patterns → the most-queried tables.
  const byTable = new Map<string, number>();
  for (const p of patterns) {
    for (const t of p.tables) {
      byTable.set(t, (byTable.get(t) ?? 0) + p.count);
    }
  }
  if (byTable.size === 0) return [];
  const top = [...byTable.entries()]
    .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_QUERIED_TABLES);
  return [
    "### Query activity",
    `- Most-queried tables: ${top.map(([t, c]) => `${t} (${c})`).join(", ")}`,
  ];
}

function renderPending(pending: readonly BriefingPendingItem[]): string[] {
  const lines = [`### Pending review queue (${pending.length})`];
  if (pending.length === 0) {
    lines.push("- Empty — nothing is awaiting the admin's review.");
    return lines;
  }
  pending.slice(0, MAX_PENDING).forEach((p) => {
    const type = p.amendmentType ?? "amendment";
    const rationale = oneLine(p.rationale);
    lines.push(`- ${p.entityName} · ${type} · ${pct(p.confidence)}${rationale ? ` — ${rationale}` : ""}`);
  });
  const extra = pending.length - MAX_PENDING;
  if (extra > 0) lines.push(`- …and ${extra} more queued.`);
  return lines;
}

function renderRecentDecisions(decisions: readonly BriefingDecision[]): string[] {
  if (decisions.length === 0) return [];
  const lines = ["### Recent panel decisions"];
  // No "…and N more" line here (unlike findings/pending): the feed is already
  // bounded upstream by the query (`getRecentlyDecidedAmendments` LIMIT 10), so
  // this display cap effectively never truncates.
  decisions.slice(0, MAX_DECISIONS).forEach((d) => {
    lines.push(`- ${d.decision}: ${d.entityName} · ${d.amendmentType ?? "amendment"}`);
  });
  return lines;
}

/** Pluralize a count with its unit ("1 dimension", "3 dimensions"). */
function count(n: number, unit: string): string {
  return `${n} ${n === 1 ? unit : `${unit}s`}`;
}

/**
 * Render the anchor section (#4519) — what this conversation started from. Placed
 * ahead of the general state so the agent orients to the admin's chosen scope
 * first. Empty for an anchorless sweep, so the block is byte-identical to before
 * anchors when none is set.
 */
function renderAnchor(anchor: BriefingAnchor | undefined): string[] {
  if (!anchor) return [];

  if (anchor.kind === "group") {
    const lines = [
      `### Anchor: connection group \`${anchor.group}\``,
      `This conversation is anchored to the \`${anchor.group}\` connection group — focus improvements here unless the admin steers you elsewhere. It is a starting scope, not a cage.`,
    ];
    if (anchor.entities.length === 0) {
      lines.push(
        "- No entities are mapped in this group yet. Uncovered tables are grown through the enrich flow, never an amendment.",
      );
      return lines;
    }
    lines.push(`Entities in this group (${anchor.entities.length}):`);
    anchor.entities.slice(0, MAX_ANCHOR_ENTITIES).forEach((e) => {
      const described = e.description ? "described" : "no description";
      lines.push(
        `- \`${e.name}\` (${e.table}) — ${count(e.dimensionCount, "dimension")} · ${count(e.measureCount, "measure")} · ${count(e.joinCount, "join")} · ${described}`,
      );
    });
    const extra = anchor.entities.length - MAX_ANCHOR_ENTITIES;
    if (extra > 0) lines.push(`- …and ${extra} more.`);
    return lines;
  }

  // Entity anchor — front-load the entity's current YAML + tracked profile.
  const scope = anchor.group ? ` (group \`${anchor.group}\`)` : "";
  const lines = [
    `### Anchor: entity \`${anchor.entity}\`${scope}`,
    `This conversation is anchored to the \`${anchor.entity}\` entity — focus improvements on it unless the admin steers you elsewhere. It is a starting scope, not a cage.`,
    "",
    "Current YAML:",
    "```yaml",
    anchor.yaml,
    "```",
  ];
  lines.push(
    anchor.profile
      ? `Profile: \`${anchor.profile.table}\` — ${anchor.profile.rowCount.toLocaleString("en-US")} rows, ${count(anchor.profile.columnCount, "column")}.`
      : `Profile: no tracked baseline profile for \`${anchor.entity}\`'s table yet.`,
  );
  return lines;
}

/**
 * Assemble the deterministic briefing block from pre-loaded inputs. Pure: the
 * output is a function of `inputs` alone (no DB, LLM, or clock).
 */
export function assembleBriefing(inputs: BriefingInputs): string {
  const sections: string[][] = [
    [
      "## Semantic layer briefing",
      "",
      "The current state of this workspace's semantic layer is below — health, top findings, tracked profiles, the pending review queue, and recent panel decisions. Orient from it before calling tools: you do NOT need a tool call to learn the health score, the analyzer's findings, or what is already queued.",
    ],
    renderAnchor(inputs.anchor),
    renderHealth(inputs),
    renderProfiles(inputs.profiles),
    renderFindings(inputs.findings),
    renderQueryActivity(inputs.auditPatterns),
    renderPending(inputs.pending),
    renderRecentDecisions(inputs.recentDecisions),
  ];

  if (inputs.rejectionMemoryCount > 0) {
    sections.push([
      `_Rejection memory: ${inputs.rejectionMemoryCount} previously-rejected ${inputs.rejectionMemoryCount === 1 ? "change is" : "changes are"} suppressed — do not re-propose them._`,
    ]);
  }

  // Join non-empty sections with a blank line between each.
  return sections
    .filter((s) => s.length > 0)
    .map((s) => s.join("\n"))
    .join("\n\n");
}
