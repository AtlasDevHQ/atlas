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
            console.error(
              `[atlas] Skipping symlink escaping semantic root: ${localPath} -> ${realPath}`
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
          console.error(
            `[atlas] Skipping unreadable symlink ${localPath}:`,
            err instanceof Error ? err.message : String(err)
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
          console.error(
            `[atlas] Failed to read file ${localPath}:`,
            err instanceof Error ? err.message : String(err)
          );
        }
      }
    }
  }

  walk(localDir, sandboxDir);
  return results;
}

export async function createSandboxBackend(
  semanticRoot: string
): Promise<ExploreBackend> {
  // 1. Import the optional dependency
  let Sandbox: (typeof import("@vercel/sandbox"))["Sandbox"];
  try {
    ({ Sandbox } = await import("@vercel/sandbox"));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[atlas] Failed to import @vercel/sandbox:", detail);
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
    console.error("[atlas] Sandbox.create() failed:", detail);
    throw new Error(
      `Failed to create Vercel Sandbox: ${detail}. ` +
        "Check your Vercel deployment configuration and sandbox quotas.",
      { cause: err }
    );
  }

  // 3. Collect semantic layer files
  let files: { path: string; content: Buffer }[];
  try {
    files = collectSemanticFiles(semanticRoot, "/semantic");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[atlas] Failed to collect semantic layer files:", detail);
    throw new Error(
      `Cannot read semantic layer at ${semanticRoot}: ${detail}. ` +
        "Ensure the semantic/ directory exists and is readable.",
      { cause: err }
    );
  }

  if (files.length === 0) {
    console.error(
      "[atlas] No semantic layer files found in",
      semanticRoot,
      "— the sandbox will have an empty /semantic directory."
    );
    throw new Error(
      "No semantic layer files found. " +
        "Run 'bun run atlas -- init' to generate a semantic layer, then redeploy."
    );
  }

  // 4. Copy semantic files into the sandbox filesystem
  try {
    // Create directories (sorted ensures parents exist before children, since mkDir is not recursive)
    const dirs = new Set<string>();
    for (const f of files) {
      let dir = path.posix.dirname(f.path);
      while (dir !== "/" && dir !== ".") {
        dirs.add(dir);
        dir = path.posix.dirname(dir);
      }
    }
    for (const dir of [...dirs].sort()) {
      await sandbox.mkDir(dir);
    }

    await sandbox.writeFiles(files);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[atlas] Failed to write files into sandbox:", detail);
    throw new Error(
      `Failed to initialize sandbox filesystem: ${detail}. ` +
        "The sandbox was created but file upload failed.",
      { cause: err }
    );
  }

  return {
    exec: async (command: string): Promise<ExecResult> => {
      try {
        const result = await sandbox.runCommand({
          cmd: "sh",
          args: ["-c", command],
          cwd: "/semantic",
        });
        return {
          stdout: await result.stdout(),
          stderr: await result.stderr(),
          exitCode: result.exitCode,
        };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.error("[atlas] Sandbox command failed:", detail);
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
      await sandbox.stop();
    },
  };
}
