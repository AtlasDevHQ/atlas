/**
 * Minimal type declarations for @vercel/sandbox ^2.x (optional dependency).
 * These declarations provide type safety on environments where the optional
 * package is not installed (e.g., self-hosted Docker deployments).
 * When @vercel/sandbox is installed, its own types take precedence.
 *
 * Last synced with: @vercel/sandbox@2.0.2 SDK reference
 *
 * v2 migration notes (only the surface Atlas uses is mirrored here):
 *  - `Sandbox` stays the public class — v2 ADDED `Session` (the inner running
 *    VM) but did NOT rename `Sandbox`. `create`/`runCommand`/`mkDir`/
 *    `writeFiles`/`stop`/`updateNetworkPolicy` all survive.
 *  - `writeFiles` content widened to `string | Uint8Array` (+ optional `mode`);
 *    `Buffer` (what Atlas passes) is a `Uint8Array`, so it still satisfies it.
 *  - `stop()` now resolves to session/snapshot metadata, not the `Sandbox`.
 *    Atlas ignores the return, so it is typed loosely here.
 *  - `updateNetworkPolicy` is `@deprecated` upstream in favour of
 *    `update({ networkPolicy })`. We deliberately keep calling it (it still
 *    works in v2, no lint rule flags it) so this dep bump stays minimal and the
 *    `Parameters<updateNetworkPolicy>[0]` security invariant in
 *    `tools/backends/network-allowlist.ts` is preserved verbatim. The `@deprecated`
 *    tag is intentionally NOT mirrored here. Migrating to `.update()` is a
 *    tracked follow-up.
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
    /**
     * v2 accepts `string | Uint8Array`. Atlas always passes a `Buffer`
     * (a `Uint8Array` subclass), but the wider type mirrors the real SDK.
     */
    content: string | Uint8Array;
    /** File mode (permissions), e.g. `0o755`. Added in v2; Atlas never sets it. */
    mode?: number;
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

  /** A transform applied to network requests matching a domain rule. */
  type NetworkTransformer = { headers?: Record<string, string> };

  /**
   * A rule applied to requests matching a domain. An empty rule list (`[]`)
   * allows traffic with no transform; a non-empty list can inject headers
   * (e.g. an `authorization` credential). Atlas's allowlist deliberately only
   * ever emits `[]` — see `tools/backends/network-allowlist.ts`.
   */
  type NetworkPolicyRule = { transform?: NetworkTransformer[] };

  /**
   * Network policy update — replaces the current firewall configuration.
   * Mirrors the installed SDK's `NetworkPolicy` shape (record values are
   * `NetworkPolicyRule[]`, NOT `unknown`) so `satisfies NetworkPolicyUpdate`
   * actually rejects a junk/credential-bearing per-host value at compile time.
   */
  type NetworkPolicyUpdate =
    | "deny-all"
    | "allow-all"
    | {
        allow?: string[] | Record<string, NetworkPolicyRule[]>;
        subnets?: { allow?: string[]; deny?: string[] };
      };

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
    // v2 resolves to the applied NetworkPolicy; Atlas ignores the return.
    updateNetworkPolicy(policy: NetworkPolicyUpdate): Promise<unknown>;
    // v2 resolves to session/snapshot metadata (not the Sandbox); ignored.
    stop(): Promise<unknown>;
  }
}
