/**
 * Tests for the built-in Knowledge Base catalog seed pass (#4206, ADR-0028).
 *
 * Two surfaces under test:
 *
 *  1. `seedBuiltinKnowledgeCatalog(db)` — the runtime seeder. Asserts the
 *     built-in rows (`okf-upload` #4206, `bundle-sync` #4211) are inserted with
 *     `ON CONFLICT (id) DO NOTHING` semantics through the operator-curated
 *     seam, with the ADR-0028 §5 shape (type `context`, pillar `knowledge`,
 *     install_model `form`). The foreign-id slug collision that target makes
 *     visible (#5239) has its own file — `…-collision.test.ts` for the log and
 *     the loop, `builtin-knowledge-catalog-seed-pg.test.ts` for the proof that
 *     Postgres actually raises there.
 *
 *  2. `BUILTIN_KNOWLEDGE_CATALOG_ROW(S)` — the in-process source of truth.
 *     Asserts content-level invariants (okf-upload credential-less; bundle-sync
 *     endpoint config with exactly one secret field).
 *
 * The migration/CHECK interaction is checked end-to-end by `migrate-pg.test.ts`
 * against a real Postgres; here we exercise the boot-time seed against an
 * in-memory mock pool.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  seedBuiltinKnowledgeCatalog,
  BUILTIN_KNOWLEDGE_CATALOG_ROW,
  BUILTIN_BUNDLE_SYNC_CATALOG_ROW,
  BUILTIN_NOTION_KNOWLEDGE_CATALOG_ROW,
  BUILTIN_CONFLUENCE_CATALOG_ROW,
  BUILTIN_CONFLUENCE_DC_CATALOG_ROW,
  BUILTIN_ZENDESK_CATALOG_ROW,
  BUILTIN_SALESFORCE_KNOWLEDGE_CATALOG_ROW,
  BUILTIN_INTERCOM_CATALOG_ROW,
  BUILTIN_FRONT_CATALOG_ROW,
  BUILTIN_HELPSCOUT_CATALOG_ROW,
  BUILTIN_FRESHDESK_CATALOG_ROW,
  BUILTIN_ZOOM_TRANSCRIPTS_CATALOG_ROW,
  BUILTIN_OUTLOOK_MAIL_CATALOG_ROW,
  BUILTIN_KNOWLEDGE_CATALOG_ROWS,
  type BuiltinKnowledgeCatalogSeedDb,
} from "@atlas/api/lib/db/seed-builtin-knowledge-catalog";
import {
  CONFIG_HELP_PAIRS,
  RENAME_PAIRS,
  sqlLiteral,
  stripSqlComments,
} from "@atlas/api/lib/db/__tests__/brain-catalog-rename-fixtures";

interface CapturedQuery {
  sql: string;
  params: unknown[];
}

/**
 * Mock pool: when `insert` is true every INSERT "succeeds" (RETURNING echoes
 * the bound slug param); when false every row "already exists" (empty
 * RETURNING — the ON CONFLICT DO NOTHING path).
 */
const captureDb = (
  insert = true,
): { db: BuiltinKnowledgeCatalogSeedDb; captured: CapturedQuery[] } => {
  const captured: CapturedQuery[] = [];
  const db: BuiltinKnowledgeCatalogSeedDb = {
    async query<T = unknown>(sql: string, params?: unknown[]) {
      captured.push({ sql, params: params ?? [] });
      return { rows: insert ? ([{ slug: params?.[2] }] as T[]) : [] };
    },
  };
  return { db, captured };
};

describe("BUILTIN_KNOWLEDGE_CATALOG_ROW", () => {
  it("is the credential-less `okf-upload` form install (ADR-0028 §5)", () => {
    const row = BUILTIN_KNOWLEDGE_CATALOG_ROW;
    expect(row.slug).toBe("okf-upload");
    expect(row.id).toBe("catalog:okf-upload");
    expect(row.installModel).toBe("form");
    expect(row.autoInstall).toBe(false);
    // No credentials: no field is flagged secret.
    expect(row.configSchema.every((f) => f.secret !== true)).toBe(true);
  });

  it("uses the `catalog:<slug>` id convention", () => {
    for (const row of BUILTIN_KNOWLEDGE_CATALOG_ROWS) {
      expect(row.id).toBe(`catalog:${row.slug}`);
    }
  });
});

describe("BUILTIN_BUNDLE_SYNC_CATALOG_ROW (#4211)", () => {
  it("is the `bundle-sync` form install: endpoint + auth config, secret flagged", () => {
    const row = BUILTIN_BUNDLE_SYNC_CATALOG_ROW;
    expect(row.slug).toBe("bundle-sync");
    expect(row.id).toBe("catalog:bundle-sync");
    expect(row.installModel).toBe("form");
    expect(row.autoInstall).toBe(false);
    const keys = row.configSchema.map((f) => f.key);
    expect(keys).toContain("endpoint_url");
    expect(keys).toContain("auth_scheme");
    expect(keys).toContain("auth_secret");
    // Exactly one secret field: the auth secret (rendered as a password
    // input, never echoed) — the endpoint URL itself is not secret.
    expect(row.configSchema.filter((f) => f.secret === true).map((f) => f.key)).toEqual([
      "auth_secret",
    ]);
    const endpoint = row.configSchema.find((f) => f.key === "endpoint_url");
    expect(endpoint?.required).toBe(true);
  });
});

describe("BUILTIN_NOTION_KNOWLEDGE_CATALOG_ROW (#4378)", () => {
  it("is the `notion-knowledge` form install: required token (secret), optional description", () => {
    const row = BUILTIN_NOTION_KNOWLEDGE_CATALOG_ROW;
    expect(row.slug).toBe("notion-knowledge");
    expect(row.id).toBe("catalog:notion-knowledge");
    expect(row.installModel).toBe("form");
    expect(row.autoInstall).toBe(false);
    const keys = row.configSchema.map((f) => f.key);
    expect(keys).toContain("integration_token");
    expect(keys).toContain("description");
    // No endpoint/auth-scheme fields — the shared pages ARE the scope.
    expect(keys).not.toContain("endpoint_url");
    // Exactly one secret field: the integration token (password input, never
    // echoed), and it is required.
    expect(row.configSchema.filter((f) => f.secret === true).map((f) => f.key)).toEqual([
      "integration_token",
    ]);
    expect(row.configSchema.find((f) => f.key === "integration_token")?.required).toBe(true);
  });
});

