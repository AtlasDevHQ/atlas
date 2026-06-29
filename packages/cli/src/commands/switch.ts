/**
 * `atlas switch` (#4050 / ADR-0025 sub-decision 2) — choose which workspace the
 * CLI acts on, for users who belong to more than one.
 *
 *   atlas switch                 # interactive pick, persists the chosen default
 *   atlas switch <id|slug>       # non-interactive switch by id or slug
 *
 * Reuses the Better Auth organization plugin (no new server infra):
 *   1. `listWorkspaces`     → GET  /api/auth/organization/list
 *   2. `setActiveWorkspace` → POST /api/auth/organization/set-active   (membership gate)
 *   3. `updateSessionWorkspace` persists the choice in ~/.atlas/credentials.
 *
 * The per-command `--workspace <id>` override (see `resolveActiveWorkspace`)
 * shares the same set-active gate but does NOT persist a new default.
 */

import * as p from "@clack/prompts";

import { resolveApiBaseUrl } from "../lib/api-base";
import { readSession, updateSessionWorkspace } from "../lib/credentials";
import {
  listWorkspaces,
  setActiveWorkspace,
  formatWorkspaceError,
  type WorkspaceSummary,
} from "../lib/workspaces";

type FetchImpl = typeof fetch;

/** The persisted outcome of a switch: the workspace the server activated. */
export interface SwitchResult {
  readonly active: WorkspaceSummary;
  /** false when the local credential vanished between set-active and persist. */
  readonly persisted: boolean;
}

/** Match an explicit `id|slug` token against the user's workspaces. */
export function matchWorkspace(
  workspaces: WorkspaceSummary[],
  token: string,
): WorkspaceSummary | undefined {
  return workspaces.find((w) => w.id === token || w.slug === token);
}

/** Format a workspace for display: "Name (slug)" or "Name" when slug-less. */
export function formatWorkspaceLabel(w: WorkspaceSummary): string {
  return w.slug ? `${w.name} (${w.slug})` : w.name;
}

/**
 * Commit a chosen workspace: rebind the server session via the membership-gated
 * set-active, then persist the SERVER-RETURNED id as the new local default
 * (never the requested `chosenId` — the server is authoritative, and `chosenId`
 * may be a slug-resolved or raw unknown token). Extracted from `handleSwitch`
 * so the load-bearing set-active → persist sequence is unit-testable with an
 * injectable `fetchImpl` / `configDir`; the interactive picker stays in the
 * handler. Throws {@link WorkspaceError} on a rejected/unreachable switch.
 */
export async function commitSwitch(
  baseUrl: string,
  token: string,
  chosenId: string,
  opts: { fetchImpl?: FetchImpl; configDir?: string } = {},
): Promise<SwitchResult> {
  const active = await setActiveWorkspace(baseUrl, token, chosenId, {
    fetchImpl: opts.fetchImpl,
  });
  const persisted = updateSessionWorkspace(baseUrl, active.id, opts.configDir);
  return { active, persisted };
}

export async function handleSwitch(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "Usage: atlas switch [<id|slug>]\n\n" +
        "Choose which workspace the Atlas CLI acts on and persist it as the default.\n" +
        "With no argument, lists your workspaces and prompts you to pick one.\n" +
        "Requires `atlas login` first.\n\n" +
        "Environment:\n" +
        "  ATLAS_API_URL    API server URL (default: http://localhost:3001)\n",
    );
    return;
  }

  const baseUrl = resolveApiBaseUrl();
  const session = readSession(baseUrl);
  if (!session) {
    console.error("Not logged in. Run `atlas login` first.");
    process.exit(1);
  }

  // The first non-flag positional after the command name is an optional target.
  const target = args.slice(1).find((a) => !a.startsWith("-"));

  let workspaces: WorkspaceSummary[];
  try {
    workspaces = await listWorkspaces(baseUrl, session.token);
  } catch (err) {
    console.error(formatWorkspaceError(err));
    process.exit(1);
  }

  if (workspaces.length === 0) {
    console.error("Your account doesn't belong to any workspaces yet.");
    process.exit(1);
  }

  let chosenId: string;

  if (target) {
    // Non-interactive: resolve a slug locally to an id; an unknown token still
    // goes to the server so the authoritative server error is surfaced —
    // membership rejection if you were just removed from it, not-found otherwise.
    const matched = matchWorkspace(workspaces, target);
    chosenId = matched?.id ?? target;
  } else {
    if (!process.stdout.isTTY) {
      console.error(
        "Multiple workspaces available — pass one explicitly: `atlas switch <id|slug>`.\n" +
          "(No TTY for the interactive picker.)",
      );
      process.exit(1);
    }
    if (workspaces.length === 1) {
      // Nothing to pick — bind to the only one and say so.
      chosenId = workspaces[0].id;
    } else {
      const choice = await p.select({
        message: "Which workspace should the Atlas CLI act on?",
        options: workspaces.map((w) => ({
          value: w.id,
          label: formatWorkspaceLabel(w),
          hint: w.id === session.workspaceId ? "current default" : undefined,
        })),
        initialValue: session.workspaceId ?? workspaces[0].id,
      });
      if (p.isCancel(choice)) {
        console.log("Cancelled — workspace unchanged.");
        return;
      }
      chosenId = choice;
    }
  }

  let result: SwitchResult;
  try {
    result = await commitSwitch(baseUrl, session.token, chosenId);
  } catch (err) {
    console.error(formatWorkspaceError(err));
    process.exit(1);
  }

  if (!result.persisted) {
    console.error(
      "Switched on the server, but the local credential disappeared mid-switch. Run `atlas login` again.",
    );
    process.exit(1);
  }

  console.log(`✓ Switched to ${formatWorkspaceLabel(result.active)}.`);
  console.log(`  Default workspace saved as: ${result.active.id}`);
}
