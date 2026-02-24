import { validateEnvironment, getStartupWarnings } from "@/lib/startup";
import { getWhitelistedTables } from "@/lib/semantic";

function findDiagnostic(
  diagnostics: { code: string; message: string }[],
  ...codes: string[]
) {
  return diagnostics.find((d) => codes.includes(d.code));
}

export async function GET(): Promise<Response> {
  try {
    const diagnostics = await validateEnvironment();

    // Probe DB with SELECT 1 — this is the authoritative real-time check.
    // Intentionally bypasses validateSQL: hardcoded literal, no FROM clause,
    // no user input, no tables to whitelist.
    let dbLatencyMs: number | undefined;
    let dbProbeError: string | undefined;
    if (process.env.DATABASE_URL) {
      try {
        const { getDB } = await import("@/lib/db/connection");
        const start = performance.now();
        await getDB().query("SELECT 1", 5000);
        dbLatencyMs = Math.round(performance.now() - start);
      } catch (err) {
        console.error(
          "[atlas] Health check DB probe failed:",
          err instanceof Error ? err.message : String(err),
        );
        dbProbeError = "Database query failed";
      }
    }

    const provider = process.env.ATLAS_PROVIDER ?? "anthropic";
    const entityCount = getWhitelistedTables().size;

    // DB is unhealthy if: no URL, diagnostics flagged it, OR the live probe failed
    const dbDiagnostic = findDiagnostic(
      diagnostics,
      "MISSING_DATABASE_URL",
      "DB_UNREACHABLE",
    );
    const hasDbError = !!dbDiagnostic || !!dbProbeError;
    const hasKeyError = !!findDiagnostic(diagnostics, "MISSING_API_KEY");
    const hasSemanticError = !!findDiagnostic(
      diagnostics,
      "MISSING_SEMANTIC_LAYER",
    );

    let status: "ok" | "degraded" | "error";
    if (hasDbError) status = "error";
    else if (hasKeyError || hasSemanticError) status = "degraded";
    else status = "ok";

    const warnings = getStartupWarnings();

    const response = {
      status,
      ...(warnings.length > 0 && { warnings }),
      checks: {
        database: {
          status: hasDbError ? "error" : "ok",
          ...(dbLatencyMs !== undefined && { latencyMs: dbLatencyMs }),
          // Return error codes only — never raw messages that may contain hostnames/IPs
          ...(hasDbError && {
            error: dbProbeError ?? dbDiagnostic?.code ?? "DB_UNREACHABLE",
          }),
        },
        provider: {
          status: hasKeyError ? "error" : "ok",
          provider,
          model: process.env.ATLAS_MODEL ?? "(default)",
          ...(hasKeyError && { error: "MISSING_API_KEY" }),
        },
        semanticLayer: {
          status: hasSemanticError ? "error" : "ok",
          entityCount,
          ...(hasSemanticError && { error: "MISSING_SEMANTIC_LAYER" }),
        },
      },
    };

    return Response.json(response, {
      status: response.status === "error" ? 503 : 200,
    });
  } catch (err) {
    console.error(
      "[atlas] Health endpoint unexpected error:",
      err instanceof Error ? err.message : String(err),
    );
    return Response.json(
      { status: "error", error: "health_check_failed" },
      { status: 503 },
    );
  }
}