describe("BUILTIN_CONFLUENCE_CATALOG_ROW (#4377)", () => {
  it("is the `confluence` form install: base URL + email + space key + secret token", () => {
    const row = BUILTIN_CONFLUENCE_CATALOG_ROW;
    expect(row.slug).toBe("confluence");
    expect(row.id).toBe("catalog:confluence");
    expect(row.installModel).toBe("form");
    expect(row.autoInstall).toBe(false);
    const keys = row.configSchema.map((f) => f.key);
    expect(keys).toContain("base_url");
    expect(keys).toContain("email");
    expect(keys).toContain("space_key");
    expect(keys).toContain("api_token");
    // Exactly one secret field: the API token (never echoed). The base URL,
    // email, and space key are non-secret config.
    expect(row.configSchema.filter((f) => f.secret === true).map((f) => f.key)).toEqual([
      "api_token",
    ]);
    for (const key of ["base_url", "email", "space_key", "api_token"]) {
      expect(row.configSchema.find((f) => f.key === key)?.required).toBe(true);
    }
  });
});

describe("BUILTIN_CONFLUENCE_DC_CATALOG_ROW (#4394)", () => {
  it("is the `confluence-datacenter` form install: base URL + space key + secret PAT, NO email", () => {
    const row = BUILTIN_CONFLUENCE_DC_CATALOG_ROW;
    expect(row.slug).toBe("confluence-datacenter");
    expect(row.id).toBe("catalog:confluence-datacenter");
    expect(row.installModel).toBe("form");
    expect(row.autoInstall).toBe(false);
    const keys = row.configSchema.map((f) => f.key);
    expect(keys).toContain("base_url");
    expect(keys).toContain("space_key");
    expect(keys).toContain("api_token");
    // A Server/DC PAT is a Bearer credential with no paired username — the
    // Cloud-only email field must be absent.
    expect(keys).not.toContain("email");
    // Exactly one secret field: the PAT (never echoed).
    expect(row.configSchema.filter((f) => f.secret === true).map((f) => f.key)).toEqual([
      "api_token",
    ]);
    for (const key of ["base_url", "space_key", "api_token"]) {
      expect(row.configSchema.find((f) => f.key === key)?.required).toBe(true);
    }
  });
});

describe("BUILTIN_ZENDESK_CATALOG_ROW (#4396)", () => {
  it("is the `zendesk` form install: subdomain + email + secret token, NO base URL", () => {
    const row = BUILTIN_ZENDESK_CATALOG_ROW;
    expect(row.slug).toBe("zendesk");
    expect(row.id).toBe("catalog:zendesk");
    expect(row.installModel).toBe("form");
    expect(row.autoInstall).toBe(false);
    const keys = row.configSchema.map((f) => f.key);
    expect(keys).toContain("subdomain");
    expect(keys).toContain("email");
    expect(keys).toContain("api_token");
    // Hosts are composed `*.zendesk.com` labels — no free-form URL field, and
    // no brand field: brands are enumerated at install time (one collection
    // per help-center-enabled brand).
    expect(keys).not.toContain("base_url");
    expect(keys).not.toContain("brand_id");
    // Exactly one secret field: the API token (never echoed).
    expect(row.configSchema.filter((f) => f.secret === true).map((f) => f.key)).toEqual([
      "api_token",
    ]);
    for (const key of ["subdomain", "email", "api_token"]) {
      expect(row.configSchema.find((f) => f.key === key)?.required).toBe(true);
    }
  });
});

describe("BUILTIN_SALESFORCE_KNOWLEDGE_CATALOG_ROW (#4397)", () => {
  it("is the `salesforce-knowledge` form install: scope-only config, NO secret field", () => {
    const row = BUILTIN_SALESFORCE_KNOWLEDGE_CATALOG_ROW;
    expect(row.slug).toBe("salesforce-knowledge");
    expect(row.id).toBe("catalog:salesforce-knowledge");
    expect(row.installModel).toBe("form");
    expect(row.autoInstall).toBe(false);
    const keys = row.configSchema.map((f) => f.key);
    expect(keys).toContain("channel");
    expect(keys).toContain("article_object");
    expect(keys).toContain("description");
    // The tier's credential-model departure: the connector reuses the
    // workspace's existing Salesforce OAuth install (catalog:salesforce), so
    // this row collects NO secret and NO endpoint — zero secret fields.
    expect(row.configSchema.filter((f) => f.secret === true)).toEqual([]);
    expect(keys).not.toContain("api_token");
    expect(keys).not.toContain("base_url");
    // Every field is optional — an empty form installs the Knowledge__kav
    // default scope.
    expect(row.configSchema.filter((f) => f.required === true)).toEqual([]);
  });
});

describe("BUILTIN_INTERCOM_CATALOG_ROW (#4399)", () => {
  it("is the `intercom` form install: a required secret access_token + optional description, NO base URL", () => {
    const row = BUILTIN_INTERCOM_CATALOG_ROW;
    expect(row.slug).toBe("intercom");
    expect(row.id).toBe("catalog:intercom");
    expect(row.installModel).toBe("form");
    expect(row.autoInstall).toBe(false);
    const keys = row.configSchema.map((f) => f.key);
    expect(keys).toContain("access_token");
    expect(keys).toContain("description");
    // The access token is the only secret; the API host is a fixed vendor
    // constant, so there is no free-form base-URL field.
    expect(row.configSchema.find((f) => f.key === "access_token")?.secret).toBe(true);
    expect(row.configSchema.find((f) => f.key === "access_token")?.required).toBe(true);
    expect(keys).not.toContain("base_url");
    expect(keys).not.toContain("subdomain");
  });
});

describe("BUILTIN_FRONT_CATALOG_ROW (#4400)", () => {
  it("is the `front` form install: a single secret Bearer token, NO base URL / KB field", () => {
    const row = BUILTIN_FRONT_CATALOG_ROW;
    expect(row.slug).toBe("front");
    expect(row.id).toBe("catalog:front");
    expect(row.installModel).toBe("form");
    expect(row.autoInstall).toBe(false);
    const keys = row.configSchema.map((f) => f.key);
    expect(keys).toContain("api_token");
    expect(keys).toContain("description");
    // Front's Core API is a fixed vendor host — no free-form URL field, and no
    // KB field: knowledge bases are enumerated at install time (one collection
    // per KB).
    expect(keys).not.toContain("base_url");
    expect(keys).not.toContain("knowledge_base_id");
    // Exactly one secret field: the API token (never echoed).
    expect(row.configSchema.filter((f) => f.secret === true).map((f) => f.key)).toEqual(["api_token"]);
    expect(row.configSchema.find((f) => f.key === "api_token")?.required).toBe(true);
  });
});

