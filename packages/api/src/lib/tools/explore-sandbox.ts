/**
 * Vercel Sandbox backend for the explore tool.
 *
 * Uses @vercel/sandbox to run commands in an ephemeral microVM.
 * Only loaded when ATLAS_RUNTIME=vercel or running on the Vercel platform.
 *
 * Security: the sandbox runs with networkPolicy "deny-all" (no egress)
 * and its filesystem is ephemeral — writes do not affect the host.
 * Files from semantic/ are copied in at creation time.
 */

import type { ExploreBackend, ExecResult } from "./backends/types";
import { sandboxErrorDetail, safeError } from "./backends/shared";
import { vercelSandboxAccess, type RedactedSecret } from "./backends/detect";
import * as path from "path";
import * as fs from "fs";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("explore-sandbox");

function collectSemanticFiles(
  localDir: string,
  sandboxDir: string
): { path: string; content: Buffer }[] {
  const results: { path: string; content: Buffer }[] = [];

  function walk(dir: string, relative: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const localPath = path.join(dir, entry.name);
      const remotePath = `${relative}/${entry.name}`;

      if (entry.isSymbolicLink()) {
        // Resolve symlinks — they may point to directories or files
        try {
          const realPath = fs.realpathSync(localPath);
          if (!realPath.startsWith(localDir)) {
            log.warn(
              { localPath, realPath },
              "Skipping symlink escaping semantic root",
            );
            continue;
          }
          const stat = fs.statSync(localPath);
          if (stat.isDirectory()) {
            walk(localPath, remotePath);
          } else if (stat.isFile()) {
            results.push({
              path: remotePath,
              content: fs.readFileSync(localPath),
            });
          }
        } catch (err) {
          log.warn(
            { localPath, err: err instanceof Error ? err.message : String(err) },
            "Skipping unreadable symlink",
          );
        }
      } else if (entry.isDirectory()) {
        walk(localPath, remotePath);
      } else if (entry.isFile()) {
        try {
          results.push({
            path: remotePath,
            content: fs.readFileSync(localPath),
          });
        } catch (err) {
          log.error(
            { localPath, err: err instanceof Error ? err.message : String(err) },
            "Failed to read file",
          );
        }
      }
    }
  }

  walk(localDir, sandboxDir);
  return results;
}

// Prefix for sandbox file paths: the SDK resolves relative paths under /vercel/sandbox/.
const SANDBOX_SEMANTIC_REL = "semantic";
// Must match the absolute resolution of SANDBOX_SEMANTIC_REL (used as runCommand cwd).
const SANDBOX_SEMANTIC_CWD = "/vercel/sandbox/semantic";

/**
 * Explicit Vercel API credentials for sandbox creation. When provided
 * (the BYOC per-org path, #3370), they replace the operator-level env-var
 * detection entirely. The token carries the same RedactedSecret brand as
 * the operator path's VercelSandboxAccess, so an accidental structured log
 * of this object can't leak it — it's revealed only at Sandbox.create.
 */
export interface VercelSandboxAccessOverride {
  teamId: string;
  projectId: string;
  token: RedactedSecret;
  /**
   * Applied to provider error text before it is logged or embedded in error
   * messages. The BYOC path supplies an exact-match scrub of the org's
   * stored credential values: a provider error that echoes the rejected key
   * (e.g. a 401 on `Sandbox.create`) must not land in operator logs — this
   * module logs before the BYOC runtime's catch-site scrub ever sees the
   * error (#3413). Defaults to identity (the operator path logs its own
   * provider's errors).
   */
  scrubErrorDetail?: (detail: string) => string;
}

