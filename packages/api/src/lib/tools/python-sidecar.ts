/**
 * Sidecar backend for the Python execution tool.
 *
 * Calls the sandbox sidecar's POST /exec-python endpoint to run Python code
 * in an isolated container with no secrets and no host access. The sidecar
 * handles data injection, chart collection, and structured output.
 *
 * Configured via ATLAS_SANDBOX_URL (same as the explore sidecar).
 */

import type { SidecarPythonRequest, SidecarPythonStreamEvent } from "@atlas/api/lib/sidecar-types";
import type { PythonChart, PythonProgressEvent, PythonResult, RechartsChart } from "./python";
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

/**
 * Execute Python via the sidecar's streaming endpoint.
 *
 * Reads NDJSON events from POST /exec-python-stream, calling `onProgress`
 * for each stdout/chart event, and accumulates the final PythonResult.
 * Falls back to the non-streaming endpoint on connection errors.
 */
export async function executePythonViaSidecarStream(
  sidecarUrl: string,
  code: string,
  data: { columns: string[]; rows: unknown[][] } | undefined,
  onProgress: (event: PythonProgressEvent) => void,
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

  const execUrl = new URL("/exec-python-stream", baseUrl).toString();
  const rawTimeout = parseInt(process.env.ATLAS_PYTHON_TIMEOUT ?? String(DEFAULT_TIMEOUT_MS), 10);
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
    const isConnectionError =
      detail.includes("ECONNREFUSED") ||
      detail.includes("fetch failed") ||
      detail.includes("Failed to connect");

    if (isConnectionError) {
      log.warn({ err: detail }, "Streaming endpoint unreachable, falling back to non-streaming");
      return executePythonViaSidecar(sidecarUrl, code, data);
    }

    log.error({ err: detail }, "Unexpected error calling streaming Python endpoint");
    return pythonError(`Streaming Python execution failed: ${detail}`);
  }

  if (!response.ok || !response.body) {
    if (response.status === 404) {
      // Sidecar doesn't support streaming — expected for older versions
      log.info("Streaming endpoint not found (404), falling back to non-streaming");
      return executePythonViaSidecar(sidecarUrl, code, data);
    }
    log.error({ status: response.status, hasBody: !!response.body }, "Streaming Python endpoint returned unexpected HTTP error, falling back");
    return executePythonViaSidecar(sidecarUrl, code, data);
  }

  // Consume the NDJSON stream
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Accumulate output, charts, tables for the final PythonResult
  const outputParts: string[] = [];
  const charts: PythonChart[] = [];
  const rechartsCharts: RechartsChart[] = [];
  let table: { columns: string[]; rows: unknown[][] } | undefined;
  let error: string | undefined;
  let success = true;
  let receivedTerminal = false;
  let parseFailures = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let newlineIdx;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);

        if (!line) continue;

        let event: SidecarPythonStreamEvent;
        try {
          event = JSON.parse(line) as SidecarPythonStreamEvent;
        } catch (parseErr) {
          parseFailures++;
          log.warn(
            { line: line.slice(0, 200), err: parseErr instanceof Error ? parseErr.message : String(parseErr), parseFailures },
            "Skipping unparseable NDJSON line from Python stream",
          );
          continue;
        }

        switch (event.type) {
          case "stdout":
            outputParts.push(event.data);
            onProgress({ type: "stdout", content: event.data });
            break;
          case "chart":
            charts.push(event.data);
            onProgress({ type: "chart", chart: event.data });
            break;
          case "recharts":
            rechartsCharts.push(event.data);
            onProgress({ type: "recharts", chart: event.data });
            break;
          case "table":
            table = event.data;
            break;
          case "done":
            receivedTerminal = true;
            break;
          case "error":
            receivedTerminal = true;
            success = false;
            error = event.data.error;
            if (event.data.output) outputParts.push(event.data.output);
            break;
          default: {
            // Exhaustiveness guard — new event types added to SidecarPythonStreamEvent
            // will cause a compile error here until handled.
            const _exhaustive: never = event;
            log.warn({ type: (_exhaustive as { type: string }).type }, "Unknown Python stream event type");
          }
        }
      }
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.error({ err: detail }, "Error reading Python stream");
    return pythonError(`Stream read failed: ${detail}`);
  } finally {
    reader.releaseLock();
  }

  if (parseFailures > 0) {
    log.warn({ parseFailures }, "Python stream had unparseable NDJSON lines — result may be incomplete");
  }

  const output = outputParts.join("").trim() || undefined;

  // If the stream ended without a terminal event, the execution was interrupted
  if (!receivedTerminal) {
    log.warn("Python stream ended without done/error event — execution may have been interrupted");
    return { success: false, error: "Python execution was interrupted (no completion signal received)", ...(output && { output }) };
  }

  if (!success) {
    return { success: false, error: error ?? "Unknown error", ...(output && { output }) };
  }

  return {
    success: true,
    ...(output && { output }),
    ...(table && { table }),
    ...(charts.length > 0 && { charts }),
    ...(rechartsCharts.length > 0 && { rechartsCharts }),
  };
}