describe("BUILTIN_HELPSCOUT_CATALOG_ROW (#4398)", () => {
  it("is the `helpscout` form install: a single secret Docs API key, NO host/subdomain", () => {
    const row = BUILTIN_HELPSCOUT_CATALOG_ROW;
    expect(row.slug).toBe("helpscout");
    expect(row.id).toBe("catalog:helpscout");
    expect(row.installModel).toBe("form");
    expect(row.autoInstall).toBe(false);
    const keys = row.configSchema.map((f) => f.key);
    expect(keys).toContain("api_key");
    expect(keys).toContain("description");
    // Fixed vendor host + auto-discovered sites — no free-form URL, no subdomain
    // field, no email (a single Docs API key is the whole credential).
    expect(keys).not.toContain("base_url");
    expect(keys).not.toContain("subdomain");
    expect(keys).not.toContain("email");
    // Exactly one secret field: the Docs API key (never echoed).
    expect(row.configSchema.filter((f) => f.secret === true).map((f) => f.key)).toEqual([
      "api_key",
    ]);
    expect(row.configSchema.find((f) => f.key === "api_key")?.required).toBe(true);
  });
});

describe("BUILTIN_FRESHDESK_CATALOG_ROW (#4401)", () => {
  it("is the `freshdesk` form install: a subdomain + a single secret API key, NO base URL", () => {
    const row = BUILTIN_FRESHDESK_CATALOG_ROW;
    expect(row.slug).toBe("freshdesk");
    expect(row.id).toBe("catalog:freshdesk");
    expect(row.installModel).toBe("form");
    expect(row.autoInstall).toBe(false);
    const keys = row.configSchema.map((f) => f.key);
    expect(keys).toContain("subdomain");
    expect(keys).toContain("api_key");
    expect(keys).toContain("description");
    // Hosts are composed from the subdomain label (`*.freshdesk.com`) — no
    // free-form URL field, and no category field: categories are enumerated at
    // install time (one collection per category).
    expect(keys).not.toContain("base_url");
    expect(keys).not.toContain("category_id");
    // Exactly one secret field: the API key (never echoed).
    expect(row.configSchema.filter((f) => f.secret === true).map((f) => f.key)).toEqual(["api_key"]);
    expect(row.configSchema.find((f) => f.key === "api_key")?.required).toBe(true);
    expect(row.configSchema.find((f) => f.key === "subdomain")?.required).toBe(true);
  });
});

/**
 * #5082 — the constant/migration agreement pin for the two Company Atlas
 * ingest rows.
 *
 * The seeder is insert-only (`ON CONFLICT DO NOTHING`), so the constants above
 * describe only the shape a row is BORN with. Renaming a row that already
 * exists in a region takes migration
 * `0201_brain_catalog_rows_company_atlas.sql`, and the failure mode this pin
 * exists to catch is silent: edit the constant, forget the migration, and new
 * installs diverge from every existing region with nothing reporting it.
 *
 * The pin reads the migration OFF DISK and compares it to the constants — the
 * two are never hand-written to agree here. The pre-rename strings come from
 * `brain-catalog-rename-fixtures.ts`, which is the ONE derivation in the tree
 * and is shared with `brain-catalog-rename-pg.test.ts` so the pin and the
 * behavioural fixture can never drift apart.
 *
 * ⚠️ WHAT THIS BLOCK CANNOT SEE: direction. It asserts that both the old and
 * the new literals appear in the file, so a migration with `WHEN`/`THEN`
 * swapped — renaming Atlas back to Brain — contains both and passes every
 * assertion here. `brain-catalog-rename-pg.test.ts` owns direction, by running
 * the statements.
 *
 * The derivation is specific to migration 0201: a FUTURE rename must add its
 * own migration and re-point this block at it, and the failure it causes here
 * is the intended alarm, not collateral damage.
 */