export async function createSandboxBackend(
  semanticRoot: string,
  accessOverride?: VercelSandboxAccessOverride
): Promise<ExploreBackend> {
  // Provider error text passes through this before any log or message —
  // see VercelSandboxAccessOverride.scrubErrorDetail (#3413).
  const scrubDetail = accessOverride?.scrubErrorDetail ?? ((detail: string) => detail);
  // 1. Import the optional dependency
  let Sandbox: (typeof import("@vercel/sandbox"))["Sandbox"];
  try {
    ({ Sandbox } = await import("@vercel/sandbox"));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.error({ err: detail }, "Failed to import @vercel/sandbox");
    throw new Error(
      "Vercel Sandbox runtime selected but @vercel/sandbox is not installed. " +
        "Run 'bun add @vercel/sandbox' or set ATLAS_RUNTIME to a different backend.",
      { cause: err }
    );
  }

  // 2. Create the sandbox. An accessOverride (per-org BYOC credentials)
  // takes precedence and is used verbatim. Otherwise, when
  // VERCEL_TEAM_ID/VERCEL_PROJECT_ID/VERCEL_TOKEN are set we're running
  // off-Vercel (e.g. Railway) and pass explicit operator credentials; on
  // Vercel itself, OIDC handles auth automatically and these are undefined.
  const access = accessOverride ?? vercelSandboxAccess();
  const explicitAccess = access
    ? {
        teamId: access.teamId,
        projectId: access.projectId,
        token: access.token.reveal(),
      }
    : undefined;
  let sandbox: InstanceType<typeof Sandbox>;
  try {
    sandbox = await Sandbox.create({
      runtime: "node24",
      networkPolicy: "deny-all",
      // v2 persists (snapshots) by default — force ephemeral so semantic
      // files never linger in Vercel snapshot storage after stop().
      persistent: false,
      ...(explicitAccess ?? {}),
    });
  } catch (err) {
    const detail = scrubDetail(err instanceof Error ? err.message : String(err));
    log.error({ err: detail }, "Sandbox.create() failed");
    throw new Error(
      `Failed to create Vercel Sandbox: ${detail}. ` +
        "Check your Vercel deployment configuration and sandbox quotas.",
      { cause: err }
    );
  }

  // v2: stop the sandbox automatically if the setup below throws. The disposer
  // swallows stop() errors (logging only) so the original setup error is the one
  // that surfaces — matching the previous hand-rolled try/finally. On success we
  // `disposer.move()` to disarm: the returned backend's close() owns it from then on.
  await using disposer = new AsyncDisposableStack();
  disposer.adopt(sandbox, async (s) => {
    try {
      await s.stop();
    } catch (stopErr) {
      log.warn(
        { err: scrubDetail(stopErr instanceof Error ? stopErr.message : String(stopErr)) },
        "Failed to stop sandbox during error cleanup",
      );
    }
  });

  // 3. Collect semantic layer files
  // Use relative paths so the SDK writes under /vercel/sandbox/ (the writable
  // base directory). Absolute root paths like /semantic cause the Sandbox API
  // to return HTTP 400 — the SDK resolves relative paths to /vercel/sandbox/.
  let files: { path: string; content: Buffer }[];
  try {
    files = collectSemanticFiles(semanticRoot, SANDBOX_SEMANTIC_REL);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.error({ err: detail }, "Failed to collect semantic layer files");
    throw new Error(
      `Cannot read semantic layer at ${semanticRoot}: ${detail}. ` +
        "Ensure the semantic/ directory exists and is readable.",
      { cause: err }
    );
  }

  if (files.length === 0) {
    log.error(
      { semanticRoot },
      "No semantic layer files found — sandbox will have empty semantic directory",
    );
    throw new Error(
      "No semantic layer files found. " +
        "Run 'bun run atlas -- init' to generate a semantic layer, then redeploy."
    );
  }

  // 4. Copy semantic files into the sandbox filesystem
  // Create directories first (mkDir is not recursive), then upload files.
  const dirs = new Set<string>();
  for (const f of files) {
    let dir = path.posix.dirname(f.path);
    while (dir !== "/" && dir !== ".") {
      dirs.add(dir);
      dir = path.posix.dirname(dir);
    }
  }

  for (const dir of [...dirs].sort()) {
    try {
      await sandbox.mkDir(dir);
    } catch (err) {
      const detail = scrubDetail(sandboxErrorDetail(err));
      log.error({ err: detail, dir }, "Failed to create directory in sandbox");
      throw new Error(
        `Failed to create directory "${dir}" in sandbox: ${safeError(detail)}.`,
        { cause: err },
      );
    }
  }

  try {
    await sandbox.writeFiles(files);
  } catch (err) {
    const detail = scrubDetail(sandboxErrorDetail(err));
    log.error({ err: detail, fileCount: files.length }, "Failed to write files into sandbox");
    throw new Error(
      `Failed to upload ${files.length} semantic files to sandbox: ${safeError(detail)}.`,
      { cause: err }
    );
  }

  // Setup succeeded — disarm the disposer so the sandbox survives in the
  // returned backend (close()/exec() own its lifecycle from here).
  disposer.move();

  return {
    exec: async (command: string): Promise<ExecResult> => {
      try {
        const result = await sandbox.runCommand({
          cmd: "sh",
          args: ["-c", command],
          cwd: SANDBOX_SEMANTIC_CWD,
        });
        return {
          stdout: await result.stdout(),
          stderr: await result.stderr(),
          exitCode: result.exitCode,
        };
      } catch (err) {
        const detail = scrubDetail(sandboxErrorDetail(err));
        log.error({ err: detail }, "Sandbox command failed");
        // Stop the broken sandbox before invalidating the cache
        try {
          await sandbox.stop();
        } catch (stopErr) {
          log.warn(
            { err: scrubDetail(stopErr instanceof Error ? stopErr.message : String(stopErr)) },
            "Failed to stop sandbox during error cleanup",
          );
        }
        // Invalidate cached backend so next call creates a fresh sandbox
        const { invalidateExploreBackend } = await import("./explore");
        invalidateExploreBackend();
        throw new Error(
          `Sandbox infrastructure error: ${detail}. Will retry with a fresh sandbox.`,
          { cause: err }
        );
      }
    },
    close: async () => {
      try {
        await sandbox.stop();
      } catch (err) {
        log.warn(
          { err: scrubDetail(err instanceof Error ? err.message : String(err)) },
          "Failed to stop sandbox during close",
        );
      }
    },
  };
}
