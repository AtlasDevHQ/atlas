/**
 * Sidecar Sandbox Plugin — reference implementation for @useatlas/plugin-sdk.
 *
 * Demonstrates how the AtlasSandboxPlugin interface wraps the HTTP sidecar
 * isolation backend extracted from packages/api/src/lib/tools/explore-sidecar.ts.
 *
 * **Security:** This plugin provides container-level isolation via an HTTP sidecar:
 * - Network: isolated container boundary (no secrets, no DB drivers)
 * - Filesystem: container filesystem with only bash/coreutils + semantic/ files
 * - Communication: HTTP only between host and sidecar
 *
 * Usage in atlas.config.ts:
 * ```typescript
 * import { defineConfig } from "@atlas/api/lib/config";
 * import { sidecarSandboxPlugin } from "@useatlas/sidecar";
 *
 * export default defineConfig({
 *   plugins: [
 *     sidecarSandboxPlugin({ url: "http://sandbox-sidecar:8080" }),
 *   ],
 * });
 * ```
 */

import { z } from "zod";
import { createPlugin } from "@useatlas/plugin-sdk";
import type {
  AtlasSandboxPlugin,
  PluginExploreBackend,
  PluginExecResult,
  PluginHealthResult,
} from "@useatlas/plugin-sdk";

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

const SidecarSandboxConfigSchema = z.object({
  /** Sidecar service URL (e.g. http://sandbox-sidecar:8080). */
  url: z.string().url("url must be a valid URL"),
  /** Optional shared auth token. */
  authToken: z.string().optional(),
  /** Command timeout in ms. */
  timeoutMs: z.number().int().positive().optional().default(10000),
});

export type SidecarSandboxConfig = z.infer<typeof SidecarSandboxConfigSchema>;

// ---------------------------------------------------------------------------
// Response type (local — no import from @atlas/api)
// ---------------------------------------------------------------------------

interface SidecarExecResponse {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** HTTP-level timeout overhead — slightly longer than the command timeout. */
const HTTP_OVERHEAD_MS = 5_000;

// ---------------------------------------------------------------------------
// Backend factory
// ---------------------------------------------------------------------------

function createSidecarExploreBackend(
  baseUrl: URL,
  config: SidecarSandboxConfig,
): PluginExploreBackend {
  const execUrl = new URL("/exec", baseUrl).toString();

  return {
    exec: async (command: string): Promise<PluginExecResult> => {
      const timeout = config.timeoutMs;

      let response: Response;
      try {
        response = await fetch(execUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(config.authToken
              ? { Authorization: `Bearer ${config.authToken}` }
              : {}),
          },
          body: JSON.stringify({ command, timeout }),
          signal: AbortSignal.timeout(timeout + HTTP_OVERHEAD_MS),
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);

        // Connection refused — sidecar may be down
        if (
          detail.includes("ECONNREFUSED") ||
          detail.includes("fetch failed") ||
          detail.includes("Failed to connect")
        ) {
          throw new Error(
            `Sidecar unreachable at ${baseUrl.origin}: ${detail}. ` +
              "Check that the sandbox-sidecar service is running.",
            { cause: err },
          );
        }

        // Timeout
        if (
          detail.includes("TimeoutError") ||
          detail.includes("timed out") ||
          detail.includes("aborted")
        ) {
          return {
            stdout: "",
            stderr: `Command timed out after ${timeout}ms`,
            exitCode: 124,
          };
        }

        throw new Error(`Sidecar request failed: ${detail}`, { cause: err });
      }

      // Handle HTTP-level errors from the sidecar
      if (!response.ok) {
        let errorBody: string;
        try {
          errorBody = await response.text();
        } catch {
          errorBody = `HTTP ${response.status}`;
        }

        // 500 with exec response shape — the sidecar wraps execution errors
        if (response.status === 500) {
          try {
            const parsed = JSON.parse(errorBody);
            if (typeof parsed.exitCode === "number") {
              return {
                stdout: parsed.stdout ?? "",
                stderr: parsed.stderr ?? errorBody,
                exitCode: parsed.exitCode,
              };
            }
          } catch {
            // Sidecar returned non-JSON 500 body — fall through to generic error
          }
        }

        return {
          stdout: "",
          stderr: `Sidecar error (HTTP ${response.status}): ${errorBody.slice(0, 500)}`,
          exitCode: 1,
        };
      }

      // Parse the exec response
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return {
          stdout: "",
          stderr: `Failed to parse sidecar response: ${detail}`,
          exitCode: 1,
        };
      }

      if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof (parsed as Record<string, unknown>).exitCode !== "number"
      ) {
        return {
          stdout: "",
          stderr:
            "Sidecar returned an unexpected response format. Check ATLAS_SANDBOX_URL configuration.",
          exitCode: 1,
        };
      }

      const result = parsed as SidecarExecResponse;

      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: result.exitCode,
      };
    },

    async close() {
      // No-op — stateless HTTP
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin builder
// ---------------------------------------------------------------------------

export function buildSidecarSandboxPlugin(
  config: SidecarSandboxConfig,
): AtlasSandboxPlugin<SidecarSandboxConfig> {
  // URL is already validated by Zod's .url(), so this parse is safe.
  const baseUrl = new URL(config.url);

  return {
    id: "sidecar-sandbox",
    type: "sandbox" as const,
    version: "0.1.0",
    name: "Sidecar Sandbox",
    config,

    sandbox: {
      // _semanticRoot is unused — the sidecar container has its own filesystem
      // with semantic files baked into the Docker image. The host's semantic
      // root path is irrelevant since commands execute inside the container.
      create(_semanticRoot: string): PluginExploreBackend {
        return createSidecarExploreBackend(baseUrl, config);
      },
      priority: 50,
    },

    security: {
      networkIsolation: true,
      filesystemIsolation: true,
      unprivilegedExecution: true,
      description:
        "HTTP-isolated container with no secrets or DB drivers. " +
        "Communication occurs only via HTTP to the sidecar service.",
    },

    async initialize(ctx) {
      ctx.logger.info(
        `Sidecar sandbox plugin ready (url: ${baseUrl.origin})`,
      );
    },

    async healthCheck(): Promise<PluginHealthResult> {
      const healthUrl = `${baseUrl.origin}/health`;
      const start = performance.now();

      try {
        const response = await fetch(healthUrl, {
          signal: AbortSignal.timeout(5000),
        });

        const latencyMs = Math.round(performance.now() - start);

        if (response.ok) {
          return { healthy: true, latencyMs };
        }

        return {
          healthy: false,
          message: `Sidecar returned HTTP ${response.status}`,
          latencyMs,
        };
      } catch (err) {
        const latencyMs = Math.round(performance.now() - start);
        return {
          healthy: false,
          message: err instanceof Error ? err.message : String(err),
          latencyMs,
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Factory export
// ---------------------------------------------------------------------------

/**
 * Factory function for use in atlas.config.ts plugins array.
 *
 * @example
 * ```typescript
 * plugins: [sidecarSandboxPlugin({ url: "http://sandbox-sidecar:8080" })]
 * ```
 */
export const sidecarSandboxPlugin = createPlugin({
  configSchema: SidecarSandboxConfigSchema,
  create: buildSidecarSandboxPlugin,
});
