/**
 * Shared types for sandbox backends.
 *
 * Canonical definitions for the explore backend interface. Explore tool
 * backends import from here; plugins/wiring.ts uses ExploreBackend as
 * the type for sandbox plugin backends.
 */

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Shell backend for the explore tool.
 *
 * Implementations MUST provide read-only filesystem access scoped to the
 * semantic layer directory. Commands execute within /semantic as the working
 * directory. Writes should be silently discarded or cause errors, never
 * modify the host filesystem.
 */
export interface ExploreBackend {
  exec(command: string): Promise<ExecResult>;
  close?(): Promise<void>;
}