describe("Company Atlas ingest rows ↔ migration 0201 (#5082, ADR-0038)", () => {
  const MIGRATION_FILE = readFileSync(
    join(import.meta.dir, "..", "migrations", "0201_brain_catalog_rows_company_atlas.sql"),
    "utf8",
  );

  /**
   * The migration with its `--` comments removed.
   *
   * Every assertion below is `toContain` over text, and 0201 carries a long
   * prose header discussing the strings it rewrites. Asserting against the raw
   * file would let a header comment satisfy the pin over broken or absent SQL —
   * and would red the "no other catalog id" check the moment a comment
   * legitimately names one. Strip the prose; assert on the statements.
   *
   * Shared with `assertPinnedToMigration` rather than reimplemented, because
   * this exact stripping already drifted once: it was added here and NOT to
   * the guard in the fixtures module, which is the same loophole one file over.
   */
  const MIGRATION_SQL = stripSqlComments(MIGRATION_FILE);

  for (const { label, row, oldName, oldDescription } of RENAME_PAIRS) {
    describe(label, () => {
      it("writes exactly the constant's name and description", () => {
        // The NEW half. If the constant is edited without the migration, these
        // literals are absent from the SQL and this fails — which is the whole
        // point of the pin. `sqlLiteral` doubles any apostrophe, so a copy
        // string that gains one does not read as a migration typo.
        expect(MIGRATION_SQL).toContain(sqlLiteral(row.name));
        expect(MIGRATION_SQL).toContain(sqlLiteral(row.description));
      });

      it("matches on the pre-rename strings, so a hand-edited row is left alone", () => {
        // The OLD half — what the three prod regions actually hold. Derived,
        // not transcribed. The two `not.toBe`s are what stop a future rename
        // from making the derivation the identity and this pin vacuous.
        expect(oldName).not.toBe(row.name);
        expect(oldDescription).not.toBe(row.description);
        expect(MIGRATION_SQL).toContain(sqlLiteral(oldName));
        expect(MIGRATION_SQL).toContain(sqlLiteral(oldDescription));
      });

      it("is keyed on the stable catalog id", () => {
        expect(MIGRATION_SQL).toContain(`WHERE id = ${sqlLiteral(row.id)}`);
      });

      it("no longer says 'Company Brain' or 'company brain' in the constant", () => {
        // ADR-0038 governs product copy, and both of these are customer-read
        // strings on `/admin/knowledge`.
        expect(row.name).not.toContain("Company Brain");
        expect(row.description).not.toContain("company brain");
        expect(row.description).not.toContain("Company Brain");
      });
    });
  }

  it("touches exactly the two Company Atlas rows and no other catalog id", () => {
    // Negative: a WHERE clause that reached another built-in row would rewrite
    // a vendor connector's copy. Every `WHERE id =` in the statements must name
    // one of the two.
    //
    // A SET, not a list — each row is now referenced three times per statement
    // block (the eligibility pre-count, the UPDATE, and the residue check), and
    // pinning the COUNT would make this test about the breadcrumb's internal
    // shape rather than about which rows the migration can reach.
    //
    // This proves WHICH ids are targeted, not what is done to them — the
    // statement-kind assertion below covers that, and the per-row foreign-id
    // decoys in `brain-catalog-rename-pg.test.ts` cover scoping behaviourally,
    // which is the only place a widened `WHERE … OR name = …` is visible.
    const targeted = new Set(
      [...MIGRATION_SQL.matchAll(/WHERE id = '([^']+)'/g)].map((m) => m[1]),
    );
    expect([...targeted].sort()).toEqual(
      [BUILTIN_OUTLOOK_MAIL_CATALOG_ROW.id, BUILTIN_ZOOM_TRANSCRIPTS_CATALOG_ROW.id].sort(),
    );
  });

  it("writes plugin_catalog with exactly two UPDATEs and nothing destructive", () => {
    // The id list above is satisfied just as well by
    // `DELETE FROM plugin_catalog WHERE id = 'catalog:zoom-transcripts'`, which
    // would drop the row and cascade its installs. Pin the statement KIND too.
    //
    // Matched on word boundaries rather than a whole line, so reflowing the SQL
    // (`UPDATE plugin_catalog SET` on one line) does not red a test whose
    // subject is statement kind rather than formatting.
    expect(MIGRATION_SQL.match(/\bUPDATE\s+plugin_catalog\b/gi)).toHaveLength(2);
    // Case-insensitive and word-bounded, and scoped to the verb ACTING ON this
    // table — the migration's `RAISE NOTICE` prose lives inside the statements
    // now, so a blanket keyword scan over the whole text would red on an
    // innocuous message that happened to contain one of these words.
    for (const verb of ["DELETE\\s+FROM", "INSERT\\s+INTO", "ALTER\\s+TABLE", "TRUNCATE", "DROP"]) {
      expect(MIGRATION_SQL).not.toMatch(new RegExp(`\\b${verb}\\s+(?:\\w+\\.)?plugin_catalog\\b`, "i"));
    }
  });

  it("leaves every OTHER built-in row's copy out of the migration entirely", () => {
    for (const other of BUILTIN_KNOWLEDGE_CATALOG_ROWS) {
      if (
        other.id === BUILTIN_ZOOM_TRANSCRIPTS_CATALOG_ROW.id ||
        other.id === BUILTIN_OUTLOOK_MAIL_CATALOG_ROW.id
      ) {
        continue;
      }
      expect(MIGRATION_SQL).not.toContain(other.id);
      expect(MIGRATION_SQL).not.toContain(sqlLiteral(other.name));
    }
  });
});

/**
 * #5082 — the COPY LOCK, and the reason it is not scoped to the two rows above.
 *
 * The rule #5082 writes into CONTEXT.md is general: *changing a field on a
 * built-in catalog row that regions already hold takes a migration*, because
 * `ON CONFLICT DO NOTHING` means a constant edit renames nothing that exists.
 * That rule applied to all fourteen rows all along; only two of them had the
 * defect noticed. Every per-row `describe` above asserts `slug`/`id`/
 * `installModel`/`configSchema` and none of them asserted `name` or
 * `description` — so today someone can edit any other row's copy, ship it, and
 * fork the label across three regions with no signal at all.
 *
 * Pinning only Zoom and Outlook would fix the two instances and leave the
 * class open, so this snapshot covers the whole list. Editing any row's copy
 * reds CI and forces the author to choose: write the migration, or bump this
 * snapshot deliberately because the row is not yet in any region.
 *
 * ⚠️ THIS IS NOT A "DON'T CHANGE COPY" GATE. Bumping it is fine and expected —
 * what it removes is doing so *without noticing*.
 */
