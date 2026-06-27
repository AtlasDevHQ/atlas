/**
 * atlas-operator seed — seed durable workspace data into the tenant Postgres.
 *
 * Subcommands:
 *   prompts   Seed a prompt-library collection + items from a YAML file
 *             (replaces internal/seed-prompt-library.ts).
 *   workspace Provision a connection group, member connections, and the
 *             accompanying semantic entities for that group (replaces
 *             internal/setup-dogfood.ts).
 *
 * Both subcommands target the tenant Postgres at ATLAS_TEAM_PG_URL (falling
 * back to DATABASE_URL). Workspace can be a slug or a literal `org_*` id.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { getFlag } from "../../../lib/cli-utils";
import {
  resolveTenantUrl,
  resolveWorkspaceId,
  type TenantPgClient,
} from "../../../lib/tenant-db";

// --- seed prompts ---

export interface PromptLibrary {
  collection: {
    name: string;
    industry: string;
    description: string;
  };
  categories: Array<{ name: string; prompts: string[] }>;
}

export interface SeedPromptsOptions {
  workspace: string;
  library: PromptLibrary;
}

export function parsePromptLibrary(raw: string): PromptLibrary {
  // js-yaml v5 throws on empty input where v4 returned undefined; surface a
  // clear, file-attributed message instead of a raw YAMLException.
  if (!raw.trim()) {
    throw new Error("library.yml: file is empty");
  }
  const parsed = yaml.load(raw) as PromptLibrary;
  if (!parsed?.collection?.name || !parsed?.collection?.industry) {
    throw new Error("library.yml: missing collection.name or collection.industry");
  }
  if (!Array.isArray(parsed.categories) || parsed.categories.length === 0) {
    throw new Error("library.yml: categories array is empty");
  }
  return parsed;
}

export async function seedPrompts(
  client: TenantPgClient,
  opts: SeedPromptsOptions,
): Promise<{ orgId: string; collectionId: string; itemsInserted: number }> {
  await client.query("BEGIN");
  try {
    const orgId = await resolveWorkspaceId(client, opts.workspace);
    const lib = opts.library;

    // Drop any prior collection with the same (org, name) — ON DELETE CASCADE
    // on prompt_items.collection_id wipes every item alongside.
    await client.query(
      `DELETE FROM prompt_collections
       WHERE org_id = $1 AND lower(name) = lower($2)`,
      [orgId, lib.collection.name],
    );

    const insColl = await client.query<{ id: string }>(
      `INSERT INTO prompt_collections
         (org_id, name, industry, description, is_builtin, sort_order, status)
       VALUES ($1, $2, $3, $4, false, 0, 'published')
       RETURNING id`,
      [orgId, lib.collection.name, lib.collection.industry, lib.collection.description],
    );
    const collectionId = insColl.rows[0]!.id;

    let sortOrder = 0;
    let inserted = 0;
    for (const category of lib.categories) {
      for (const text of category.prompts) {
        await client.query(
          `INSERT INTO prompt_items
             (collection_id, question, category, sort_order)
           VALUES ($1, $2, $3, $4)`,
          [collectionId, text, category.name, sortOrder],
        );
        sortOrder++;
        inserted++;
      }
    }

    // Pin the org's demo industry so the starter-prompt resolver actually
    // matches this collection. The per-org unique key is a partial index
    // `(key, org_id) WHERE org_id IS NOT NULL` — Postgres requires the same
    // predicate spelled out in the ON CONFLICT clause to target it.
    await client.query(
      `INSERT INTO settings (key, value, org_id)
       VALUES ('ATLAS_DEMO_INDUSTRY', $1, $2)
       ON CONFLICT (key, org_id) WHERE org_id IS NOT NULL DO UPDATE
         SET value = EXCLUDED.value, updated_at = NOW()`,
      [lib.collection.industry, orgId],
    );

    await client.query("COMMIT");
    return { orgId, collectionId, itemsInserted: inserted };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

// --- seed workspace ---

/** Parsed shape of `--connections id=urlEnv:type[:primary],...`. */
export interface ConnectionSpec {
  id: string;
  urlEnv: string;
  type: string;
  isPrimary: boolean;
  description?: string;
}

export function parseConnectionsArg(value: string): ConnectionSpec[] {
  const out: ConnectionSpec[] = [];
  for (const entry of value.split(",").map((s) => s.trim()).filter(Boolean)) {
    const eqIdx = entry.indexOf("=");
    if (eqIdx === -1) {
      throw new Error(
        `--connections entry "${entry}" must be id=urlEnv:type[:primary]`,
      );
    }
    const id = entry.slice(0, eqIdx).trim();
    const rhs = entry.slice(eqIdx + 1).trim();
    const parts = rhs.split(":");
    if (parts.length < 2) {
      throw new Error(
        `--connections entry "${entry}" must include both urlEnv and type (id=urlEnv:type)`,
      );
    }
    const [urlEnv, type, marker] = parts;
    if (!id || !urlEnv || !type) {
      throw new Error(`--connections entry "${entry}" has empty id/urlEnv/type`);
    }
    if (marker !== undefined && marker !== "primary") {
      throw new Error(
        `--connections entry "${entry}" has unknown marker "${marker}" (only "primary" supported)`,
      );
    }
    out.push({
      id,
      urlEnv,
      type,
      isPrimary: marker === "primary",
    });
  }
  if (out.length === 0) {
    throw new Error("--connections requires at least one entry");
  }
  const primaries = out.filter((c) => c.isPrimary);
  if (primaries.length !== 1) {
    throw new Error(
      `--connections requires exactly one entry marked :primary (got ${primaries.length})`,
    );
  }
  return out;
}

