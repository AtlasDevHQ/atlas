/**
 * Sidecar auth configuration — resolved once at boot, fail-closed.
 *
 * The sidecar executes arbitrary bash and Python, so running it without auth
 * is only acceptable when an operator has explicitly opted in for loopback
 * local dev. A missing token is a misconfiguration, not a default: the server
 * refuses to boot rather than silently accepting unauthenticated /exec.
 *
 * Kept in a standalone module (server.ts has top-level Bun.serve side effects)
 * so the boot decision can be unit-tested directly.
 */

export type SidecarAuthConfig =
  | { mode: "token"; token: string }
  | { mode: "disabled" };

/**
 * Resolve the auth mode from the environment. Throws when no token is set and
 * auth was not explicitly disabled — callers should treat that as a fatal
 * boot error.
 */
export function resolveSidecarAuth(env: {
  SIDECAR_AUTH_TOKEN?: string;
  SIDECAR_AUTH_DISABLE?: string;
}): SidecarAuthConfig {
  if (env.SIDECAR_AUTH_TOKEN) {
    return { mode: "token", token: env.SIDECAR_AUTH_TOKEN };
  }
  if (env.SIDECAR_AUTH_DISABLE === "1") {
    return { mode: "disabled" };
  }
  throw new Error(
    "SIDECAR_AUTH_TOKEN is not set. The sidecar executes arbitrary commands and refuses to start without auth. " +
      "Set SIDECAR_AUTH_TOKEN to a shared secret (matching the API service), or set SIDECAR_AUTH_DISABLE=1 " +
      "to explicitly run without auth (local loopback dev only — never expose the port).",
  );
}