describe("built-in catalog copy lock (#5082)", () => {
  it("pins the frozen fields for EVERY built-in row", () => {
    // ⚠️ ALL FOURTEEN ROWS ARE LITERALS, INCLUDING ZOOM AND OUTLOOK. An earlier
    // draft interpolated those two from the very constants the left-hand side
    // maps over, which made exactly the two rows this issue is about compare to
    // themselves. Measured: renaming the Zoom constant AND retro-editing 0201
    // to match passed the whole suite — #5082's defect verbatim, since regions
    // that already applied 0201 keep the old string and no new migration
    //
    // Fields: `name`/`description` are the customer-read copy; `saasEligible`
    // and `autoInstall` are frozen by the same `ON CONFLICT DO NOTHING` and
    // flipping either on an existing row diverges three regions just as
    // silently. An object array rather than a joined string, so the failure
    // diff names the field that moved.
    const frozen = BUILTIN_KNOWLEDGE_CATALOG_ROWS.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      saasEligible: r.saasEligible,
      autoInstall: r.autoInstall,
    }));
    expect(frozen).toEqual([
      {"id":"catalog:okf-upload","name":"Knowledge Base (Upload)","description":"Upload an Open Knowledge Format bundle as a review-gated knowledge collection.","saasEligible":true,"autoInstall":false},
      {"id":"catalog:bundle-sync","name":"Knowledge Base (Bundle Sync)","description":"Point a knowledge collection at an endpoint serving your bundle (tarball/zip, incl. git-forge archive URLs); Atlas pulls it on a schedule and queues changes for review.","saasEligible":true,"autoInstall":false},
      {"id":"catalog:notion-knowledge","name":"Knowledge Base (Notion)","description":"Connect a Notion workspace with an internal-integration token; the pages you share with the integration sync as review-gated knowledge documents. Share a parent page to include its whole subtree.","saasEligible":true,"autoInstall":false},
      {"id":"catalog:confluence","name":"Knowledge Base (Confluence Cloud)","description":"Mirror a Confluence Cloud space into a review-gated knowledge collection; Atlas syncs pages on a schedule (incremental + reconciliation) and queues changes for review.","saasEligible":true,"autoInstall":false},
      {"id":"catalog:confluence-datacenter","name":"Knowledge Base (Confluence Data Center)","description":"Mirror a self-managed Confluence Data Center/Server space into a review-gated knowledge collection; Atlas syncs pages on a schedule (incremental + reconciliation) and queues changes for review.","saasEligible":true,"autoInstall":false},
      {"id":"catalog:gitbook","name":"Knowledge Base (GitBook)","description":"Mirror a GitBook Cloud space into a review-gated knowledge collection; Atlas syncs pages on a schedule (incremental + reconciliation) and queues changes for review.","saasEligible":true,"autoInstall":false},
      {"id":"catalog:zendesk","name":"Knowledge Base (Zendesk Guide)","description":"Mirror your Zendesk Guide help center into review-gated knowledge collections (one per brand); Atlas syncs published articles on a schedule (incremental + reconciliation) and queues changes for review.","saasEligible":true,"autoInstall":false},
      {"id":"catalog:salesforce-knowledge","name":"Knowledge Base (Salesforce Knowledge)","description":"Mirror your Salesforce Knowledge articles into a review-gated knowledge collection using the workspace's existing Salesforce connection — no extra credentials; Atlas syncs published articles on a schedule (incremental + reconciliation) and queues changes for review.","saasEligible":true,"autoInstall":false},
      {"id":"catalog:intercom","name":"Knowledge Base (Intercom)","description":"Mirror your Intercom help center's published articles (all locales) into a review-gated knowledge collection; Atlas syncs on a schedule and queues changes for review.","saasEligible":true,"autoInstall":false},
      {"id":"catalog:front","name":"Knowledge Base (Front)","description":"Mirror your Front knowledge bases into review-gated knowledge collections (one per knowledge base); Atlas syncs published articles and their locale translations on a schedule and queues changes for review.","saasEligible":true,"autoInstall":false},
      {"id":"catalog:helpscout","name":"Knowledge Base (Help Scout Docs)","description":"Mirror your Help Scout Docs help center into review-gated knowledge collections (one per site); Atlas syncs published articles on a schedule (incremental + reconciliation) and queues changes for review.","saasEligible":true,"autoInstall":false},
      {"id":"catalog:freshdesk","name":"Knowledge Base (Freshdesk Solutions)","description":"Mirror your Freshdesk Solutions help center into review-gated knowledge collections (one per category); Atlas syncs published articles and their language translations on a schedule and queues changes for review.","saasEligible":true,"autoInstall":false},
      {"id":"catalog:zoom-transcripts","name":"Company Atlas (Zoom transcripts)","description":"Read cloud-recording transcripts from Zoom into the Company Atlas as immutable, deduped episodes. Each meeting is granted only to the people who attended it — a meeting whose participant list cannot be read is skipped rather than ingested. Episodes are raw evidence; the claims drawn from them go through review before anything becomes an authoritative fact.","saasEligible":true,"autoInstall":false},
      {"id":"catalog:outlook-mail","name":"Company Atlas (Outlook mail)","description":"Read selected Outlook mailboxes into the Company Atlas as immutable, deduped episodes. Each message is granted only to the people named in its From, To and Cc headers — blind-copied and forwarded-to recipients are deliberately NOT granted, so access is a lower bound on who saw the mail rather than a guess. Episodes are raw evidence; the claims drawn from them go through review before anything becomes an authoritative fact.","saasEligible":true,"autoInstall":false},
    ]);
  });

  it("pins the config_schema helper text on both Company Atlas rows (#5240)", () => {
    // #5082's own sibling, one field over in the SAME object literal.
    // `config_schema` is seeded as JSONB under the identical conflict target,
    // and this string renders as helper text on the install form, so it is a
    // STORED, CUSTOMER-READ string and ADR-0038 governs it. It was a recorded
    // exemption until #5240; the rename now lives in migration 0203 and the
    // block below pins the constant to what that migration writes.
    //
    // Kept as a LITERAL here for the same reason the copy lock above is: an
    // assertion derived from the constants it is locking compares them to
    // themselves.
    for (const row of [BUILTIN_ZOOM_TRANSCRIPTS_CATALOG_ROW, BUILTIN_OUTLOOK_MAIL_CATALOG_ROW]) {
      const descriptionField = row.configSchema.find((f) => f.key === "description");
      expect(descriptionField?.description).toBe(
        "Optional. A human description of this Company Atlas source.",
      );
    }
  });

  it("leaves NO customer-read 'brain' noun anywhere in either row's config_schema", () => {
    // The class, not the instance. #5240 renamed the one field anybody had
    // noticed; every label and help string on these two rows is rendered on the
    // install form, so a second one carrying the old noun is the same defect
    // with a different key. Names and descriptions are covered by the copy lock
    // above; this covers the JSONB.
    for (const row of [BUILTIN_ZOOM_TRANSCRIPTS_CATALOG_ROW, BUILTIN_OUTLOOK_MAIL_CATALOG_ROW]) {
      for (const field of row.configSchema) {
        // ⚠️ `options` too, not just label/description. Neither of these rows
        // has a `select` field today, so this arm is latent — but the test's
        // name says "anywhere in either row's config_schema", and a sweep that
        // walks two of the three customer-read string positions is the kind of
        // near-miss that lets the next one through.
        const optionLabels = (field.options ?? []).map((o) =>
          typeof o === "string" ? o : o.label,
        );
        for (const text of [field.label, field.description, ...optionLabels]) {
          expect(text?.toLowerCase() ?? "").not.toContain("brain");
        }
      }
    }
  });
});

