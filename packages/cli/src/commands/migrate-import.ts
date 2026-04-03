/**
 * atlas migrate-import -- Import an export bundle into a hosted Atlas instance.
 *
 * Extracted from atlas.ts to reduce monolith size.
 */

import * as fs from "fs";
import pc from "picocolors";
import { getFlag } from "../../lib/cli-utils";

export async function handleMigrateImport(
  args: string[],
): Promise<void> {
  const bundlePath = getFlag(args, "--bundle");
  const targetUrl =
    getFlag(args, "--target") ?? "https://app.useatlas.dev";
  const apiKey =
    getFlag(args, "--api-key") ?? process.env.ATLAS_API_KEY;

  if (!bundlePath) {
    console.error(pc.red("--bundle <path> is required."));
    console.error(
      "  Example: atlas migrate-import --bundle atlas-export-2026-04-02.json --target https://app.useatlas.dev",
    );
    process.exit(1);
  }

  if (!apiKey) {
    console.error(pc.red("Authentication required."));
    console.error("  Set ATLAS_API_KEY or pass --api-key <key>.");
    process.exit(1);
  }

  // Read and validate the bundle file
  if (!fs.existsSync(bundlePath)) {
    console.error(
      pc.red(`Bundle file not found: ${bundlePath}`),
    );
    process.exit(1);
  }

  let bundle: unknown;
  try {
    const raw = fs.readFileSync(bundlePath, "utf-8");
    bundle = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(pc.red(`Failed to parse bundle: ${detail}`));
    process.exit(1);
  }

  // Basic validation -- mirror server-side checks to fail fast before upload
  const b = bundle as Record<string, unknown>;
  if (
    !b ||
    typeof b !== "object" ||
    !b.manifest ||
    !Array.isArray(b.conversations) ||
    !Array.isArray(b.semanticEntities) ||
    !Array.isArray(b.learnedPatterns) ||
    !Array.isArray(b.settings)
  ) {
    console.error(
      pc.red(
        "Invalid bundle format. Expected an Atlas export bundle with manifest and all data arrays.",
      ),
    );
    process.exit(1);
  }

  const { EXPORT_BUNDLE_VERSION } = await import("@useatlas/types");
  const manifest = b.manifest as {
    version: number;
    counts: Record<string, number>;
  };
  if (manifest.version !== EXPORT_BUNDLE_VERSION) {
    console.error(
      pc.red(
        `Unsupported bundle version: ${manifest.version}. This CLI supports version ${EXPORT_BUNDLE_VERSION}.`,
      ),
    );
    process.exit(1);
  }

  console.log(
    `\nAtlas Migrate-Import -- sending bundle to ${pc.bold(targetUrl)}\n`,
  );
  console.log(`  Bundle: ${bundlePath}`);
  console.log(
    `  Conversations: ${manifest.counts.conversations}`,
  );
  console.log(
    `  Entities:      ${manifest.counts.semanticEntities}`,
  );
  console.log(
    `  Patterns:      ${manifest.counts.learnedPatterns}`,
  );
  console.log(`  Settings:      ${manifest.counts.settings}`);
  console.log();

  const importUrl = `${targetUrl.replace(/\/$/, "")}/api/v1/admin/migrate/import`;

  try {
    const resp = await fetch(importUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(bundle),
      signal: AbortSignal.timeout(120_000),
    });

    if (!resp.ok) {
      if (resp.status === 401 || resp.status === 403) {
        console.error(
          pc.red(
            "Import failed: authentication or authorization error.",
          ),
        );
        console.error(
          "  Ensure your API key has admin access to the target workspace.",
        );
      } else if (resp.status === 413) {
        console.error(
          pc.red(
            "Import failed: bundle too large. Try exporting a smaller dataset.",
          ),
        );
      } else {
        let errorMsg = `HTTP ${resp.status}`;
        try {
          const json = (await resp.json()) as {
            message?: string;
            error?: string;
          };
          errorMsg =
            json.message ?? json.error ?? errorMsg;
        } catch {
          // intentionally ignored: JSON parse failed
          errorMsg = await resp.text().catch(() => errorMsg);
        }
        console.error(
          pc.red(`Import failed: ${errorMsg}`),
        );
      }
      process.exit(1);
    }

    let result: import("@useatlas/types").ImportResult;
    try {
      result =
        (await resp.json()) as import("@useatlas/types").ImportResult;
      if (
        !result?.conversations ||
        !result?.semanticEntities
      ) {
        throw new Error("Unexpected response shape");
      }
    } catch (parseErr) {
      console.error(
        pc.red(
          "Import appeared to succeed (HTTP 200) but the response was not in the expected format.",
        ),
      );
      console.error(
        "  Check the target Atlas instance version compatibility.",
      );
      console.error(
        `  Detail: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
      );
      process.exit(1);
    }

    console.log(`${pc.green("\u2713")} Import complete!\n`);
    console.log(
      "  Entity            Imported  Skipped",
    );
    console.log(
      "  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500  \u2500\u2500\u2500\u2500\u2500\u2500\u2500",
    );
    console.log(
      `  Conversations     ${String(result.conversations.imported).padStart(8)}  ${String(result.conversations.skipped).padStart(7)}`,
    );
    console.log(
      `  Semantic entities ${String(result.semanticEntities.imported).padStart(8)}  ${String(result.semanticEntities.skipped).padStart(7)}`,
    );
    console.log(
      `  Learned patterns  ${String(result.learnedPatterns.imported).padStart(8)}  ${String(result.learnedPatterns.skipped).padStart(7)}`,
    );
    console.log(
      `  Settings          ${String(result.settings.imported).padStart(8)}  ${String(result.settings.skipped).padStart(7)}`,
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (
      detail.includes("ECONNREFUSED") ||
      detail.includes("fetch failed")
    ) {
      console.error(
        pc.red(
          `Cannot reach Atlas API at ${targetUrl}.`,
        ),
      );
      console.error(
        "  Check the --target URL and ensure the Atlas API is running.",
      );
    } else {
      console.error(pc.red(`Import failed: ${detail}`));
    }
    process.exit(1);
  }
}
