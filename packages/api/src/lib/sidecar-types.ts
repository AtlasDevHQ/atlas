/**
 * Types for the sidecar HTTP contract.
 * Used by both the sidecar server (packages/sandbox-sidecar) and
 * the sidecar client (packages/api/src/lib/tools/explore-sidecar.ts).
 */

export interface SidecarExecRequest {
  command: string;
  timeout?: number;
}

export interface SidecarExecResponse {
  stdout: string;
  stderr: string;
  exitCode: number;
}
