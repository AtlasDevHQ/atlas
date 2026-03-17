/**
 * Types for the sidecar HTTP contract.
 * Used by both the sidecar server (packages/sandbox-sidecar) and
 * the sidecar clients (explore-sidecar.ts, python-sidecar.ts).
 */

export interface SidecarExecRequest {
  command: string;
  timeout?: number;
  /** Working directory override, relative to SEMANTIC_DIR (e.g. '.orgs/org123'). Must resolve to a path under SEMANTIC_DIR. */
  cwd?: string;
}

export interface SidecarExecResponse {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// --- Python execution ---

export interface SidecarPythonRequest {
  code: string;
  data?: { columns: string[]; rows: unknown[][] };
  timeout?: number;
}

/** Wire-format alias — canonical type lives in python.ts. */
export type { PythonResult as SidecarPythonResponse } from "@atlas/api/lib/tools/python";

// --- Python streaming execution ---

/** NDJSON events emitted by the streaming Python endpoint. */
export type SidecarPythonStreamEvent =
  | { type: "stdout"; data: string }
  | { type: "chart"; data: { base64: string; mimeType: "image/png" } }
  | { type: "recharts"; data: { type: "line" | "bar" | "pie"; data: Record<string, unknown>[]; categoryKey: string; valueKeys: string[] } }
  | { type: "table"; data: { columns: string[]; rows: unknown[][] } }
  | { type: "done"; data: { success: true; exitCode: number } }
  | { type: "error"; data: { error: string; output?: string } };
