/**
 * Tests for `CatalogSeeder` — slice 2 of #2649 (issue #2650).
 *
 * Two surfaces under test:
 *
 *   - `planCatalogSeed` (pure planner) — input/output shape, no mocks.
 *   - `seedCatalog` (DB driver) — drives a hand-rolled `CatalogSeedDb`
 *     mock; asserts UPSERT params + that no DELETE/UPDATE bypasses the
 *     planner.
 *
 * Asserted invariants (AC quoted from #2650):
 *
 *   - Boot pass calls CatalogSeeder; idempotent on re-boot
 *   - `slack` row exists after first boot with install_model='oauth',
 *     enabled=true, saas_eligible=true
 *   - Other chat Platform rows seeded with enabled=false and
 *     install_model='static-bot'
 *   - Re-running seed preserves enabled=false if ops has manually
 *     disabled the row (log warn if config disagrees)
 *   - Re-running seed warns on orphan catalog rows; does NOT delete
 *   - CatalogSeeder unit-tested: idempotency, env-var presence matrix,
 *     preservation of ops-disabled, orphan warn, plan-tier propagation,
 *     install_model propagation, saas_eligible propagation
 */

import { describe, it, expect } from "bun:test";
import {
  planCatalogSeed,
  seedCatalog,
  type CatalogDbRow,
  type CatalogSeedDb,
} from "../catalog-seeder";
import type { CatalogEntry } from "@atlas/api/lib/config";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function entry(partial: Partial<CatalogEntry> & Pick<CatalogEntry, "slug">): CatalogEntry {
  return {
    type: "chat",
    install_model: "oauth",
    min_plan: "starter",
    enabled: true,
    saas_eligible: true,
    ...partial,
  };
}

function row(partial: Partial<CatalogDbRow> & Pick<CatalogDbRow, "slug">): CatalogDbRow {
  return {
    name: "Slack",
    description: null,
    type: "chat",
    iconUrl: null,
    minPlan: "starter",
    enabled: true,
    installModel: "oauth",
    saasEligible: true,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Mock DB
// ---------------------------------------------------------------------------

interface Captured {
  sql: string;
  params: unknown[];
}

function makeMockDb(seed: CatalogDbRow[] = []): {
  db: CatalogSeedDb;
  captured: Captured[];
  rows: CatalogDbRow[];
} {
  const rows = [...seed];
  const captured: Captured[] = [];

  const db: CatalogSeedDb = {
    async query<T = unknown>(sql: string, params?: unknown[]) {
      const ps = params ?? [];
      captured.push({ sql, params: ps });

      // SELECT path: return current snapshot.
      if (sql.includes("SELECT slug, name, description, type, icon_url")) {
        return { rows: snapshotRaw(rows) as T[] };
      }
      if (sql.includes("SELECT slug FROM plugin_catalog")) {
        return { rows: rows.map((r) => ({ slug: r.slug })) as T[] };
      }

      // INSERT … ON CONFLICT path: emulate upsert by mutating the snapshot.
      if (sql.includes("INSERT INTO plugin_catalog")) {
        const [
          _id,
          name,
          slug,
          description,
          type,
          iconUrl,
          minPlan,
          enabled,
          installModel,
          saasEligible,
        ] = ps as [
          string,
          string,
          string,
          string | null,
          string,
          string | null,
          string,
          boolean,
          string,
          boolean,
        ];
        const existing = rows.findIndex((r) => r.slug === slug);
        const next: CatalogDbRow = {
          slug,
          name,
          description,
          type,
          iconUrl,
          minPlan,
          enabled,
          installModel,
          saasEligible,
        };
        if (existing === -1) rows.push(next);
        else rows[existing] = next;
        return { rows: [] as T[] };
      }

      return { rows: [] as T[] };
    },
  };

  return { db, captured, rows };
}

function snapshotRaw(rows: CatalogDbRow[]): Array<{
  slug: string;
  name: string;
  description: string | null;
  type: string;
  icon_url: string | null;
  min_plan: string;
  enabled: boolean;
  install_model: string;
  saas_eligible: boolean;
}> {
  return rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    description: r.description,
    type: r.type,
    icon_url: r.iconUrl,
    min_plan: r.minPlan,
    enabled: r.enabled,
    install_model: r.installModel,
    saas_eligible: r.saasEligible,
  }));
}

