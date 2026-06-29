/**
 * `atlas login` / `atlas logout` (#4043 / ADR-0026).
 *
 * `atlas login` runs the OAuth 2.0 device-authorization flow (RFC 8628): it
 * prints a user code + verification URL, the human approves in a browser while
 * signed in to Atlas, and the CLI polls for a Better Auth session bearer which
 * it stores in `~/.atlas/credentials`. The bearer is stamped `origin='cli'`
 * server-side, so it resolves org-role-only for its bound workspace.
 *
 * A single-workspace account auto-binds (the session's only org). A
 * multi-workspace account logs in with no bound workspace yet — the in-flow
 * workspace picker is the named ADR-0026 follow-up; `atlas login` says so
 * plainly rather than guessing a workspace.
 */

import { resolveApiBaseUrl } from "../lib/api-base";
import {
  ATLAS_CLI_CLIENT_ID,
  DeviceFlowError,
  pollForToken,
  requestDeviceCode,
} from "../lib/device-flow";
import { saveSession, clearSession, credentialsPath } from "../lib/credentials";

/** Best-effort read of the bound workspace from a freshly-issued bearer. */
async function fetchBoundWorkspace(baseUrl: string, token: string): Promise<string | null> {
  try {
    const res = await fetch(`${baseUrl}/api/auth/get-session`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      // Log so a server-side failure (e.g. 500) isn't presented downstream as a
      // benign "multiple workspaces" state.
      console.error(`  (could not read bound workspace: get-session returned HTTP ${res.status})`);
      return null;
    }
    // intentionally ignored: an empty/non-JSON body yields no orgId → treated
    // as "no bound workspace", same as the multi-workspace path.
    const body = (await res.json().catch(() => null)) as
      | { session?: { activeOrganizationId?: unknown } }
      | null;
    const orgId = body?.session?.activeOrganizationId;
    return typeof orgId === "string" && orgId.length > 0 ? orgId : null;
  } catch (err) {
    // Best-effort: the bearer is already stored; a get-session blip only means
    // we can't display the bound workspace, not that login failed.
    console.error(
      `  (could not read bound workspace: ${err instanceof Error ? err.message : String(err)})`,
    );
    return null;
  }
}

export async function handleLogin(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "Usage: atlas login\n\n" +
        "Authenticate the Atlas CLI via the OAuth 2.0 device flow. Prints a code,\n" +
        "you approve it in your browser, and the session is stored in ~/.atlas/credentials.\n\n" +
        "Environment:\n" +
        "  ATLAS_API_URL    API server URL (default: http://localhost:3001)\n",
    );
    return;
  }

  const baseUrl = resolveApiBaseUrl();

  let deviceCode;
  try {
    deviceCode = await requestDeviceCode(baseUrl, { clientId: ATLAS_CLI_CLIENT_ID });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const verifyUrl = deviceCode.verification_uri_complete || deviceCode.verification_uri;
  console.log("\nTo finish signing in, open this URL in your browser:\n");
  console.log(`    ${deviceCode.verification_uri}\n`);
  console.log(`And enter the code:  ${deviceCode.user_code}\n`);
  if (deviceCode.verification_uri_complete) {
    console.log(`(or open the direct link: ${verifyUrl})\n`);
  }
  console.log("Waiting for approval...");

  let token: string;
  try {
    const result = await pollForToken(baseUrl, {
      clientId: ATLAS_CLI_CLIENT_ID,
      deviceCode: deviceCode.device_code,
      intervalSeconds: deviceCode.interval,
      onSlowDown: (s) => console.log(`(server asked us to slow down — polling every ${s}s)`),
    });
    token = result.token;
  } catch (err) {
    console.error(`\n${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const workspaceId = await fetchBoundWorkspace(baseUrl, token);

  try {
    saveSession(baseUrl, {
      token,
      workspaceId,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    // The token exchange succeeded but persisting it failed (EACCES on
    // ~/.atlas, ENOSPC, read-only home). Surface an actionable message rather
    // than a raw stack trace from the top-level handler.
    console.error(
      `\nLogged in, but failed to store credentials at ${credentialsPath()}: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        "Check permissions on ~/.atlas and run `atlas login` again.",
    );
    process.exit(1);
  }

  console.log("\n✓ Logged in. Credentials stored in ~/.atlas/credentials.");
  if (workspaceId) {
    console.log(`  Bound to workspace: ${workspaceId}`);
    console.log("  Try: atlas entities");
  } else {
    console.log(
      "  Your account belongs to more than one workspace, so no single workspace\n" +
        "  was auto-selected. Run `atlas switch` to choose which one the CLI acts on,\n" +
        "  or pass `--workspace <id>` per command.",
    );
  }
}

export async function handleLogout(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: atlas logout\n\nRemove the stored Atlas CLI credentials for the current API URL.\n");
    return;
  }
  const baseUrl = resolveApiBaseUrl();
  const removed = clearSession(baseUrl);
  console.log(
    removed
      ? "✓ Logged out. Stored credentials removed."
      : "You were not logged in for this API URL.",
  );
}

// Re-export so callers (and tests) that only want the device-flow error type
// don't reach across modules.
export { DeviceFlowError };
