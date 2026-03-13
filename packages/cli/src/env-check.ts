import * as fs from "fs";
import * as path from "path";
import * as p from "@clack/prompts";

/** Commands that typically need environment variables (.env) to function. */
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
 * Skips silently if neither file exists (embedded deploy) or if stdin is not a TTY.
 */
export async function checkEnvFile(command: string | undefined): Promise<void> {
  if (!command || !ENV_COMMANDS.has(command)) return;

  const envPath = path.join(process.cwd(), ".env");
  const examplePath = path.join(process.cwd(), ".env.example");

  const envExists = fs.existsSync(envPath);
  if (envExists) return;

  const exampleExists = fs.existsSync(examplePath);
  if (!exampleExists) return;

  // Non-interactive: warn but don't block
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
    fs.copyFileSync(examplePath, envPath);
    p.log.success(
      "Created .env — edit it with your database URL and API key.",
    );
  }
}
