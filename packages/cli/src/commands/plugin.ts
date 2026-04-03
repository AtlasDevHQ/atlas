/**
 * atlas plugin subcommands — list, create, and add plugins.
 *
 * Extracted from atlas.ts to reduce monolith size.
 */

import * as fs from "fs";
import * as path from "path";
import { getFlag } from "../../lib/cli-utils";
import { renderTable } from "../../lib/output";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PluginInfo {
  id: string;
  types: string[];
  version: string;
  name?: string;
  healthy?: boolean;
  healthMessage?: string;
}

const PLUGIN_TYPES = [
  "datasource",
  "context",
  "interaction",
  "action",
  "sandbox",
] as const;
export type ScaffoldPluginType = (typeof PLUGIN_TYPES)[number];

function isValidPluginType(t: string): t is ScaffoldPluginType {
  return (PLUGIN_TYPES as readonly string[]).includes(t);
}

// ---------------------------------------------------------------------------
// Plugin list
// ---------------------------------------------------------------------------

export async function handlePluginList(): Promise<void> {
  let loadConfig: Awaited<
    typeof import("@atlas/api/lib/config")
  >["loadConfig"];
  try {
    ({ loadConfig } = await import("@atlas/api/lib/config"));
  } catch (err) {
    console.error(
      `Error: Could not load Atlas config module: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error(
      "  Ensure @atlas/api is installed (run 'bun install' from the project root).",
    );
    process.exit(1);
  }

  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    console.error(
      `Error loading config: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  const plugins = config.plugins as
    | Array<Record<string, unknown>>
    | undefined;
  if (!plugins?.length) {
    console.log("No plugins configured in atlas.config.ts.");
    return;
  }

  const infos: PluginInfo[] = [];
  for (const p of plugins) {
    const info: PluginInfo = {
      id: String(p.id ?? "unknown"),
      types: Array.isArray(p.types)
        ? (p.types as string[]).map(String)
        : ["unknown"],
      version: String(p.version ?? "unknown"),
      name: p.name ? String(p.name) : undefined,
    };

    if (typeof p.healthCheck === "function") {
      try {
        const result = await (
          p.healthCheck as () => Promise<{
            healthy: boolean;
            message?: string;
          }>
        )();
        info.healthy = result.healthy;
        info.healthMessage = result.message;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err);
        console.warn(
          `  Warning: Health check failed for plugin "${info.id}": ${message}`,
        );
        info.healthy = false;
        info.healthMessage = message;
      }
    }

    infos.push(info);
  }

  const columns = ["Name", "ID", "Type", "Version", "Health"];
  const rows = infos.map((info) => ({
    Name: info.name ?? info.id,
    ID: info.id,
    Type: info.types.join(", "),
    Version: info.version,
    Health:
      info.healthy === undefined
        ? "no check"
        : info.healthy
          ? "healthy"
          : `unhealthy${info.healthMessage ? `: ${info.healthMessage}` : ""}`,
  }));

  console.log(renderTable(columns, rows));
  console.log(`${infos.length} plugin(s) registered.`);
}

// ---------------------------------------------------------------------------
// Plugin template generation
// ---------------------------------------------------------------------------

/** Generate src/index.ts template for a scaffolded plugin, varying by plugin type. */
export function pluginTemplate(
  name: string,
  pluginType: ScaffoldPluginType,
): string {
  const id = name;
  const pascalName = name
    .split(/[-_]/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");

  switch (pluginType) {
    case "datasource":
      return `import { definePlugin } from "@useatlas/plugin-sdk";
import type { AtlasDatasourcePlugin, PluginDBConnection } from "@useatlas/plugin-sdk";

export default definePlugin({
  id: "${id}",
  types: ["datasource"],
  version: "0.1.0",
  name: "${pascalName}",

  connection: {
    create(): PluginDBConnection {
      // TODO: Return a PluginDBConnection that wraps your database driver
      throw new Error("Not implemented — replace with your connection factory");
    },
    dbType: "postgres",
  },

  async initialize(ctx) {
    ctx.logger.info("${pascalName} datasource plugin initialized");
  },

  async healthCheck() {
    // TODO: Implement a real health check (e.g. run SELECT 1)
    return { healthy: true };
  },
} satisfies AtlasDatasourcePlugin);
`;

    case "context":
      return `import { definePlugin } from "@useatlas/plugin-sdk";
import type { AtlasContextPlugin } from "@useatlas/plugin-sdk";

export default definePlugin({
  id: "${id}",
  types: ["context"],
  version: "0.1.0",
  name: "${pascalName}",

  contextProvider: {
    async load(): Promise<string> {
      // TODO: Return additional context (system prompt fragments, entity YAML, etc.)
      return "Additional context from ${pascalName} plugin.";
    },
    async refresh(): Promise<void> {
      // TODO: Implement cache invalidation if needed
    },
  },

  async initialize(ctx) {
    ctx.logger.info("${pascalName} context plugin initialized");
  },

  async healthCheck() {
    return { healthy: true };
  },
} satisfies AtlasContextPlugin);
`;

    case "interaction":
      return `import { definePlugin } from "@useatlas/plugin-sdk";
import type { AtlasInteractionPlugin } from "@useatlas/plugin-sdk";
import type { Hono } from "hono";

export default definePlugin({
  id: "${id}",
  types: ["interaction"],
  version: "0.1.0",
  name: "${pascalName}",

  routes(app: Hono) {
    // TODO: Add your routes
    app.get("/api/${id}/status", (c) => c.json({ status: "ok" }));
  },

  async initialize(ctx) {
    ctx.logger.info("${pascalName} interaction plugin initialized");
  },

  async healthCheck() {
    return { healthy: true };
  },
} satisfies AtlasInteractionPlugin);
`;

    case "action":
      return `import { definePlugin } from "@useatlas/plugin-sdk";
import type { AtlasActionPlugin } from "@useatlas/plugin-sdk";
import { tool } from "ai";
import { z } from "zod";

export default definePlugin({
  id: "${id}",
  types: ["action"],
  version: "0.1.0",
  name: "${pascalName}",

  actions: [
    {
      name: "${id}Action",
      description: "TODO: Describe what this action does",
      tool: tool({
        description: "TODO: Describe the tool",
        parameters: z.object({
          input: z.string().describe("The input for this action"),
        }),
        execute: async ({ input }) => {
          // TODO: Implement the action
          return { success: true, input };
        },
      }),
      actionType: "${id}:execute",
      reversible: false,
      defaultApproval: "manual",
      requiredCredentials: [],
    },
  ],

  async initialize(ctx) {
    ctx.logger.info("${pascalName} action plugin initialized");
  },

  async healthCheck() {
    return { healthy: true };
  },
} satisfies AtlasActionPlugin);
`;

    case "sandbox":
      return `import { definePlugin } from "@useatlas/plugin-sdk";
import type { AtlasSandboxPlugin, PluginExploreBackend, PluginExecResult } from "@useatlas/plugin-sdk";

export default definePlugin({
  id: "${id}",
  types: ["sandbox"],
  version: "0.1.0",
  name: "${pascalName}",

  sandbox: {
    create(semanticRoot: string): PluginExploreBackend {
      // TODO: Return a PluginExploreBackend that runs commands in your sandbox
      throw new Error("Not implemented — replace with your sandbox backend");
    },
    priority: 60,
  },

  security: {
    networkIsolation: false,
    filesystemIsolation: false,
    unprivilegedExecution: false,
    description: "TODO: Describe the isolation guarantees of this sandbox",
  },

  async initialize(ctx) {
    ctx.logger.info("${pascalName} sandbox plugin initialized");
  },

  async healthCheck() {
    // TODO: Implement a real health check (e.g. verify sandbox runtime is available)
    return { healthy: true };
  },
} satisfies AtlasSandboxPlugin);
`;
  }
}

/** Generate test template for a scaffolded plugin, with assertions for the given plugin type. */
export function pluginTestTemplate(
  name: string,
  pluginType: ScaffoldPluginType,
): string {
  return `import { describe, expect, test } from "bun:test";
import plugin from "./index";

describe("${name} plugin", () => {
  test("has correct id and type", () => {
    expect(plugin.id).toBe("${name}");
    expect(plugin.types).toContain("${pluginType}");
  });

  test("has a version string", () => {
    expect(typeof plugin.version).toBe("string");
    expect(plugin.version.length).toBeGreaterThan(0);
  });

  test("healthCheck returns healthy", async () => {
    const result = await plugin.healthCheck?.();
    expect(result?.healthy).toBe(true);
  });
});
`;
}

/** Generate package.json for a scaffolded plugin. Package is named "atlas-plugin-{name}". */
export function pluginPackageJsonTemplate(name: string): string {
  return (
    JSON.stringify(
      {
        name: `atlas-plugin-${name}`,
        version: "0.1.0",
        private: true,
        main: "src/index.ts",
        scripts: {
          test: "bun test src/index.test.ts",
        },
        peerDependencies: {
          "@useatlas/plugin-sdk": "workspace:*",
        },
        devDependencies: {
          "@useatlas/plugin-sdk": "workspace:*",
        },
      },
      null,
      2,
    ) + "\n"
  );
}

/** Generate tsconfig.json for a scaffolded plugin at plugins/{name}/. Extends root tsconfig three levels up. */
export function pluginTsconfigTemplate(): string {
  return (
    JSON.stringify(
      {
        extends: "../../../tsconfig.json",
        compilerOptions: {
          outDir: "./dist",
          rootDir: "./src",
        },
        include: ["src"],
      },
      null,
      2,
    ) + "\n"
  );
}

// ---------------------------------------------------------------------------
// Plugin create
// ---------------------------------------------------------------------------

export async function handlePluginCreate(args: string[]): Promise<void> {
  // Expected args: ["create", "<name>", "--type", "<type>"]
  const createIdx = args.indexOf("create");
  const name = args[createIdx + 1];
  if (!name || name.startsWith("--")) {
    console.error(
      "Usage: atlas plugin create <name> --type <datasource|context|interaction|action|sandbox>",
    );
    process.exit(1);
  }

  const typeArg = getFlag(args, "--type");
  if (!typeArg || !isValidPluginType(typeArg)) {
    console.error(
      `Error: --type is required and must be one of: ${PLUGIN_TYPES.join(", ")}`,
    );
    process.exit(1);
  }

  if (!/^[a-zA-Z][a-zA-Z0-9-_]*$/.test(name)) {
    console.error(
      "Error: Plugin name must start with a letter and contain only letters, digits, hyphens, and underscores.",
    );
    process.exit(1);
  }

  const pluginDir = path.resolve("plugins", name);
  const srcDir = path.join(pluginDir, "src");

  if (fs.existsSync(pluginDir)) {
    console.error(`Error: Directory already exists: ${pluginDir}`);
    process.exit(1);
  }

  fs.mkdirSync(srcDir, { recursive: true });

  try {
    fs.writeFileSync(
      path.join(srcDir, "index.ts"),
      pluginTemplate(name, typeArg),
    );
    fs.writeFileSync(
      path.join(srcDir, "index.test.ts"),
      pluginTestTemplate(name, typeArg),
    );
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      pluginPackageJsonTemplate(name),
    );
    fs.writeFileSync(
      path.join(pluginDir, "tsconfig.json"),
      pluginTsconfigTemplate(),
    );
  } catch (err) {
    try {
      fs.rmSync(pluginDir, { recursive: true, force: true });
    } catch {
      // intentionally ignored: best-effort cleanup of partially created directory
    }
    console.error(
      `Error: Failed to write plugin files: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  console.log(
    `Created ${typeArg} plugin scaffold at ${path.relative(process.cwd(), pluginDir)}/`,
  );
  console.log("");
  console.log("Files:");
  console.log(`  src/index.ts       — Plugin implementation (definePlugin)`);
  console.log(`  src/index.test.ts  — Basic lifecycle tests`);
  console.log(`  package.json       — Package manifest`);
  console.log(`  tsconfig.json      — TypeScript config`);
  console.log("");
  console.log("Next steps:");
  console.log(`  1. Implement your plugin in src/index.ts`);
  console.log(`  2. Add to atlas.config.ts:`);
  console.log(
    `     import plugin from "./plugins/${name}/src/index";`,
  );
  console.log(
    `     export default defineConfig({ plugins: [plugin] });`,
  );
  console.log(`  3. Run tests: cd plugins/${name} && bun test`);
}

// ---------------------------------------------------------------------------
// Plugin add
// ---------------------------------------------------------------------------

export async function handlePluginAdd(args: string[]): Promise<void> {
  // Expected args: ["add", "<package-name>"]
  const addIdx = args.indexOf("add");
  const packageName = args[addIdx + 1];
  if (!packageName || packageName.startsWith("--")) {
    console.error("Usage: atlas plugin add <package-name>");
    process.exit(1);
  }

  console.log(`Installing ${packageName}...`);

  let exitCode: number;
  try {
    const proc = Bun.spawn(["bun", "add", packageName], {
      stdout: "inherit",
      stderr: "inherit",
    });
    exitCode = await proc.exited;
  } catch (err) {
    console.error(
      `Error: Failed to run "bun add ${packageName}": ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  if (exitCode !== 0) {
    console.error(
      `\nFailed to install ${packageName} (exit code ${exitCode}).`,
    );
    process.exit(1);
  }

  console.log("");
  console.log(
    `Installed ${packageName}. Now add it to your atlas.config.ts:`,
  );
  console.log("");
  console.log(`  import { defineConfig } from "@atlas/api/lib/config";`);
  console.log(`  import myPlugin from "${packageName}";`);
  console.log("");
  console.log(`  export default defineConfig({`);
  console.log(`    plugins: [`);
  console.log(
    `      myPlugin, // or myPlugin() if it exports a factory`,
  );
  console.log(`    ],`);
  console.log(`  });`);
}

// ---------------------------------------------------------------------------
// Plugin router
// ---------------------------------------------------------------------------

export async function handlePlugin(args: string[]): Promise<void> {
  // args: ["plugin", <subcommand>, ...]
  const subcommand = args[1];

  if (subcommand === "list") {
    return handlePluginList();
  }

  if (subcommand === "create") {
    return handlePluginCreate(args.slice(1));
  }

  if (subcommand === "add") {
    return handlePluginAdd(args.slice(1));
  }

  console.error(
    "Usage: atlas plugin <list|create|add>\n\n" +
      "Subcommands:\n" +
      "  list                          List installed plugins from atlas.config.ts\n" +
      "  create <name> --type <type>   Scaffold a new plugin (datasource|context|interaction|action|sandbox)\n" +
      "  add <package-name>            Install a plugin package via bun\n",
  );
  process.exit(1);
}