export interface SemanticEntityRow {
  entityType: "entity" | "metric" | "glossary";
  name: string;
  yaml: string;
}

export function loadSemanticEntities(root: string): SemanticEntityRow[] {
  const out: SemanticEntityRow[] = [];
  for (const [dir, type] of [
    ["entities", "entity"],
    ["metrics", "metric"],
    ["glossary", "glossary"],
  ] as const) {
    let files: string[];
    try {
      files = readdirSync(join(root, dir));
    } catch (err) {
      // intentionally ignored: a missing subdirectory means this semantic-layer
      // category isn't defined (entities/metrics/glossary are all optional).
      // EACCES / EIO / EMFILE are real I/O problems and must surface — silently
      // producing a 0-entity seed in those cases would look identical to
      // "the operator didn't supply any YAML".
      const code =
        err instanceof Error && "code" in err
          ? (err as NodeJS.ErrnoException).code
          : undefined;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw err;
    }
    for (const file of files) {
      if (!file.endsWith(".yml")) continue;
      const name = file.replace(/\.yml$/, "");
      const yaml = readFileSync(join(root, dir, file), "utf8");
      out.push({ entityType: type, name, yaml });
    }
  }
  return out;
}

export interface ResolvedConnectionSpec extends ConnectionSpec {
  encryptedUrl: string;
}

export interface SeedWorkspaceOptions {
  workspace: string;
  groupId: string;
  groupName: string;
  connections: ResolvedConnectionSpec[];
  keyVersion: number;
  semanticEntities?: SemanticEntityRow[];
}

