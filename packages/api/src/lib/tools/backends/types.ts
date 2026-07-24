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
  /**
   * Whether the backend cut stdout/stderr at the MAX_OUTPUT cap. Set by
   * backends that pre-truncate at read time (nsjail); omitted by backends that
   * return whole buffers (Vercel/just-bash/plugin), which the tool seam caps
   * and marks via capOutput. The seam appends the truncation notice from these.
   */
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
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
