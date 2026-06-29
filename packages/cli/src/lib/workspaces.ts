/**
 * Atlas CLI workspace selection (#4050 / ADR-0025 sub-decision 2).
 *
 * Multi-workspace users pick which workspace the CLI acts on. This reuses the
 * Better Auth organization plugin already mounted under `/api/auth/*` — no new
 * server infra:
 *
 *   - `listWorkspaces`        → GET  /api/auth/organization/list
 *   - `setActiveWorkspace`    → POST /api/auth/organization/set-active
 *
 * Both authenticate with the `atlas login` session bearer (the `bearer()`
 * plugin admits it). `set-active` is authoritative for membership: it returns
 * `403 USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION` when the user isn't a member
 * of the target workspace, which is exactly the `--workspace <id>` rejection
 * the issue requires — we never re-implement the membership check client-side.
 *
 * `fetchImpl` is injectable so the HTTP shape is unit-testable without a live
 * server, matching the `device-flow.ts` convention.
 */

type FetchImpl = typeof fetch;

/** A workspace (Better Auth organization) the logged-in user belongs to. */
export interface WorkspaceSummary {
  /** Opaque workspace id — the value persisted + sent to `set-active`. */
  readonly id: string;
  /** Human-readable workspace name. */
  readonly name: string;
  /** URL-safe slug, when the organization has one. */
  readonly slug: string | null;
}

/** A workspace operation failure carrying a stable, branchable `code`. */
export class WorkspaceError extends Error {
  constructor(
    readonly code:
      | "network_error"
      | "unauthorized"
      | "not_a_member"
      | "not_found"
      | "request_failed",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

/**
 * Read the `--workspace <id>` override token from argv, or undefined when
 * absent. Accepts both the space-separated (`--workspace org_9`) and inline
 * (`--workspace=org_9`) forms so the override is never silently dropped — a
 * dropped override would quietly act on the default workspace while the user
 * believes they targeted another.
 */
export function readWorkspaceOverride(args: string[]): string | undefined {
  // Inline form: `--workspace=org_9` (take the LAST non-empty one so a later
  // flag wins). An empty inline (`--workspace=`) is ignored here rather than
  // short-circuiting, so a valid space form later in argv still resolves.
  const inline = args
    .filter((a) => a.startsWith("--workspace=") && a.length > "--workspace=".length)
    .at(-1);
  if (inline !== undefined) {
    return inline.slice("--workspace=".length);
  }
  // Space-separated form: `--workspace org_9`.
  const i = args.indexOf("--workspace");
  if (i === -1) return undefined;
  const value = args[i + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

/**
 * Resolve the workspace a single command should act on (#4050).
 *
 * SIDE EFFECT: when `--workspace <id>` is present this rebinds the live
 * server-side session to that workspace via `set-active` (the authoritative
 * membership gate — a non-member yields `not_a_member`) and returns that id
 * WITHOUT persisting a new local default. The caller MUST await this BEFORE
 * issuing its actual request, because that request relies on the server having
 * already rebound the bearer's active org — the returned id is then only used
 * for display/logging, not sent on the wire. When `--workspace` is absent this
 * is a pure read: it returns the stored default (which may be null for an
 * unbound single-/multi-workspace login) and makes no network call.
 */
export async function resolveActiveWorkspace(
  args: string[],
  baseUrl: string,
  token: string,
  storedWorkspaceId: string | null,
  opts: { fetchImpl?: FetchImpl } = {},
): Promise<string | null> {
  const override = readWorkspaceOverride(args);
  if (override === undefined) return storedWorkspaceId;
  const active = await setActiveWorkspace(baseUrl, token, override, opts);
  return active.id;
}

/**
 * Render a workspace failure for the CLI's stderr. A {@link WorkspaceError}
 * already carries an actionable, type-narrowed message; anything else is
 * narrowed the Atlas way. Shared by `switch` and every `--workspace`-aware
 * command so the surface for the same `code` can't drift between them.
 */
export function formatWorkspaceError(err: unknown): string {
  if (err instanceof WorkspaceError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** Coerce one `/organization/list` element into a {@link WorkspaceSummary}, or null when malformed. */
function coerceWorkspace(raw: unknown): WorkspaceSummary | null {
  const r = asRecord(raw);
  if (typeof r.id !== "string" || r.id.length === 0) return null;
  return {
    id: r.id,
    name: typeof r.name === "string" && r.name.length > 0 ? r.name : r.id,
    slug: typeof r.slug === "string" && r.slug.length > 0 ? r.slug : null,
  };
}

/**
 * List the workspaces the bearer's user belongs to (GET /organization/list).
 * Returns `[]` when the user has no workspaces; throws {@link WorkspaceError}
 * on auth/transport failure so the caller can branch on `.code`.
 */
export async function listWorkspaces(
  baseUrl: string,
  token: string,
  opts: { fetchImpl?: FetchImpl } = {},
): Promise<WorkspaceSummary[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/api/auth/organization/list`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new WorkspaceError(
      "network_error",
      `Could not reach the Atlas API at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (res.status === 401) {
    throw new WorkspaceError("unauthorized", "Your session is no longer valid. Run `atlas login` again.");
  }
  if (!res.ok) {
    throw new WorkspaceError("request_failed", `Failed to list workspaces (HTTP ${res.status}).`);
  }

  // intentionally ignored: a non-JSON / empty 2xx body degrades to "no
  // workspaces" rather than crashing — res.ok was already checked.
  const body = await res.json().catch(() => null);
  return asArray(body)
    .map(coerceWorkspace)
    .filter((w): w is WorkspaceSummary => w !== null);
}

/**
 * Bind the session to `workspaceId` (POST /organization/set-active). This is
 * the authoritative membership gate: a non-member target yields a
 * `not_a_member` {@link WorkspaceError}. Returns the activated workspace.
 */
export async function setActiveWorkspace(
  baseUrl: string,
  token: string,
  workspaceId: string,
  opts: { fetchImpl?: FetchImpl } = {},
): Promise<WorkspaceSummary> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/api/auth/organization/set-active`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ organizationId: workspaceId }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new WorkspaceError(
      "network_error",
      `Could not reach the Atlas API at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (res.status === 401) {
    throw new WorkspaceError("unauthorized", "Your session is no longer valid. Run `atlas login` again.");
  }
  if (res.status === 403) {
    throw new WorkspaceError(
      "not_a_member",
      `You are not a member of workspace ${workspaceId}. ` +
        "Run `atlas switch` to see the workspaces you can access.",
    );
  }
  if (res.status === 400 || res.status === 404) {
    throw new WorkspaceError(
      "not_found",
      `Workspace ${workspaceId} was not found. Run \`atlas switch\` to list your workspaces.`,
    );
  }
  if (!res.ok) {
    throw new WorkspaceError("request_failed", `Failed to switch workspace (HTTP ${res.status}).`);
  }

  // intentionally ignored: a non-JSON / empty 2xx body still means the switch
  // succeeded server-side — fall back to a minimal summary keyed by the id.
  const body = asRecord(await res.json().catch(() => null));
  return coerceWorkspace(body) ?? { id: workspaceId, name: workspaceId, slug: null };
}