export async function seedWorkspaceGroup(
  client: TenantPgClient,
  opts: SeedWorkspaceOptions,
): Promise<{
  orgId: string;
  connectionsInserted: number;
  entitiesInserted: number;
}> {
  await client.query("BEGIN");
  try {
    const orgId = await resolveWorkspaceId(client, opts.workspace);

    // Post-0096 cutover (#2744 / ADR-0007): datasource installs live in
    // `workspace_plugins (pillar='datasource')`; group membership is a
    // free-form `config.group_id` JSONB string with no separate
    // `connection_groups` row and no `primary_connection_id`.

    // Wipe the auto-provisioned demo: its 'default' install and any
    // semantic entities not yet scoped to a real group. We replace those
    // with the explicit group below.
    await client.query(
      `DELETE FROM workspace_plugins
        WHERE workspace_id = $1 AND pillar = 'datasource' AND install_id = 'default'`,
      [orgId],
    );
    await client.query(
      `DELETE FROM semantic_entities
       WHERE org_id = $1
         AND (connection_group_id IS NULL OR connection_group_id = 'g_default')`,
      [orgId],
    );

    // Idempotency: clear prior rows for THIS group. Entities first,
    // then installs.
    await client.query(
      "DELETE FROM semantic_entities WHERE org_id = $1 AND connection_group_id = $2",
      [orgId, opts.groupId],
    );
    await client.query(
      `DELETE FROM workspace_plugins
        WHERE workspace_id = $1 AND pillar = 'datasource' AND install_id = ANY($2::text[])`,
      [orgId, opts.connections.map((c) => c.id)],
    );

    // Insert each member install. Catalog row is looked up by slug =
    // c.type (postgres / mysql / snowflake / …) from the built-in
    // Datasource catalog seeded by migration 0093.
    for (const c of opts.connections) {
      const catalogRows = await client.query<{ id: string }>(
        `SELECT id FROM plugin_catalog WHERE slug = $1 AND pillar = 'datasource' LIMIT 1`,
        [c.type],
      );
      if (catalogRows.rows.length === 0) {
        throw new Error(`seedWorkspaceGroup: no built-in datasource catalog row for type '${c.type}'`);
      }
      const catalogId = catalogRows.rows[0].id;
      const config = JSON.stringify({
        url: c.encryptedUrl,
        description: c.description ?? `${c.id} (${c.type})`,
        db_type: c.type,
        group_id: opts.groupId,
      });
      await client.query(
        `INSERT INTO workspace_plugins
           (id, workspace_id, catalog_id, install_id, pillar, config, enabled, installed_at, status)
         VALUES ($1, $2, $3, $4, 'datasource', $5::jsonb, true, NOW(), 'published')`,
        [`cn_${orgId}_${c.id}`, orgId, catalogId, c.id, config],
      );
    }

    // No primary wire-up post pure-collapse — the resolver falls back
    // to deterministic alphabetical-by-install_id ordering when no
    // explicit primary is set. The legacy `primary_connection_id`
    // column lived on `connection_groups`, which is gone.
    const primary = opts.connections.find((c) => c.isPrimary);
    if (!primary) throw new Error("seedWorkspaceGroup: no primary connection declared");

    // Insert semantic entities scoped to the group, if any were provided.
    const entities = opts.semanticEntities ?? [];
    for (const e of entities) {
      await client.query(
        `INSERT INTO semantic_entities (org_id, entity_type, name, yaml_content, connection_group_id, status)
         VALUES ($1, $2, $3, $4, $5, 'published')`,
        [orgId, e.entityType, e.name, e.yaml, opts.groupId],
      );
    }

    await client.query("COMMIT");
    return {
      orgId,
      connectionsInserted: opts.connections.length,
      entitiesInserted: entities.length,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

// --- Handler ---

async function handleSeedPrompts(args: string[]): Promise<void> {
  const workspace = getFlag(args, "--workspace");
  if (!workspace) {
    console.error("Error: --workspace <id|slug> is required.");
    process.exit(1);
  }
  const libraryPath = getFlag(args, "--library") ?? "./prompts/library.yml";

  let raw: string;
  try {
    raw = readFileSync(libraryPath, "utf8");
  } catch (err) {
    console.error(
      `Error: could not read library at ${libraryPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
  let library: PromptLibrary;
  try {
    library = parsePromptLibrary(raw);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const totalPrompts = library.categories.reduce((n, c) => n + c.prompts.length, 0);
  console.log(`[seed] loaded ${library.categories.length} categories, ${totalPrompts} prompts`);

  const url = resolveTenantUrl();
  const { Client } = await import("pg");
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const result = await seedPrompts(client as unknown as TenantPgClient, {
      workspace,
      library,
    });
    console.log(
      `[seed] ✓ workspace=${result.orgId} collection=${result.collectionId} items=${result.itemsInserted}`,
    );
  } catch (err) {
    console.error(`[seed] failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    await client.end().catch((closeErr) => {
      console.warn(
        `[seed] connection close failed: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`,
      );
    });
  }
}

async function handleSeedWorkspace(args: string[]): Promise<void> {
  const workspace = getFlag(args, "--workspace");
  if (!workspace) {
    console.error("Error: --workspace <id|slug> is required.");
    process.exit(1);
  }
  const groupName = getFlag(args, "--group");
  if (!groupName) {
    console.error("Error: --group <name> is required.");
    process.exit(1);
  }
  const groupId = getFlag(args, "--group-id") ?? `g_${groupName}`;
  const connectionsArg = getFlag(args, "--connections");
  if (!connectionsArg) {
    console.error(
      "Error: --connections <id=urlEnv:type[:primary],...> is required.",
    );
    process.exit(1);
  }
  let connections: ConnectionSpec[];
  try {
    connections = parseConnectionsArg(connectionsArg);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const semanticRoot = getFlag(args, "--semantic");
  const semanticEntities = semanticRoot ? loadSemanticEntities(semanticRoot) : [];

  // Lazy-load: encryptSecret is only needed by `seed workspace`. The `seed
  // prompts` path doesn't touch encryption, so keeping the import dynamic
  // avoids pulling the key-derivation chain into bundles that don't need it.
  const { encryptSecret } = await import("@atlas/api/lib/db/internal");
  const { activeKeyVersion } = await import(
    "@atlas/api/lib/db/encryption-keys"
  );

  const resolved: ResolvedConnectionSpec[] = connections.map((c) => {
    const plain = process.env[c.urlEnv];
    if (!plain) {
      console.error(`Error: env var ${c.urlEnv} is not set for connection ${c.id}.`);
      process.exit(1);
    }
    const enc = encryptSecret(plain);
    if (enc === plain || !enc.startsWith("enc:")) {
      console.error(
        `Error: encryptSecret returned plaintext for ${c.id} — ATLAS_ENCRYPTION_KEYS missing or invalid.`,
      );
      process.exit(1);
    }
    return { ...c, encryptedUrl: enc };
  });

  const url = resolveTenantUrl();
  const { Client } = await import("pg");
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const result = await seedWorkspaceGroup(client as unknown as TenantPgClient, {
      workspace,
      groupId,
      groupName,
      connections: resolved,
      keyVersion: activeKeyVersion(),
      semanticEntities,
    });
    console.log(
      `[seed] ✓ workspace=${result.orgId} group=${groupId} connections=${result.connectionsInserted} entities=${result.entitiesInserted}`,
    );
  } catch (err) {
    console.error(`[seed] failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    await client.end().catch((closeErr) => {
      console.warn(
        `[seed] connection close failed: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`,
      );
    });
  }
}

export async function handleSeed(args: string[]): Promise<void> {
  const subcommand = args[1];
  if (subcommand === "prompts") return handleSeedPrompts(args);
  if (subcommand === "workspace") return handleSeedWorkspace(args);

  console.error(
    "Usage: atlas-operator seed <prompts|workspace> [options]\n\n" +
      "Subcommands:\n" +
      "  prompts    Seed a prompt-library collection + items from a YAML file.\n" +
      "  workspace  Provision a connection group + member connections + semantic entities.\n",
  );
  process.exit(1);
}
