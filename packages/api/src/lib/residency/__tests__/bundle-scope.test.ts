/**
 * Region-migration bundle-scope drift tripwire (#4460).
 *
 * The bug this pins: pillars shipped after the export bundle was defined
 * (dashboards, knowledge, scheduled tasks, integrations, durable sessions)
 * silently stayed in the source region because nothing forced a per-table
 * decision. This suite enumerates every table in the Drizzle schema and fails
 * when one appears with no explicit entry in `BUNDLE_TABLE_DECISIONS` — so
 * the NEXT new pillar breaks CI instead of silently missing the bundle.
 *
 * It also pins the registry to the implementation: every `exported` table
 * must actually be read by `export.ts` and written by `admin-migrate.ts`.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "@atlas/api/lib/db/schema";
import {
  BUNDLE_TABLE_DECISIONS,
  EXPORTED_TABLES,
  STAYS_TABLES,
  type BundleTableScope,
} from "../bundle-scope";

// String-indexed view: the registry's literal-keyed type (via `satisfies`)
// rejects arbitrary-string indexing, which is exactly what this suite does.
const decisionFor: Readonly<Record<string, BundleTableScope | undefined>> = BUNDLE_TABLE_DECISIONS;

// ── Enumerate the live schema ────────────────────────────────────────

const schemaTables = Object.values(schema).flatMap((v) =>
  is(v, PgTable) ? [getTableConfig(v)] : [],
);

const schemaTableNames = schemaTables.map((t) => t.name);

describe("bundle-scope drift tripwire (#4460)", () => {
  it("enumerates a plausible schema (sanity: the known pillars are present)", () => {
    // Guards the enumeration itself — if the Drizzle introspection ever came
    // back empty, every other assertion would vacuously pass.
    expect(schemaTableNames.length).toBeGreaterThan(50);
    for (const known of ["conversations", "dashboards", "knowledge_documents", "scheduled_tasks", "agent_runs"]) {
      expect(schemaTableNames).toContain(known);
    }
  });

  it("every schema table has an explicit export decision (new pillar ⇒ decide before merge)", () => {
    const undecided = schemaTableNames.filter((name) => !(name in BUNDLE_TABLE_DECISIONS));
    expect(
      undecided,
      `New table(s) with no region-migration export decision: ${undecided.join(", ")}.\n` +
        `Add each to BUNDLE_TABLE_DECISIONS in lib/residency/bundle-scope.ts — decide whether it ` +
        `moves in the export bundle ('exported'), stays behind and is deleted by the #4458 cleanup ` +
        `('stays'), or is platform/auth-spine state outside the workspace scope ('platform'). ` +
        `If 'exported', wire it through export.ts + admin-migrate.ts and update the "What moves" ` +
        `table in data-residency.mdx.`,
    ).toEqual([]);
  });

  it("has no stale registry entries for dropped tables", () => {
    const stale = Object.keys(BUNDLE_TABLE_DECISIONS).filter(
      (name) => !schemaTableNames.includes(name),
    );
    expect(
      stale,
      `Registry entries for tables no longer in db/schema.ts: ${stale.join(", ")}. ` +
        `Remove them from BUNDLE_TABLE_DECISIONS.`,
    ).toEqual([]);
  });

  it("every decision carries a non-empty rationale", () => {
    for (const [name, entry] of Object.entries(BUNDLE_TABLE_DECISIONS)) {
      expect(entry.reason.trim().length, `${name} has an empty reason`).toBeGreaterThan(0);
    }
  });

  it("pins the decided v2 bundle scope exactly", () => {
    // The maintainer-approved scope from #4460. Changing this list is a
    // product decision — update the issue trail + data-residency.mdx with it.
    expect([...EXPORTED_TABLES].toSorted()).toEqual([
      "agent_session_memory",
      "conversations",
      "dashboard_cards",
      "dashboard_user_drafts",
      "dashboards",
      "knowledge_documents",
      "knowledge_links",
      "learned_patterns",
      "messages",
      "scheduled_tasks",
      "semantic_entities",
      "settings",
    ]);
  });

  it("every exported table is actually read by the export implementation", () => {
    const exportSource = readFileSync(join(import.meta.dir, "..", "export.ts"), "utf8");
    for (const table of EXPORTED_TABLES) {
      expect(
        exportSource.includes(`FROM ${table}`),
        `bundle-scope.ts says '${table}' is exported, but export.ts has no 'FROM ${table}' query — ` +
          `the registry and the implementation have drifted.`,
      ).toBe(true);
    }
  });

  it("no non-exported table is read by the export implementation (reverse drift)", () => {
    // The inverse tripwire: a table wired into export.ts while classified
    // 'stays'/'platform' would ship data the registry — and #4458's deletion
    // scoping — says stays behind. Both directions must agree.
    const exportSource = readFileSync(join(import.meta.dir, "..", "export.ts"), "utf8");
    const nonExported = schemaTableNames.filter((name) => !EXPORTED_TABLES.includes(name));
    for (const table of nonExported) {
      expect(
        exportSource.includes(`FROM ${table}`) || exportSource.includes(`JOIN ${table}`),
        `export.ts queries '${table}', but bundle-scope.ts classifies it as non-exported — ` +
          `either reclassify it 'exported' or remove the query.`,
      ).toBe(false);
    }
  });

  it("every exported table is actually written by the import implementation", () => {
    const importSource = readFileSync(
      join(import.meta.dir, "..", "..", "..", "api", "routes", "admin-migrate.ts"),
      "utf8",
    );
    for (const table of EXPORTED_TABLES) {
      expect(
        importSource.includes(`INSERT INTO ${table}`),
        `bundle-scope.ts says '${table}' is exported, but admin-migrate.ts has no ` +
          `'INSERT INTO ${table}' — the bundle would be produced but never restored.`,
      ).toBe(true);
    }
  });

  it("org-scoped tables classified 'platform' stay a pinned, deliberate exemption set", () => {
    // A table carrying org_id/workspace_id is workspace-scoped on its face —
    // classifying one as 'platform' (untouched by the bundle AND by the #4458
    // cleanup) must be a deliberate call, not a default. This pins the current
    // exemptions; a NEW org-scoped table classified 'platform' fails here
    // until it is either reclassified or added with a recorded rationale in
    // bundle-scope.ts.
    const orgScopedPlatform = schemaTables
      .filter((t) => {
        const entry = decisionFor[t.name];
        if (!entry || entry.decision !== "platform") return false;
        return t.columns.some((c) => c.name === "org_id" || c.name === "workspace_id");
      })
      .map((t) => t.name)
      .toSorted();

    expect(orgScopedPlatform).toEqual([
      "abuse_events", // platform abuse telemetry keyed by workspace for attribution only
      "crm_outbox", // operator lead pipeline; workspace column is provenance
      "email_outbox", // transient delivery queue
      "oauth_state", // transient handshake state, short TTL
      "onboarding_emails", // operator drip bookkeeping
      "region_migrations", // the migration bookkeeping itself
      "stripe_teardown_pending", // global billing-teardown queue
      "user_trial_grants", // global billing/abuse spine (user-keyed)
    ]);
  });

  it("the three buckets partition the schema (no table in two states)", () => {
    // Record<string, …> gives us this by construction today; the assertion
    // documents the invariant the #4458 cleanup relies on: delete exactly
    // the org rows of STAYS_TABLES ∪ (exported tables, already moved) and
    // never touch 'platform'.
    const total = EXPORTED_TABLES.length + STAYS_TABLES.length +
      Object.values(BUNDLE_TABLE_DECISIONS).filter((d) => d.decision === "platform").length;
    expect(total).toBe(Object.keys(BUNDLE_TABLE_DECISIONS).length);
    expect(total).toBe(schemaTableNames.length);
  });
});
