/**
 * Minimal type declarations for @vercel/sandbox ^1.x (optional dependency).
 * These declarations provide type safety on environments where the optional
 * package is not installed (e.g., self-hosted Docker deployments).
 * When @vercel/sandbox is installed, its own types take precedence.
 *
 * Last synced with: @vercel/sandbox@1.x SDK reference
 */
declare module "@vercel/sandbox" {
  interface SandboxCreateOptions {
    runtime?: string;
    /**
     * Network policy for the sandbox. Atlas MUST use "deny-all"
     * to prevent the explore tool from making network requests.
     * Actual SDK also accepts an object form for fine-grained rules.
     */
    networkPolicy?: "deny-all" | "allow-all" | (string & {});
    ports?: number[];
    timeout?: number;
  }

  interface WriteFileEntry {
    path: string;
    content: Buffer;
  }

  interface RunCommandParams {
    cmd: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    sudo?: boolean;
  }

  /** Subset of actual CommandFinished class — see SDK docs for full API. */
  interface CommandFinished {
    exitCode: number;
    stdout(): Promise<string>;
    stderr(): Promise<string>;
  }

  /** Network policy update — replaces the current firewall configuration. */
  type NetworkPolicyUpdate =
    | "deny-all"
    | "allow-all"
    | { allow?: string[] | Record<string, unknown>; subnets?: { allow?: string[]; deny?: string[] } };

  class Sandbox {
    static create(opts?: SandboxCreateOptions): Promise<Sandbox>;
    mkDir(path: string): Promise<void>;
    writeFiles(files: WriteFileEntry[]): Promise<void>;
    runCommand(params: RunCommandParams): Promise<CommandFinished>;
    runCommand(
      command: string,
      args?: string[],
      opts?: { signal?: AbortSignal }
    ): Promise<CommandFinished>;
    updateNetworkPolicy(policy: NetworkPolicyUpdate): Promise<void>;
    stop(): Promise<Sandbox>;
  }
}