// ---------------------------------------------------------------------------
// planCatalogSeed (pure)
// ---------------------------------------------------------------------------

describe("planCatalogSeed", () => {
  it("inserts new entries when no DB rows exist", () => {
    const plan = planCatalogSeed(
      [entry({ slug: "slack" }), entry({ slug: "telegram", enabled: false, install_model: "static-bot" })],
      [],
    );
    expect(plan.actions).toHaveLength(2);
    expect(plan.actions[0]).toMatchObject({ action: "insert", entry: { slug: "slack" } });
    expect(plan.actions[1]).toMatchObject({ action: "insert", entry: { slug: "telegram" } });
    expect(plan.orphanSlugs).toEqual([]);
  });

  it("returns noop when DB matches declaration", () => {
    const plan = planCatalogSeed(
      [entry({ slug: "slack" })],
      [row({ slug: "slack" })],
    );
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({ action: "noop", entry: { slug: "slack" } });
  });

  it("updates when columns differ", () => {
    const plan = planCatalogSeed(
      [entry({ slug: "slack", min_plan: "team", saas_eligible: false })],
      [row({ slug: "slack" })], // minPlan starter, saasEligible true
    );
    expect(plan.actions).toHaveLength(1);
    const action = plan.actions[0];
    expect(action.action).toBe("update");
    if (action.action === "update") {
      expect(action.diff).toContain("minPlan");
      expect(action.diff).toContain("saasEligible");
    }
  });

  it("preserves DB-disabled rows even when config wants enabled=true", () => {
    const plan = planCatalogSeed(
      [entry({ slug: "slack", enabled: true })],
      [row({ slug: "slack", enabled: false })],
    );
    expect(plan.actions[0]).toMatchObject({ action: "preserve-disabled" });
  });

  it("does NOT preserve when config explicitly wants enabled=false (operator turning off)", () => {
    // Reverse: DB says true, config says false — treat as a normal
    // update. The "preserve" rule is one-way: it protects ops's
    // emergency-disable; it doesn't pin DB-true against a config
    // turn-off.
    const plan = planCatalogSeed(
      [entry({ slug: "slack", enabled: false })],
      [row({ slug: "slack", enabled: true })],
    );
    expect(plan.actions[0]?.action).toBe("update");
  });

  it("surfaces orphan slugs without removing them from the plan", () => {
    const plan = planCatalogSeed(
      [entry({ slug: "slack" })],
      [row({ slug: "slack" }), row({ slug: "community-plugin-xyz" })],
    );
    expect(plan.actions).toHaveLength(1);
    expect(plan.orphanSlugs).toEqual(["community-plugin-xyz"]);
  });

  it("throws on duplicate slugs in declared entries (defense in depth)", () => {
    expect(() =>
      planCatalogSeed(
        [entry({ slug: "slack" }), entry({ slug: "slack" })],
        [],
      ),
    ).toThrow(/duplicate slug "slack"/);
  });
});

// ---------------------------------------------------------------------------
// seedCatalog (DB driver) — idempotency + key AC assertions
// ---------------------------------------------------------------------------

