/**
 * atlas export -- Export workspace data to a portable migration bundle (JSON).
 *
 * Extracted from atlas.ts to reduce monolith size.
 */

import * as fs from "fs";
import pc from "picocolors";
import { getFlag } from "../../lib/cli-utils";

export async function handleExport(args: string[]): Promise<void> {
  const outputArg = getFlag(args, "--output") ?? getFlag(args, "-o");
  const orgArg = getFlag(args, "--org");

  // Require DATABASE_URL
  if (!process.env.DATABASE_URL) {
    console.error(pc.red("DATABASE_URL is required for atlas export."));
    console.error(
      "  The export reads conversations, settings, and learned patterns from the internal database.",
    );
    console.error(
      "  Set DATABASE_URL=postgresql://... to point to your Atlas internal database.",
    );
    process.exit(1);
  }

  const { getInternalDB, closeInternalDB } = await import(
    "@atlas/api/lib/db/internal"
  );
  const pool = getInternalDB();

  try {
    console.log("\nAtlas Export -- creating migration bundle...\n");

    // Determine org filter
    const orgFilter = orgArg ?? null;
    const orgClause = orgFilter ? "org_id = $1" : "org_id IS NULL";
    const orgParams = orgFilter ? [orgFilter] : [];

    // 1. Conversations + messages
    const convRows = await pool.query(
      `SELECT id, user_id, title, surface, connection_id, starred, created_at, updated_at
       FROM conversations
       WHERE ${orgClause} AND deleted_at IS NULL
       ORDER BY created_at`,
      orgParams,
    );
    console.log(`  Conversations: ${convRows.rows.length}`);

    let messageCount = 0;
    const conversations = [];
    for (const row of convRows.rows) {
      const msgRows = await pool.query(
        `SELECT id, role, content, created_at
         FROM messages
         WHERE conversation_id = $1
         ORDER BY created_at`,
        [row.id],
      );
      messageCount += msgRows.rows.length;
      conversations.push({
        id: row.id as string,
        userId: (row.user_id as string) ?? null,
        title: (row.title as string) ?? null,
        surface:
          (row.surface as
            | import("@useatlas/types").ExportedConversation["surface"]) ??
          "web",
        connectionId: (row.connection_id as string) ?? null,
        starred: (row.starred as boolean) ?? false,
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        messages: msgRows.rows.map(
          (m: Record<string, unknown>) => ({
            id: m.id as string,
            role: m.role as import("@useatlas/types").ExportedMessage["role"],
            content: m.content,
            createdAt: String(m.created_at),
          }),
        ),
      });
    }
    console.log(`  Messages:      ${messageCount}`);

    // 2. Semantic entities (DB-backed)
    const entRows = await pool.query(
      `SELECT name, entity_type, yaml_content, connection_id
       FROM semantic_entities
       WHERE ${orgClause}
       ORDER BY entity_type, name`,
      orgParams,
    );
    const semanticEntities = entRows.rows.map(
      (r: Record<string, unknown>) => ({
        name: r.name as string,
        entityType: r.entity_type as string,
        yamlContent: r.yaml_content as string,
        connectionId: (r.connection_id as string) ?? null,
      }),
    );
    console.log(`  Entities:      ${semanticEntities.length}`);

    // 3. Learned patterns
    const patRows = await pool.query(
      `SELECT pattern_sql, description, source_entity, confidence, status
       FROM learned_patterns
       WHERE ${orgClause}
       ORDER BY created_at`,
      orgParams,
    );
    const learnedPatterns = patRows.rows.map(
      (r: Record<string, unknown>) => ({
        patternSql: r.pattern_sql as string,
        description: (r.description as string) ?? null,
        sourceEntity: (r.source_entity as string) ?? null,
        confidence: r.confidence as number,
        status: r.status as import("@useatlas/types").LearnedPattern["status"],
      }),
    );
    console.log(`  Patterns:      ${learnedPatterns.length}`);

    // 4. Settings
    const settRows = await pool.query(
      `SELECT key, value
       FROM settings
       WHERE ${orgClause}
       ORDER BY key`,
      orgParams,
    );
    const settings = settRows.rows.map(
      (r: Record<string, unknown>) => ({
        key: r.key as string,
        value: r.value as string,
      }),
    );
    console.log(`  Settings:      ${settings.length}`);

    // Build bundle
    const { EXPORT_BUNDLE_VERSION } = await import("@useatlas/types");
    const bundle: import("@useatlas/types").ExportBundle = {
      manifest: {
        version: EXPORT_BUNDLE_VERSION,
        exportedAt: new Date().toISOString(),
        source: {
          label: orgFilter ? `org:${orgFilter}` : "self-hosted",
          apiUrl:
            process.env.ATLAS_API_URL ?? "http://localhost:3001",
        },
        counts: {
          conversations: conversations.length,
          messages: messageCount,
          semanticEntities: semanticEntities.length,
          learnedPatterns: learnedPatterns.length,
          settings: settings.length,
        },
      },
      conversations,
      semanticEntities,
      learnedPatterns,
      settings,
    };

    // Write output
    const date = new Date().toISOString().slice(0, 10);
    const outPath = outputArg ?? `./atlas-export-${date}.json`;
    fs.writeFileSync(outPath, JSON.stringify(bundle, null, 2));
    console.log(
      `\n${pc.green("\u2713")} Bundle written to ${pc.bold(outPath)}`,
    );
    console.log(
      `  Total size: ${(Buffer.byteLength(JSON.stringify(bundle)) / 1024).toFixed(1)} KB`,
    );
    console.log(
      `\nNext: ATLAS_API_KEY=sk-... atlas migrate-import --bundle ${outPath} --target https://app.useatlas.dev`,
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(pc.red(`Export failed: ${detail}`));
    process.exit(1);
  } finally {
    await closeInternalDB();
  }
}