/**
 * #5240 — the constant/migration agreement pin for the `config_schema` helper
 * text, the direct counterpart of the 0201 block above.
 *
 * Same failure mode, same remedy: the seeder is insert-only, so editing the
 * constant alone gives new installs the new helper text and leaves all three
 * prod regions on "this brain source" with nothing reporting the divergence.
 * The pre-rename string is DERIVED in `brain-catalog-rename-fixtures.ts`, never
 * transcribed here.
 *
 * ⚠️ WHAT THIS BLOCK CANNOT SEE, exactly as the 0201 pin cannot: direction, and
 * whether the statement actually rewrites anything. Both literals appearing in
 * the file is satisfied by a migration with its `WHEN`/`THEN` swapped.
 * `brain-config-help-rename-pg.test.ts` owns behaviour, by running it.
 */
describe("Company Atlas config_schema help ↔ migration 0203 (#5240, ADR-0038)", () => {
  const MIGRATION_SQL = stripSqlComments(
    readFileSync(
      join(import.meta.dir, "..", "migrations", "0203_brain_catalog_config_help_company_atlas.sql"),
      "utf8",
    ),
  );

  for (const { label, row, help, oldHelp } of CONFIG_HELP_PAIRS) {
    describe(label, () => {
      it("writes exactly the constant's helper text", () => {
        expect(MIGRATION_SQL).toContain(sqlLiteral(help));
      });

      it("matches on the pre-rename helper text, so an operator's own wording is left alone", () => {
        expect(oldHelp).not.toBe(help);
        expect(MIGRATION_SQL).toContain(sqlLiteral(oldHelp));
      });

      it("is keyed on the stable catalog id", () => {
        expect(MIGRATION_SQL).toContain(`WHERE id = ${sqlLiteral(row.id)}`);
      });
    });
  }

  it("touches exactly the two Company Atlas rows and no other catalog id", () => {
    const targeted = new Set([...MIGRATION_SQL.matchAll(/WHERE id = '([^']+)'/g)].map((m) => m[1]));
    expect([...targeted].sort()).toEqual(
      [BUILTIN_OUTLOOK_MAIL_CATALOG_ROW.id, BUILTIN_ZOOM_TRANSCRIPTS_CATALOG_ROW.id].sort(),
    );
  });

  it("writes plugin_catalog with exactly two UPDATEs and nothing destructive", () => {
    // The id list is satisfied just as well by a DELETE, which would drop the
    // row and cascade its installs. Pin the statement KIND too.
    expect(MIGRATION_SQL.match(/\bUPDATE\s+plugin_catalog\b/gi)).toHaveLength(2);
    for (const verb of ["DELETE\\s+FROM", "INSERT\\s+INTO", "ALTER\\s+TABLE", "TRUNCATE", "DROP"]) {
      expect(MIGRATION_SQL).not.toMatch(
        new RegExp(`\\b${verb}\\s+(?:\\w+\\.)?plugin_catalog\\b`, "i"),
      );
    }
  });

  it("rebuilds the array element-wise rather than round-tripping config_schema through text", () => {
    // The statement shape #5240 exists to avoid: a `config_schema::text` +
    // `replace()` REWRITE is unanchored (JSONB normalises key order and
    // whitespace on storage) and would hit the phrase wherever else it
    // appeared. `replace(` is the tell, and it appears nowhere.
    expect(MIGRATION_SQL).not.toMatch(/\breplace\s*\(/i);
    expect(MIGRATION_SQL).toContain("jsonb_agg");
    expect(MIGRATION_SQL).toContain("jsonb_set");
    // ⚠️ THE `::text` CAST IS PERMITTED, AND ONLY OUTSIDE A `SET`. Detection is
    // a whole-value text scan on purpose — it writes nothing, so JSONB's
    // normalisation cannot corrupt anything, and gating the DETECTOR on
    // `jsonb_typeof = 'array'` (as the rewrite must be) left an operator's
    // non-array schema unreported while the NOTICE claimed it was already
    // renamed. So: assert no cast reaches an assignment, rather than banning
    // the cast outright.
    // ⚠️ HOISTED AND COUNTED FIRST. As an inline `?? []`, any reflow that moved
    // `updated_at = now()` would turn this guard into a loop over nothing while
    // still reading green — a guard that stops running looks exactly like a
    // guard that found nothing.
    const setClauses = MIGRATION_SQL.match(/SET config_schema =[\s\S]*?updated_at = now\(\)/g) ?? [];
    expect(setClauses).toHaveLength(2);
    for (const setClause of setClauses) {
      expect(setClause).not.toMatch(/config_schema\s*::\s*text/i);
    }
    // ⚠️ THIS IS THE ONLY GUARD ON FIELD ORDER. Measured: deleting
    // `ORDER BY f.ord` leaves the real-Postgres suite entirely green, because
    // `WITH ORDINALITY` already emits in order and `jsonb_agg` follows its
    // input. Aggregate input order is not contractual, so the clause stays —
    // but a behavioural test cannot be the thing that keeps it.
    expect(MIGRATION_SQL).toContain("WITH ORDINALITY");
    expect(MIGRATION_SQL).toMatch(/ORDER BY\s+f\.ord/i);
  });

  it("scopes the rewrite to the field with key 'description' at every site", () => {
    // Without the key predicate the guard is "any field whose help is exactly
    // this string", which is the same rewrite by a looser route.
    //
    // ⚠️ AN EXACT COUNT, not `not.toHaveLength(0)`. The predicate appears twice
    // per DO block — the `CASE WHEN` arm and the `UPDATE … WHERE EXISTS` — and
    // a "greater than zero" assertion survives deleting it from three of the
    // four sites. The behavioural twin-key case covers the `CASE` arm; this
    // covers the rest.
    expect(MIGRATION_SQL.match(/f\.field->>'key'\s*=\s*'description'/g)).toHaveLength(4);
  });

  it("leaves every OTHER built-in row's copy out of the migration entirely", () => {
    for (const other of BUILTIN_KNOWLEDGE_CATALOG_ROWS) {
      if (
        other.id === BUILTIN_ZOOM_TRANSCRIPTS_CATALOG_ROW.id ||
        other.id === BUILTIN_OUTLOOK_MAIL_CATALOG_ROW.id
      ) {
        continue;
      }
      expect(MIGRATION_SQL).not.toContain(other.id);
    }
  });
});

/**
 * ⚠️ THE RATCHET (`/review-panel` Step 5b): a principle swept for TWICE becomes
 * a check, not a third comment.
 *
 * `fix-vs-finding` returned REPRODUCED twice in one round, on the same
 * principle and in the same half of the sentence both times — an operator
 * message whose DIAGNOSIS was correctly hedged and whose REMEDY then asserted
 * the hedged inference as an instruction:
 *
 *  1. the seeder's blocked-row warning admitted the collision might not be the
 *     slug, then told the operator to go look the row up BY SLUG;
 *  2. migration 0203's squatter warning told the operator to re-seed and then
 *     stated flatly that a follow-up migration would be needed — true only if
 *     the re-seed is done by a pre-#5240 image, which it had not established.
 *
 * Prose does not scale to the next message, and the next message is where this
 * keeps happening. So: every operator-facing string in this change that
 * prescribes an ACTION must also carry a CONDITION.
 *
 * This is a lexical guard, and lexical guards cannot tell a quotation from an
 * assertion — hence the negative control below, which is the half that catches
 * a matcher too broad to mean anything.
 */
describe("operator-facing remedies are conditioned, not asserted (#5239/#5240 ratchet)", () => {
  /**
   * Words that mark a claim as contingent rather than flat.
   *
   * ⚠️ MATCHES THE CONCEPT, NOT THE SENTENCE THAT PROMPTED IT. The first draft
   * listed the literal phrasings in the messages at the time (`only one case`,
   * `two causes`), and rewording a WARNING from "TWO causes" to "THREE cases,
   * and only the last is a defect" — strictly better prose, still conditioned —
   * tripped the guard. A matcher pinned to a historical sentence walks past
   * every natural reword, which is how a guard reads green over a live
   * instance; the negative control below is what keeps the widening honest.
   */
  const CONDITION_MARKERS =
    /\b(if|unless|depends on|whether|either|only (one|the last|that)|(two|three|four) (causes|cases))\b/i;
  /** Prose that tells an operator to go and do something. */
  const PRESCRIBES_ACTION = /\b(rename or remove|find the (conflicting )?holder|find the conflicting row|needs a follow-up migration|then re-seed|look up the column)\b/i;

  const unconditionedRemedy = (message: string): boolean =>
    PRESCRIBES_ACTION.test(message) && !CONDITION_MARKERS.test(message);

  /**
   * Every `RAISE NOTICE`/`RAISE WARNING` literal in 0203.
   *
   * ⚠️ Read here rather than reusing the `MIGRATION_SQL` above — that one is
   * scoped to its own `describe`, and referencing it from this block threw a
   * `ReferenceError` that bun reported as "1 error" while still printing
   * "45 pass, 0 fail". A guard that does not run looks exactly like a guard
   * that found nothing.
   */
  const MIGRATION_TEXT = stripSqlComments(
    readFileSync(
      join(import.meta.dir, "..", "migrations", "0203_brain_catalog_config_help_company_atlas.sql"),
      "utf8",
    ),
  );
  const raiseMessages = [
    ...MIGRATION_TEXT.matchAll(/RAISE\s+(?:NOTICE|WARNING)\s+'((?:[^']|'')*)'/gi),
  ].map((m) => (m[1] ?? "").replaceAll("''", "'"));

  it("finds every RAISE message in the migration (the scan is not vacuous)", () => {
    // Two NOTICEs + two squatter WARNINGs + two residue WARNINGs.
    expect(raiseMessages).toHaveLength(6);
  });

  it("no RAISE message prescribes an action without a condition", () => {
    expect(raiseMessages.filter(unconditionedRemedy)).toEqual([]);
  });

  it("no seeder warning prescribes an action without a condition", () => {
    // Read off the source rather than re-typed, so the guard follows the string
    // it is guarding.
    const seederSource = readFileSync(
      join(import.meta.dir, "..", "seed-builtin-knowledge-catalog.ts"),
      "utf8",
    );
    const logMessages = [...seederSource.matchAll(/"(Built-in Knowledge Base catalog[^"]*)"/g)].map(
      (m) => m[1]!,
    );
    expect(logMessages.length).toBeGreaterThanOrEqual(2);
    expect(logMessages.filter(unconditionedRemedy)).toEqual([]);
  });

  it("⭐ the matcher can actually fail — positive AND negative controls", () => {
    // POSITIVE control: the exact shape both REPRODUCED findings had. If this
    // stops being flagged, the guard above has gone blind and every assertion
    // in this block is decoration.
    expect(
      unconditionedRemedy(
        "Rename or remove the conflicting row, then re-seed; the helper text will need a follow-up migration.",
      ),
    ).toBe(true);
    // NEGATIVE control: legitimate conditioned prose must NOT trip it. Without
    // this, a matcher broad enough to flag everything would pass the two
    // assertions above by flagging nothing real — both sides hand-written by
    // the same author is exactly how a guard certifies itself.
    expect(
      unconditionedRemedy(
        "If `constraint` names the slug index, rename or remove the conflicting row; otherwise look up the column that constraint covers.",
      ),
    ).toBe(false);
    // And a message with no remedy at all is not the guard's business.
    expect(unconditionedRemedy("present=1, config_schema helper text rewritten=1.")).toBe(false);
  });
});

