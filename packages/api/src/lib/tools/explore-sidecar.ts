/**
 * Sidecar backend for the explore tool.
 *
 * Calls a separate HTTP service (the sandbox sidecar) to execute shell
 * commands against the semantic layer. Isolation is provided by the
 * container boundary — the sidecar has no secrets, no database drivers,
 * and a minimal filesystem (bash, coreutils, semantic/ files).
 * Communication occurs only via HTTP.
 *
 * Configured via ATLAS_SANDBOX_URL (e.g. http://sandbox-sidecar:8080).
 */

import type { ExploreBackend, ExecResult } from "./explore";
import type { SidecarExecResponse } from "@atlas/api/lib/sidecar-types";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("explore-sidecar");

/** Default timeout for sidecar requests (ms). */
const DEFAULT_TIMEOUT_MS = 10_000;

/** HTTP-level timeout — slightly longer than the command timeout to allow for overhead. */
const HTTP_OVERHEAD_MS = 5_000;

export async function createSidecarBackend(
  sidecarUrl: string,
): Promise<ExploreBackend> {
  const authToken = process.env.SIDECAR_AUTH_TOKEN;

  let baseUrl: URL;
  try {
    baseUrl = new URL(sidecarUrl);
  } catch {
    throw new Error(
      `Invalid ATLAS_SANDBOX_URL: "${sidecarUrl}". Expected a valid URL (e.g. http://sandbox-sidecar:8080).`,
    );
  }

  const execUrl = new URL("/exec", baseUrl).toString();

  return {
    exec: async (command: string): Promise<ExecResult> => {
      const timeout = DEFAULT_TIMEOUT_MS;

      let response: Response;
      try {
        response = await fetch(execUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          },
          body: JSON.stringify({ command, timeout }),
          signal: AbortSignal.timeout(timeout + HTTP_OVERHEAD_MS),
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);

        // Connection refused or timeout — sidecar may be down
        if (
          detail.includes("ECONNREFUSED") ||
          detail.includes("fetch failed") ||
          detail.includes("Failed to connect")
        ) {
          log.error({ err: detail, url: execUrl }, "Sidecar connection failed");
          // Invalidate backend cache so the next call re-evaluates the backend priority chain.
          // If the sidecar stays down, the system falls back to just-bash.
          const { invalidateExploreBackend } = await import("./explore");
          invalidateExploreBackend();
          throw new Error(
            `Sidecar unreachable at ${baseUrl.origin}: ${detail}. ` +
            "Check that the sandbox-sidecar service is running.",
            { cause: err },
          );
        }

        if (detail.includes("TimeoutError") || detail.includes("timed out") || detail.includes("aborted")) {
          log.warn({ command, timeout }, "Sidecar request timed out");
          return {
            stdout: "",
            stderr: `Command timed out after ${timeout}ms`,
            exitCode: 124, // Conventional timeout exit code (matches GNU timeout(1))
          };
        }

        log.error({ err: detail, command }, "Sidecar request failed");
        throw new Error(`Sidecar request failed: ${detail}`, { cause: err });
      }

      // Handle HTTP-level errors from the sidecar
      if (!response.ok) {
        let errorBody: string;
        try {
          errorBody = await response.text();
        } catch {
          errorBody = `HTTP ${response.status}`;
        }

        log.error(
          { status: response.status, body: errorBody.slice(0, 500) },
          "Sidecar returned HTTP error",
        );

        // 500 with exec response shape — the sidecar wraps execution errors
        if (response.status === 500) {
          try {
            const parsed = JSON.parse(errorBody);
            if (typeof parsed.exitCode === "number") {
              return {
                stdout: parsed.stdout ?? "",
                stderr: parsed.stderr ?? errorBody,
                exitCode: parsed.exitCode,
              };
            }
          } catch (parseErr) {
            // Sidecar returned non-JSON 500 body — fall through to generic error
            log.debug(
              { status: response.status, parseError: parseErr instanceof Error ? parseErr.message : String(parseErr) },
              "HTTP 500 body is not valid exec JSON — using generic error",
            );
          }
        }

        return {
          stdout: "",
          stderr: `Sidecar error (HTTP ${response.status}): ${errorBody.slice(0, 500)}`,
          exitCode: 1,
        };
      }

      // Parse the exec response
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        log.error({ err: detail }, "Failed to parse sidecar response");
        return {
          stdout: "",
          stderr: `Failed to parse sidecar response: ${detail}`,
          exitCode: 1,
        };
      }

      if (typeof parsed !== "object" || parsed === null || typeof (parsed as Record<string, unknown>).exitCode !== "number") {
        log.error({ body: JSON.stringify(parsed).slice(0, 500) }, "Sidecar returned unexpected response shape");
        return {
          stdout: "",
          stderr: "Sidecar returned an unexpected response format. Check ATLAS_SANDBOX_URL configuration.",
          exitCode: 1,
        };
      }

      const result = parsed as SidecarExecResponse;

      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: result.exitCode,
      };
    },
  };
}