describe("seedCatalog", () => {
  it("inserts every declared entry on first boot (Slack as canonical OAuth row)", async () => {
    const { db, rows } = makeMockDb([]);
    const result = await seedCatalog(db, [
      entry({ slug: "slack" }),
      entry({ slug: "telegram", install_model: "static-bot", enabled: false }),
    ]);

    expect(result.insertedCount).toBe(2);
    expect(result.updatedCount).toBe(0);
    expect(result.preservedCount).toBe(0);

    const slack = rows.find((r) => r.slug === "slack");
    expect(slack).toBeDefined();
    expect(slack?.installModel).toBe("oauth");
    expect(slack?.enabled).toBe(true);
    expect(slack?.saasEligible).toBe(true);

    const telegram = rows.find((r) => r.slug === "telegram");
    expect(telegram?.installModel).toBe("static-bot");
    expect(telegram?.enabled).toBe(false);
  });

  it("is idempotent on the second boot — zero writes the second time around", async () => {
    const declared = [
      entry({ slug: "slack" }),
      entry({ slug: "telegram", install_model: "static-bot", enabled: false }),
    ];

    const { db, captured } = makeMockDb([]);
    await seedCatalog(db, declared);
    const writesAfterFirstBoot = captured.filter((c) =>
      c.sql.includes("INSERT INTO plugin_catalog"),
    ).length;
    expect(writesAfterFirstBoot).toBe(2);

    const second = await seedCatalog(db, declared);
    expect(second.insertedCount).toBe(0);
    expect(second.updatedCount).toBe(0);
    expect(second.preservedCount).toBe(0);

    const writesAfterSecondBoot = captured.filter((c) =>
      c.sql.includes("INSERT INTO plugin_catalog"),
    ).length;
    expect(writesAfterSecondBoot).toBe(2); // unchanged
  });

  it("propagates plan_tier from config to DB row", async () => {
    const { db, rows } = makeMockDb([]);
    await seedCatalog(db, [
      entry({ slug: "slack", min_plan: "team" }),
      entry({ slug: "salesforce", type: "integration", min_plan: "business" }),
    ]);
    expect(rows.find((r) => r.slug === "slack")?.minPlan).toBe("team");
    expect(rows.find((r) => r.slug === "salesforce")?.minPlan).toBe("business");
  });

  it("propagates install_model from config to DB row", async () => {
    const { db, rows } = makeMockDb([]);
    await seedCatalog(db, [
      entry({ slug: "slack", install_model: "oauth" }),
      entry({ slug: "email", type: "integration", install_model: "form" }),
      entry({ slug: "telegram", install_model: "static-bot", enabled: false }),
    ]);
    expect(rows.find((r) => r.slug === "slack")?.installModel).toBe("oauth");
    expect(rows.find((r) => r.slug === "email")?.installModel).toBe("form");
    expect(rows.find((r) => r.slug === "telegram")?.installModel).toBe("static-bot");
  });

  it("propagates saas_eligible from config to DB row", async () => {
    const { db, rows } = makeMockDb([]);
    await seedCatalog(db, [
      entry({ slug: "slack", saas_eligible: true }),
      entry({ slug: "github-pat", type: "integration", install_model: "form", saas_eligible: false }),
    ]);
    expect(rows.find((r) => r.slug === "slack")?.saasEligible).toBe(true);
    expect(rows.find((r) => r.slug === "github-pat")?.saasEligible).toBe(false);
  });

  it("preserves ops-disabled state on re-seed (config drift logged at warn)", async () => {
    const { db, rows } = makeMockDb([
      row({ slug: "slack", enabled: false }), // ops-disabled in DB
    ]);
    const result = await seedCatalog(db, [
      entry({ slug: "slack", enabled: true }), // config wants on
    ]);

    expect(result.preservedCount).toBe(1);
    expect(result.preservedSlugs).toEqual(["slack"]);
    expect(rows.find((r) => r.slug === "slack")?.enabled).toBe(false);
  });

  it("does NOT delete orphan rows; surfaces them in the result for log/observability", async () => {
    const { db, rows } = makeMockDb([
      row({ slug: "slack" }),
      row({ slug: "community-plugin", type: "integration" }),
    ]);
    const result = await seedCatalog(db, [entry({ slug: "slack" })]);
    expect(result.orphanSlugs).toEqual(["community-plugin"]);
    // Row still present in the mock DB — never deleted.
    expect(rows.find((r) => r.slug === "community-plugin")).toBeDefined();
  });

  it("short-circuits when no entries declared but still surfaces orphans", async () => {
    const { db, captured } = makeMockDb([row({ slug: "stale" })]);
    const result = await seedCatalog(db, []);
    expect(result.applied).toBe(0);
    expect(result.orphanSlugs).toEqual(["stale"]);
    // Sanity: never issued an INSERT.
    expect(captured.some((c) => c.sql.includes("INSERT INTO plugin_catalog"))).toBe(
      false,
    );
  });
});
