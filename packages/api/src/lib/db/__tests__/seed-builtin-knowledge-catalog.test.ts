/**
 * Tests for the built-in Knowledge Base catalog seed pass (#4206, ADR-0028).
 *
 * Two surfaces under test:
 *
 *  1. `seedBuiltinKnowledgeCatalog(db)` — the runtime seeder. Asserts the
 *     built-in rows (`okf-upload` #4206, `bundle-sync` #4211) are inserted with
 *     `ON CONFLICT DO NOTHING` semantics through the operator-curated seam,
 *     with the ADR-0028 §5 shape (type `context`, pillar `knowledge`,
 *     install_model `form`).
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
import { RENAME_PAIRS } from "@atlas/api/lib/db/__tests__/brain-catalog-rename-fixtures";

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
 * the statements. Both files are needed; neither is redundant.
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
   * The migration with `--` comment lines removed.
   *
   * Every assertion below is `toContain` over text, and 0201 carries a ~60-line
   * prose header that quotes the strings it rewrites. Asserting against the raw
   * file would let a header comment satisfy the pin over broken or absent SQL —
   * and would red the "no other catalog id" check the moment a comment
   * legitimately names one. Strip the prose; assert on the statements.
   */
  const MIGRATION_SQL = MIGRATION_FILE.split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  for (const { label, row, oldName, oldDescription } of RENAME_PAIRS) {
    describe(label, () => {
      it("writes exactly the constant's name and description", () => {
        // The NEW half. If the constant is edited without the migration, these
        // literals are absent from the SQL and this fails — which is the whole
        // point of the pin.
        expect(MIGRATION_SQL).toContain(`'${row.name}'`);
        expect(MIGRATION_SQL).toContain(`'${row.description}'`);
      });

      it("matches on the pre-rename strings, so a hand-edited row is left alone", () => {
        // The OLD half — what the three prod regions actually hold. Derived,
        // not transcribed. The two `not.toBe`s are what stop a future rename
        // from making `preRename` the identity and this pin vacuous.
        expect(oldName).not.toBe(row.name);
        expect(oldDescription).not.toBe(row.description);
        expect(MIGRATION_SQL).toContain(`'${oldName}'`);
        expect(MIGRATION_SQL).toContain(`'${oldDescription}'`);
      });

      it("is keyed on the stable catalog id", () => {
        expect(MIGRATION_SQL).toContain(`WHERE id = '${row.id}'`);
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
    // one of the two. This proves WHICH ids are targeted, not what is done to
    // them — the statement-kind assertion below covers that, and the foreign-id
    // decoy in `brain-catalog-rename-pg.test.ts` covers scoping behaviourally.
    const targeted = [...MIGRATION_SQL.matchAll(/WHERE id = '([^']+)'/g)].map((m) => m[1]);
    expect(targeted.sort()).toEqual(
      [BUILTIN_OUTLOOK_MAIL_CATALOG_ROW.id, BUILTIN_ZOOM_TRANSCRIPTS_CATALOG_ROW.id].sort(),
    );
  });

  it("is exactly two UPDATEs and nothing destructive", () => {
    // The id list above is satisfied just as well by
    // `DELETE FROM plugin_catalog WHERE id = 'catalog:zoom-transcripts'`, which
    // would drop the row and cascade its installs. Pin the statement KIND too.
    expect(MIGRATION_SQL.match(/^\s*UPDATE plugin_catalog$/gm)?.length).toBe(2);
    for (const forbidden of ["DELETE", "INSERT", "ALTER", "TRUNCATE", "DROP"]) {
      expect(MIGRATION_SQL).not.toContain(forbidden);
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
      expect(MIGRATION_SQL).not.toContain(`'${other.name}'`);
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
  it("pins name + description for every built-in row", () => {
    const copy = BUILTIN_KNOWLEDGE_CATALOG_ROWS.map((r) => `${r.id}\t${r.name}\t${r.description}`);
    expect(copy).toEqual([
      "catalog:okf-upload\tKnowledge Base (Upload)\tUpload an Open Knowledge Format bundle as a review-gated knowledge collection.",
      "catalog:bundle-sync\tKnowledge Base (Bundle Sync)\tPoint a knowledge collection at an endpoint serving your bundle (tarball/zip, incl. git-forge archive URLs); Atlas pulls it on a schedule and queues changes for review.",
      "catalog:notion-knowledge\tKnowledge Base (Notion)\tConnect a Notion workspace with an internal-integration token; the pages you share with the integration sync as review-gated knowledge documents. Share a parent page to include its whole subtree.",
      "catalog:confluence\tKnowledge Base (Confluence Cloud)\tMirror a Confluence Cloud space into a review-gated knowledge collection; Atlas syncs pages on a schedule (incremental + reconciliation) and queues changes for review.",
      "catalog:confluence-datacenter\tKnowledge Base (Confluence Data Center)\tMirror a self-managed Confluence Data Center/Server space into a review-gated knowledge collection; Atlas syncs pages on a schedule (incremental + reconciliation) and queues changes for review.",
      "catalog:gitbook\tKnowledge Base (GitBook)\tMirror a GitBook Cloud space into a review-gated knowledge collection; Atlas syncs pages on a schedule (incremental + reconciliation) and queues changes for review.",
      "catalog:zendesk\tKnowledge Base (Zendesk Guide)\tMirror your Zendesk Guide help center into review-gated knowledge collections (one per brand); Atlas syncs published articles on a schedule (incremental + reconciliation) and queues changes for review.",
      "catalog:salesforce-knowledge\tKnowledge Base (Salesforce Knowledge)\tMirror your Salesforce Knowledge articles into a review-gated knowledge collection using the workspace's existing Salesforce connection — no extra credentials; Atlas syncs published articles on a schedule (incremental + reconciliation) and queues changes for review.",
      "catalog:intercom\tKnowledge Base (Intercom)\tMirror your Intercom help center's published articles (all locales) into a review-gated knowledge collection; Atlas syncs on a schedule and queues changes for review.",
      "catalog:front\tKnowledge Base (Front)\tMirror your Front knowledge bases into review-gated knowledge collections (one per knowledge base); Atlas syncs published articles and their locale translations on a schedule and queues changes for review.",
      "catalog:helpscout\tKnowledge Base (Help Scout Docs)\tMirror your Help Scout Docs help center into review-gated knowledge collections (one per site); Atlas syncs published articles on a schedule (incremental + reconciliation) and queues changes for review.",
      "catalog:freshdesk\tKnowledge Base (Freshdesk Solutions)\tMirror your Freshdesk Solutions help center into review-gated knowledge collections (one per category); Atlas syncs published articles and their language translations on a schedule and queues changes for review.",
      `catalog:zoom-transcripts\t${BUILTIN_ZOOM_TRANSCRIPTS_CATALOG_ROW.name}\t${BUILTIN_ZOOM_TRANSCRIPTS_CATALOG_ROW.description}`,
      `catalog:outlook-mail\t${BUILTIN_OUTLOOK_MAIL_CATALOG_ROW.name}\t${BUILTIN_OUTLOOK_MAIL_CATALOG_ROW.description}`,
    ]);
  });

  it("records the config_schema copy that still reads 'brain source' as a KNOWN exemption", () => {
    // #5082's own sibling, one field over in the SAME object literal — the
    // shape the repo keeps paying for. `config_schema` is seeded as JSONB under
    // the identical `ON CONFLICT DO NOTHING`, and this string is rendered as
    // helper text on the install form, so it is a STORED, CUSTOMER-READ string
    // that still says "brain". It is deliberately NOT renamed here: rewriting a
    // string inside a JSONB array needs a different and much less safe
    // statement than the two guarded column UPDATEs 0201 is, and that belongs
    // in its own change. Tracked as a follow-up; CONTEXT.md records it as an
    // exemption rather than claiming no stored string is left.
    //
    // This assertion exists so the next editor of that field gets a signal
    // instead of walking into #5082's failure mode a second time.
    for (const row of [BUILTIN_ZOOM_TRANSCRIPTS_CATALOG_ROW, BUILTIN_OUTLOOK_MAIL_CATALOG_ROW]) {
      const descriptionField = row.configSchema.find((f) => f.key === "description");
      expect(descriptionField?.description).toBe(
        "Optional. A human description of this brain source.",
      );
    }
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
      // Unqualified ON CONFLICT DO NOTHING covers both the slug unique index
      // AND the id PK (mirrors the datasource seed's edge-case handling).
      expect(q.sql).toContain("ON CONFLICT DO NOTHING");
      expect(q.sql).not.toContain("ON CONFLICT (slug)");
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
    // Empty RETURNING = rows already existed (ON CONFLICT DO NOTHING path).
    const reboot = await seedBuiltinKnowledgeCatalog(captureDb(false).db);
    expect(reboot.inserted).toBe(false);
    expect(reboot.insertedSlugs).toEqual([]);
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
    if (result.kind === "seeded") expect(result.inserted).toBe(true);
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
