/**
 * Sidecar backend for the Python execution tool.
 *
 * Calls the sandbox sidecar's POST /exec-python endpoint to run Python code
 * in an isolated container with no secrets and no host access. The sidecar
 * handles data injection, chart collection, and structured output.
 *
 * Configured via ATLAS_SANDBOX_URL (same as the explore sidecar).
 */

import type { SidecarPythonRequest } from "@atlas/api/lib/sidecar-types";
import type { PythonResult } from "./python";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("python-sidecar");

/** Default timeout for Python execution (ms). */
const DEFAULT_TIMEOUT_MS = 30_000;

/** HTTP-level timeout — longer than the execution timeout to allow for overhead. */
const HTTP_OVERHEAD_MS = 10_000;

/** Shorthand for building error results. */
function pythonError(error: string): PythonResult & { success: false } {
  return { success: false, error };
}

export async function executePythonViaSidecar(
  sidecarUrl: string,
  code: string,
  data?: { columns: string[]; rows: unknown[][] },
): Promise<PythonResult> {
  const authToken = process.env.SIDECAR_AUTH_TOKEN;

  let baseUrl: URL;
  try {
    baseUrl = new URL(sidecarUrl);
  } catch {
    return pythonError(
      `Invalid ATLAS_SANDBOX_URL: "${sidecarUrl}". Expected a valid URL (e.g. http://sandbox-sidecar:8080).`,
    );
  }

  const execUrl = new URL("/exec-python", baseUrl).toString();
  const rawTimeout = parseInt(process.env.ATLAS_PYTHON_TIMEOUT ?? String(DEFAULT_TIMEOUT_MS), 10);
  if (Number.isNaN(rawTimeout)) {
    log.warn({ value: process.env.ATLAS_PYTHON_TIMEOUT }, "Invalid ATLAS_PYTHON_TIMEOUT, using default");
  }
  const timeout = Number.isNaN(rawTimeout) ? DEFAULT_TIMEOUT_MS : rawTimeout;

  const requestBody: SidecarPythonRequest = { code, timeout };
  if (data) {
    requestBody.data = data;
  }

  let response: Response;
  try {
    response = await fetch(execUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(timeout + HTTP_OVERHEAD_MS),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);

    if (
      detail.includes("ECONNREFUSED") ||
      detail.includes("fetch failed") ||
      detail.includes("Failed to connect")
    ) {
      log.error({ err: detail, url: execUrl }, "Sidecar connection failed for Python execution");
      return pythonError(
        `Python sidecar unreachable at ${baseUrl.origin}: ${detail}. Check that the sandbox-sidecar service is running.`,
      );
    }

    if (detail.includes("TimeoutError") || detail.includes("timed out") || detail.includes("aborted")) {
      log.warn({ timeout }, "Python sidecar request timed out");
      return pythonError(`Python execution timed out after ${timeout}ms`);
    }

    log.error({ err: detail }, "Python sidecar request failed");
    return pythonError(`Sidecar request failed: ${detail}`);
  }

  if (!response.ok) {
    let errorBody: string;
    try {
      errorBody = await response.text();
    } catch {
      errorBody = `HTTP ${response.status}`;
    }

    log.error(
      {
        status: response.status,
        contentLength: response.headers.get("content-length"),
        body: errorBody.slice(0, 500),
      },
      "Python sidecar returned HTTP error",
    );

    // Try to parse as structured error (500 with PythonResult shape)
    if (response.status === 500) {
      try {
        const parsed = JSON.parse(errorBody) as PythonResult;
        if (typeof parsed.success === "boolean") {
          return parsed;
        }
      } catch {
        // Not structured — fall through
      }
    }

    return pythonError(
      `Python sidecar error (HTTP ${response.status}): ${errorBody.slice(0, 500)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.error(
      {
        err: detail,
        status: response.status,
        contentLength: response.headers.get("content-length"),
      },
      "Failed to parse Python sidecar response",
    );
    return pythonError(`Failed to parse sidecar response: ${detail}`);
  }

  const result = parsed as PythonResult;
  if (typeof result.success !== "boolean") {
    log.error(
      { body: JSON.stringify(parsed).slice(0, 500) },
      "Python sidecar returned unexpected response shape",
    );
    return pythonError("Sidecar returned an unexpected response format.");
  }

  return result;
}