describe("seedBuiltinKnowledgeCatalog (idempotent boot seed)", () => {
  it("issues one INSERT per built-in row with type 'context' and pillar 'knowledge'", async () => {
    const { db, captured } = captureDb();
    await seedBuiltinKnowledgeCatalog(db);
    expect(captured).toHaveLength(BUILTIN_KNOWLEDGE_CATALOG_ROWS.length);
    for (const q of captured) {
      expect(q.sql).toContain("INSERT INTO plugin_catalog");
      expect(q.sql).toContain("'context'");
      expect(q.sql).toContain("'knowledge'");
      // ⚠️ QUALIFIED on the PK (#5239). An unqualified target also swallows a
      // conflict on the `slug` unique index, which reports plain success for a
      // built-in row that does not exist under its canonical id and never will.
      // `(id)` makes that case a 23505 the loop reports instead — see
      // `seed-builtin-knowledge-catalog-collision.test.ts`.
      expect(q.sql).toContain("ON CONFLICT (id) DO NOTHING");
      expect(q.sql).not.toContain("ON CONFLICT (slug)");
      expect(q.sql).not.toMatch(/ON CONFLICT\s+DO NOTHING/);
      expect(q.sql).toContain("RETURNING slug");
    }
    expect(captured.map((q) => q.params[2])).toEqual([
      "okf-upload",
      "bundle-sync",
      "notion-knowledge",
      "confluence",
      "confluence-datacenter",
      "gitbook",
      "zendesk",
      "salesforce-knowledge",
      "intercom",
      "front",
      "helpscout",
      "freshdesk",
      // ⚠️ NO `slack-history` (#5203). It was here through #4770 and its absence
      // is the assertion: the seeder is insert-only over a hard-coded list, so a
      // row re-added there would re-create `catalog:slack-history` on the next
      // boot — the exact catalog row migration 0198 deletes, backing an install
      // form that no longer exists.
      "zoom-transcripts",
      "outlook-mail",
    ]);
  });

  it("binds each row's 8 params and serializes config_schema as JSON", async () => {
    const { db, captured } = captureDb();
    await seedBuiltinKnowledgeCatalog(db);
    captured.forEach((q, i) => {
      expect(q.params).toHaveLength(8);
      const configParam = q.params[7];
      expect(typeof configParam).toBe("string");
      expect(JSON.parse(configParam as string)).toEqual(
        BUILTIN_KNOWLEDGE_CATALOG_ROWS[i]!.configSchema,
      );
    });
  });

  it("reports inserted slugs on a fresh catalog and none on a re-boot", async () => {
    const fresh = await seedBuiltinKnowledgeCatalog(captureDb().db);
    expect(fresh.inserted).toBe(true);
    expect(fresh.insertedSlugs).toEqual([
      "okf-upload",
      "bundle-sync",
      "notion-knowledge",
      "confluence",
      "confluence-datacenter",
      "gitbook",
      "zendesk",
      "salesforce-knowledge",
      "intercom",
      "front",
      "helpscout",
      "freshdesk",
      "zoom-transcripts",
      "outlook-mail",
    ]);
    // Nothing was blocked on either pass — with the target qualified on `(id)`
    // a blocked row raises rather than returning empty, so this is the
    // discriminator #5239 added: empty RETURNING now means present-and-correct
    // and nothing else.
    expect(fresh.blockedSlugs).toEqual([]);
    // Empty RETURNING = rows already existed (ON CONFLICT (id) DO NOTHING path).
    const reboot = await seedBuiltinKnowledgeCatalog(captureDb(false).db);
    expect(reboot.inserted).toBe(false);
    expect(reboot.insertedSlugs).toEqual([]);
    expect(reboot.blockedSlugs).toEqual([]);
  });

  it("propagates DB errors instead of swallowing them", async () => {
    const failing: BuiltinKnowledgeCatalogSeedDb = {
      async query() {
        throw new Error("simulated pg error");
      },
    };
    await expect(seedBuiltinKnowledgeCatalog(failing)).rejects.toThrow(
      /simulated pg error/,
    );
  });
});

