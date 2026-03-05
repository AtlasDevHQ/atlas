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

import type { ExploreBackend, ExecResult } from "./explore";
import * as path from "path";
import * as fs from "fs";
import { createLogger } from "@atlas/api/lib/logger";
import { SENSITIVE_PATTERNS } from "@atlas/api/lib/security";

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

/** Format an error for logging, with extra detail from @vercel/sandbox APIError json/text fields when present. */
function sandboxErrorDetail(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const detail = err.message;
  // APIError from @vercel/sandbox carries json/text with the server response.
  // These properties are not in our type stubs — discovered from runtime errors.
  const json = (err as unknown as Record<string, unknown>).json;
  const text = (err as unknown as Record<string, unknown>).text;
  if (json) {
    try {
      return `${detail} — response: ${JSON.stringify(json)}`;
    } catch {
      return `${detail} — response: [unserializable object]`;
    }
  }
  if (typeof text === "string" && text) return `${detail} — body: ${text.slice(0, 500)}`;
  return detail;
}

// Prefix for sandbox file paths: the SDK resolves relative paths under /vercel/sandbox/.
const SANDBOX_SEMANTIC_REL = "semantic";
// Must match the absolute resolution of SANDBOX_SEMANTIC_REL (used as runCommand cwd).
const SANDBOX_SEMANTIC_CWD = "/vercel/sandbox/semantic";

export async function createSandboxBackend(
  semanticRoot: string
): Promise<ExploreBackend> {
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

  // 2. Create the sandbox
  let sandbox: InstanceType<typeof Sandbox>;
  try {
    sandbox = await Sandbox.create({
      runtime: "node24",
      networkPolicy: "deny-all",
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.error({ err: detail }, "Sandbox.create() failed");
    throw new Error(
      `Failed to create Vercel Sandbox: ${detail}. ` +
        "Check your Vercel deployment configuration and sandbox quotas.",
      { cause: err }
    );
  }

  try {
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
        const detail = sandboxErrorDetail(err);
        log.error({ err: detail, dir }, "Failed to create directory in sandbox");
        const safeDetail = SENSITIVE_PATTERNS.test(detail)
          ? "sandbox API error (details in server logs)"
          : detail;
        throw new Error(
          `Failed to create directory "${dir}" in sandbox: ${safeDetail}.`,
          { cause: err },
        );
      }
    }

    try {
      await sandbox.writeFiles(files);
    } catch (err) {
      const detail = sandboxErrorDetail(err);
      log.error({ err: detail, fileCount: files.length }, "Failed to write files into sandbox");
      const safeDetail = SENSITIVE_PATTERNS.test(detail)
        ? "sandbox API error (details in server logs)"
        : detail;
      throw new Error(
        `Failed to upload ${files.length} semantic files to sandbox: ${safeDetail}.`,
        { cause: err }
      );
    }
  } catch (err) {
    // Clean up the sandbox before re-throwing
    try {
      await sandbox.stop();
    } catch (stopErr) {
      log.warn(
        { err: stopErr instanceof Error ? stopErr.message : String(stopErr) },
        "Failed to stop sandbox during error cleanup",
      );
    }
    throw err;
  }

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
        const detail = sandboxErrorDetail(err);
        log.error({ err: detail }, "Sandbox command failed");
        // Stop the broken sandbox before invalidating the cache
        try {
          await sandbox.stop();
        } catch (stopErr) {
          log.warn(
            { err: stopErr instanceof Error ? stopErr.message : String(stopErr) },
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
          { err: err instanceof Error ? err.message : String(err) },
          "Failed to stop sandbox during close",
        );
      }
    },
  };
}
