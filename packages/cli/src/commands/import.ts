/**
 * atlas import -- Request the Atlas API to sync semantic layer YAML from disk into the internal DB.
 *
 * Extracted from atlas.ts to reduce monolith size.
 */

import { getFlag } from "../../lib/cli-utils";

export async function handleImport(args: string[]): Promise<void> {
  const connectionArg = getFlag(args, "--connection");

  // Determine the API base URL
  const apiUrl =
    process.env.ATLAS_API_URL ?? "http://localhost:3001";

  // Build the import request
  const importUrl = `${apiUrl}/api/v1/admin/semantic/org/import`;
  const body: Record<string, string> = {};
  if (connectionArg) body.connectionId = connectionArg;

  // Determine auth header
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (process.env.ATLAS_API_KEY)
    headers.Authorization = `Bearer ${process.env.ATLAS_API_KEY}`;

  console.log("Importing semantic layer from disk to DB...\n");

  try {
    const resp = await fetch(importUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (!resp.ok) {
      if (resp.status === 401 || resp.status === 403) {
        console.error(
          "Import failed: authentication required.",
        );
        console.error(
          "  Set ATLAS_API_KEY environment variable.",
        );
      } else {
        let errorMsg = `HTTP ${resp.status}`;
        try {
          const json = (await resp.json()) as {
            message?: string;
            error?: string;
          };
          errorMsg = json.message ?? json.error ?? errorMsg;
        } catch {
          // intentionally ignored: JSON parse failed, fall through to text() attempt
          errorMsg = await resp.text().catch(() => errorMsg);
        }
        console.error(`Import failed: ${errorMsg}`);
      }
      process.exit(1);
    }

    const result = (await resp.json()) as {
      imported: number;
      skipped: number;
      errors: Array<{ file: string; reason: string }>;
      total: number;
    };

    console.log(`Imported: ${result.imported}`);
    if (result.skipped > 0) {
      console.log(`Skipped:  ${result.skipped}`);
    }
    console.log(`Total:    ${result.total}`);

    if (result.errors.length > 0) {
      console.log("\nErrors:");
      for (const e of result.errors) {
        console.log(`  ${e.file}: ${e.reason}`);
      }
    }

    if (result.imported > 0) {
      console.log(
        "\nDone! Entities imported to DB. The explore tool and SQL validation will use the updated semantic layer.",
      );
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (
      detail.includes("ECONNREFUSED") ||
      detail.includes("fetch failed")
    ) {
      console.error(
        `Cannot reach Atlas API at ${apiUrl}. Is the server running?`,
      );
      console.error("  Start it with: bun run dev:api");
      console.error(
        "  Set ATLAS_API_URL if the API is not on localhost:3001",
      );
    } else {
      console.error(`Import failed: ${detail}`);
    }
    process.exit(1);
  }
}