describe("runBuiltinKnowledgeCatalogSeedBoot (discriminated outcomes)", () => {
  const mockQuery = mock<
    (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>
  >(() => Promise.resolve({ rows: [{ slug: "okf-upload" }] }));

  let hasInternalDBReturns = true;

  void mock.module("@atlas/api/lib/db/internal", () => ({
    hasInternalDB: () => hasInternalDBReturns,
    getInternalDB: () => ({ query: mockQuery }),
    _resetEncryptionKeyCache: () => {},
  }));

  afterEach(() => {
    mockQuery.mockClear();
    hasInternalDBReturns = true;
  });

  it("returns `{ kind: 'skipped' }` when no internal DB is configured", async () => {
    hasInternalDBReturns = false;
    const { runBuiltinKnowledgeCatalogSeedBoot } = await import(
      "@atlas/api/lib/db/seed-builtin-knowledge-catalog"
    );
    const result = await runBuiltinKnowledgeCatalogSeedBoot();
    expect(result.kind).toBe("skipped");
    if (result.kind === "skipped") expect(result.reason).toBe("no-internal-db");
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("returns `{ kind: 'seeded', inserted: true }` on a successful insert", async () => {
    hasInternalDBReturns = true;
    mockQuery.mockImplementation(() =>
      Promise.resolve({ rows: [{ slug: "okf-upload" }] }),
    );
    const { runBuiltinKnowledgeCatalogSeedBoot } = await import(
      "@atlas/api/lib/db/seed-builtin-knowledge-catalog"
    );
    const result = await runBuiltinKnowledgeCatalogSeedBoot();
    expect(result.kind).toBe("seeded");
    if (result.kind === "seeded") {
      expect(result.inserted).toBe(true);
      // `seeded` no longer implies "every row is in the catalog" — it carries
      // what was blocked (#5239). Nothing is, here.
      expect(result.blockedSlugs).toEqual([]);
    }
  });

  it("⭐ forwards a NON-EMPTY blockedSlugs across the boot seam", async () => {
    // Without this, `blockedSlugs: result.blockedSlugs` in the boot wrapper can
    // be hard-coded to `[]` and the whole suite stays green — measured. The
    // happy-path case above pins the empty value, which is the value a broken
    // forward produces.
    hasInternalDBReturns = true;
    mockQuery.mockImplementation((_sql: string, params?: unknown[]) => {
      if (params?.[2] === "gitbook") {
        return Promise.reject(
          Object.assign(new Error("duplicate key value violates unique constraint"), {
            code: "23505",
            constraint: "plugin_catalog_slug_key",
          }),
        );
      }
      return Promise.resolve({ rows: [{ slug: params?.[2] }] });
    });
    const { runBuiltinKnowledgeCatalogSeedBoot } = await import(
      "@atlas/api/lib/db/seed-builtin-knowledge-catalog"
    );
    const result = await runBuiltinKnowledgeCatalogSeedBoot();
    expect(result.kind).toBe("seeded");
    if (result.kind === "seeded") {
      expect(result.blockedSlugs).toEqual(["gitbook"]);
      // Still `inserted` — the other 13 rows landed. A boot result that
      // conflated "blocked something" with "inserted nothing" would be the
      // same overloading one layer up.
      expect(result.inserted).toBe(true);
    }
  });

  it("returns `{ kind: 'error' }` when the pool query throws", async () => {
    hasInternalDBReturns = true;
    mockQuery.mockImplementation(() =>
      Promise.reject(new Error("simulated pg failure")),
    );
    const { runBuiltinKnowledgeCatalogSeedBoot } = await import(
      "@atlas/api/lib/db/seed-builtin-knowledge-catalog"
    );
    const result = await runBuiltinKnowledgeCatalogSeedBoot();
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("simulated pg failure");
    }
  });
});
