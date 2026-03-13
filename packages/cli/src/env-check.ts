import * as fs from "fs";
import * as path from "path";
import * as p from "@clack/prompts";

/** Commands that require a configured .env file for normal operation. */
export const ENV_COMMANDS = new Set([
  "init",
  "diff",
  "query",
  "doctor",
  "validate",
  "mcp",
  "migrate",
]);

/**
 * Check for missing .env file and offer to copy from .env.example.
 * Skips silently if neither file exists (embedded deploy).
 * In non-TTY environments, logs a warning instead of prompting.
 *
 * This is an advisory check — filesystem errors are caught and logged
 * as warnings so the CLI command can still proceed.
 */
export async function checkEnvFile(command: string | undefined): Promise<void> {
  if (!command || !ENV_COMMANDS.has(command)) return;

  let envPath: string;
  let examplePath: string;

  try {
    envPath = path.join(process.cwd(), ".env");
    examplePath = path.join(process.cwd(), ".env.example");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    p.log.warn(`Could not check for .env file: ${msg}`);
    return;
  }

  if (fs.existsSync(envPath)) return;
  if (!fs.existsSync(examplePath)) return;

  // Non-interactive (CI, piped): warn but don't block execution
  if (!process.stdin.isTTY) {
    p.log.warn(
      "No .env file found. Copy .env.example to .env and configure it.",
    );
    return;
  }

  const shouldCopy = await p.confirm({
    message: "No .env file found. Copy from .env.example?",
    initialValue: true,
  });

  if (p.isCancel(shouldCopy)) {
    p.cancel("Operation cancelled.");
    process.exit(0);
  }

  if (shouldCopy) {
    try {
      // COPYFILE_EXCL prevents overwriting if .env was created concurrently
      fs.copyFileSync(examplePath, envPath, fs.constants.COPYFILE_EXCL);
      p.log.success(
        "Created .env — edit it with your database URL and API key.",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      p.log.warn(
        `Could not copy .env.example to .env: ${msg}\nCopy it manually: cp .env.example .env`,
      );
    }
  }
}
