#!/usr/bin/env bun
import * as p from "@clack/prompts";
import pc from "picocolors";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

// Read version from package.json to stay in sync
const pkg = JSON.parse(
  fs.readFileSync(path.join(import.meta.dir, "package.json"), "utf-8")
);
const VERSION: string = pkg.version;

// Plugin types from the SDK
const PLUGIN_TYPES = ["datasource", "context", "interaction", "action", "sandbox"] as const;
type PluginType = (typeof PLUGIN_TYPES)[number];

// Parse CLI args
const args = process.argv.slice(2);
const useDefaults = args.includes("--defaults") || args.includes("-y");
const positionalArgs = args.filter((a, i) => {
  if (a.startsWith("-")) return false;
  // Skip values that follow --type or --scope
  if (i > 0 && (args[i - 1] === "--type" || args[i - 1] === "--scope")) return false;
  return true;
});

// Parse --type flag
let typeFlag: PluginType | undefined;
const typeArgIdx = args.indexOf("--type");
if (typeArgIdx !== -1) {
  const val = args[typeArgIdx + 1];
  if (!val || val.startsWith("-")) {
    console.error("--type requires a value. Available: " + PLUGIN_TYPES.join(", "));
    process.exit(1);
  }
  if (!PLUGIN_TYPES.includes(val as PluginType)) {
    console.error(`Unknown type "${val}". Available: ${PLUGIN_TYPES.join(", ")}`);
    process.exit(1);
  }
  typeFlag = val as PluginType;
}

// Parse --scope flag
let scopeFlag: string | undefined;
const scopeArgIdx = args.indexOf("--scope");
if (scopeArgIdx !== -1) {
  const val = args[scopeArgIdx + 1];
  if (!val || val.startsWith("-")) {
    console.error("--scope requires a value (e.g. @useatlas).");
    process.exit(1);
  }
  if (!val.startsWith("@")) {
    console.error(`Scope must start with @ (e.g. @useatlas). Got: "${val}"`);
    process.exit(1);
  }
  scopeFlag = val;
}

// Handle --help / -h
if (args.includes("--help") || args.includes("-h")) {
  console.log(`
  Usage: bun create @useatlas/plugin [plugin-name] [options]

  Options:
    --type <type>       Plugin type (${PLUGIN_TYPES.join(", ")}) [default: datasource]
    --scope <scope>     Package scope (e.g. @useatlas) [default: @useatlas]
    --defaults, -y      Use all default values (non-interactive)
    --help, -h          Show this help message

  Examples:
    bun create @useatlas/plugin my-plugin
    bun create @useatlas/plugin my-plugin --type context
    bun create @useatlas/plugin my-plugin --defaults
`);
  process.exit(0);
}

// Reject unknown flags
const knownFlags = new Set(["--defaults", "-y", "--help", "-h", "--type", "--scope"]);
const unknownFlags = args.filter((a, i) => {
  if (!a.startsWith("-")) return false;
  if (knownFlags.has(a)) return false;
  // --type/--scope value argument
  if (i > 0 && (args[i - 1] === "--type" || args[i - 1] === "--scope")) return false;
  return true;
});
if (unknownFlags.length > 0) {
  console.error(`Unknown flag(s): ${unknownFlags.join(", ")}`);
  console.error("Run with --help for usage information.");
  process.exit(1);
}

function bail(message?: string): never {
  p.cancel(message ?? "Setup cancelled.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Template generators
// ---------------------------------------------------------------------------

function generatePluginSource(pluginName: string, pluginType: PluginType): string {
  const id = pluginName;
  const nameTitle = pluginName
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

  switch (pluginType) {
    case "datasource":
      return `import { definePlugin } from "@useatlas/plugin-sdk";
import type {
  AtlasDatasourcePlugin,
  PluginDBConnection,
  PluginHealthResult,
} from "@useatlas/plugin-sdk";

/**
 * Build the plugin object. Exported for direct use and testing.
 */
export function build${toPascalCase(pluginName)}Plugin(): AtlasDatasourcePlugin {
  return definePlugin({
    id: "${id}",
    type: "datasource",
    version: "0.1.0",
    name: "${nameTitle}",

    connection: {
      create(): PluginDBConnection {
        // TODO: Replace with your database connection logic
        throw new Error("Not implemented — replace with your database driver");
      },
      dbType: "postgres", // TODO: Change to your database type
    },

    async initialize(ctx) {
      ctx.logger.info("${nameTitle} plugin initialized");
    },

    async healthCheck(): Promise<PluginHealthResult> {
      const start = performance.now();
      // TODO: Replace with a real connectivity check
      return {
        healthy: true,
        latencyMs: Math.round(performance.now() - start),
      };
    },
  });
}

/**
 * Factory function for use in atlas.config.ts plugins array.
 *
 * @example
 * \`\`\`typescript
 * import { defineConfig } from "@atlas/api/lib/config";
 * import { ${toCamelCase(pluginName)}Plugin } from "${id}";
 *
 * export default defineConfig({
 *   plugins: [${toCamelCase(pluginName)}Plugin()],
 * });
 * \`\`\`
 */
export function ${toCamelCase(pluginName)}Plugin(): AtlasDatasourcePlugin {
  return build${toPascalCase(pluginName)}Plugin();
}
`;

    case "context":
      return `import { definePlugin } from "@useatlas/plugin-sdk";
import type {
  AtlasContextPlugin,
  PluginHealthResult,
} from "@useatlas/plugin-sdk";

/**
 * Build the plugin object. Exported for direct use and testing.
 */
export function build${toPascalCase(pluginName)}Plugin(): AtlasContextPlugin {
  return definePlugin({
    id: "${id}",
    type: "context",
    version: "0.1.0",
    name: "${nameTitle}",

    contextProvider: {
      async load(): Promise<string> {
        // TODO: Return context string to inject into the agent system prompt
        return "## ${nameTitle} Context\\n\\nReplace this with your context data.";
      },

      async refresh(): Promise<void> {
        // TODO: Invalidate cached context if needed
      },
    },

    async initialize(ctx) {
      ctx.logger.info("${nameTitle} plugin initialized");
    },

    async healthCheck(): Promise<PluginHealthResult> {
      return { healthy: true };
    },
  });
}

/**
 * Factory function for use in atlas.config.ts plugins array.
 *
 * @example
 * \`\`\`typescript
 * import { defineConfig } from "@atlas/api/lib/config";
 * import { ${toCamelCase(pluginName)}Plugin } from "${id}";
 *
 * export default defineConfig({
 *   plugins: [${toCamelCase(pluginName)}Plugin()],
 * });
 * \`\`\`
 */
export function ${toCamelCase(pluginName)}Plugin(): AtlasContextPlugin {
  return build${toPascalCase(pluginName)}Plugin();
}
`;

    case "interaction":
      return `import { definePlugin } from "@useatlas/plugin-sdk";
import type {
  AtlasInteractionPlugin,
  PluginHealthResult,
} from "@useatlas/plugin-sdk";
import type { Hono } from "hono";

/**
 * Build the plugin object. Exported for direct use and testing.
 */
export function build${toPascalCase(pluginName)}Plugin(): AtlasInteractionPlugin {
  return definePlugin({
    id: "${id}",
    type: "interaction",
    version: "0.1.0",
    name: "${nameTitle}",

    routes(app: Hono) {
      // TODO: Mount your HTTP routes
      app.get("/api/${pluginName}/health", (c) => c.json({ ok: true }));
    },

    async initialize(ctx) {
      ctx.logger.info("${nameTitle} plugin initialized");
    },

    async healthCheck(): Promise<PluginHealthResult> {
      return { healthy: true };
    },
  });
}

/**
 * Factory function for use in atlas.config.ts plugins array.
 *
 * @example
 * \`\`\`typescript
 * import { defineConfig } from "@atlas/api/lib/config";
 * import { ${toCamelCase(pluginName)}Plugin } from "${id}";
 *
 * export default defineConfig({
 *   plugins: [${toCamelCase(pluginName)}Plugin()],
 * });
 * \`\`\`
 */
export function ${toCamelCase(pluginName)}Plugin(): AtlasInteractionPlugin {
  return build${toPascalCase(pluginName)}Plugin();
}
`;

    case "action":
      return `import { definePlugin } from "@useatlas/plugin-sdk";
import type {
  AtlasActionPlugin,
  PluginAction,
  PluginHealthResult,
} from "@useatlas/plugin-sdk";
import { z } from "zod";
import { tool } from "ai";

// Define the parameters for your action tool
const actionParams = z.object({
  // TODO: Define your action's parameters
  title: z.string().describe("Title for the action"),
  description: z.string().describe("Description of what to do"),
});

/**
 * Build the plugin object. Exported for direct use and testing.
 */
export function build${toPascalCase(pluginName)}Plugin(): AtlasActionPlugin {
  const actionTool = tool({
    description: "TODO: Describe what this action does",
    parameters: actionParams,
    execute: async ({ title, description }) => {
      // TODO: Implement the action logic
      return { success: true, title, description };
    },
  });

  const action: PluginAction = {
    name: "${toCamelCase(pluginName)}Action",
    description: "TODO: Describe this action for the agent",
    tool: actionTool,
    actionType: "${pluginName}:create",
    reversible: false,
    defaultApproval: "manual",
    requiredCredentials: [],
  };

  return definePlugin({
    id: "${id}",
    type: "action",
    version: "0.1.0",
    name: "${nameTitle}",

    actions: [action],

    async initialize(ctx) {
      ctx.logger.info("${nameTitle} plugin initialized");
    },

    async healthCheck(): Promise<PluginHealthResult> {
      return { healthy: true };
    },
  });
}

/**
 * Factory function for use in atlas.config.ts plugins array.
 *
 * @example
 * \`\`\`typescript
 * import { defineConfig } from "@atlas/api/lib/config";
 * import { ${toCamelCase(pluginName)}Plugin } from "${id}";
 *
 * export default defineConfig({
 *   plugins: [${toCamelCase(pluginName)}Plugin()],
 * });
 * \`\`\`
 */
export function ${toCamelCase(pluginName)}Plugin(): AtlasActionPlugin {
  return build${toPascalCase(pluginName)}Plugin();
}
`;

    case "sandbox":
      return `import { definePlugin } from "@useatlas/plugin-sdk";
import type {
  AtlasSandboxPlugin,
  PluginExploreBackend,
  PluginExecResult,
  PluginHealthResult,
} from "@useatlas/plugin-sdk";

/**
 * Build the plugin object. Exported for direct use and testing.
 */
export function build${toPascalCase(pluginName)}Plugin(): AtlasSandboxPlugin {
  return definePlugin({
    id: "${id}",
    type: "sandbox",
    version: "0.1.0",
    name: "${nameTitle}",

    sandbox: {
      async create(semanticRoot: string): Promise<PluginExploreBackend> {
        // TODO: Create your sandbox execution environment
        return {
          async exec(command: string): Promise<PluginExecResult> {
            // TODO: Execute the command in your sandbox
            return { stdout: "", stderr: "Not implemented", exitCode: 1 };
          },
          async close(): Promise<void> {
            // TODO: Clean up sandbox resources
          },
        };
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
      ctx.logger.info("${nameTitle} plugin initialized");
    },

    async healthCheck(): Promise<PluginHealthResult> {
      return { healthy: true };
    },
  });
}

/**
 * Factory function for use in atlas.config.ts plugins array.
 *
 * @example
 * \`\`\`typescript
 * import { defineConfig } from "@atlas/api/lib/config";
 * import { ${toCamelCase(pluginName)}Plugin } from "${id}";
 *
 * export default defineConfig({
 *   plugins: [${toCamelCase(pluginName)}Plugin()],
 * });
 * \`\`\`
 */
export function ${toCamelCase(pluginName)}Plugin(): AtlasSandboxPlugin {
  return build${toPascalCase(pluginName)}Plugin();
}
`;
  }
}

function generateTestSource(pluginName: string, pluginType: PluginType): string {
  const factoryFn = `${toCamelCase(pluginName)}Plugin`;
  const buildFn = `build${toPascalCase(pluginName)}Plugin`;

  // Use @useatlas/plugin-sdk/testing if available, otherwise inline a minimal mock.
  // The testing export was added after plugin-sdk 0.0.2 — inline fallback ensures
  // generated tests work regardless of which version is installed.
  const baseImport = `import { describe, expect, test } from "bun:test";
import { ${factoryFn}, ${buildFn} } from "./index";
import type { AtlasPluginContext } from "@useatlas/plugin-sdk";

// Minimal mock context — upgrade to @useatlas/plugin-sdk/testing when available
function createMockContext() {
  const logs: Array<{ level: string; msg: string }> = [];
  const noop = (...args: unknown[]) => {
    const msg = typeof args[0] === "string" ? args[0] : typeof args[1] === "string" ? args[1] : "";
    return msg;
  };
  const logger = {
    info: (...args: unknown[]) => { logs.push({ level: "info", msg: noop(...args) }); },
    warn: (...args: unknown[]) => { logs.push({ level: "warn", msg: noop(...args) }); },
    error: (...args: unknown[]) => { logs.push({ level: "error", msg: noop(...args) }); },
    debug: (...args: unknown[]) => { logs.push({ level: "debug", msg: noop(...args) }); },
  };
  const ctx: AtlasPluginContext = {
    db: null,
    connections: { get: () => { throw new Error("not mocked"); }, list: () => [] },
    tools: { register: () => {} },
    logger: logger as unknown as AtlasPluginContext["logger"],
    config: {},
  };
  return { ctx, logs };
}`;

  const baseTests = `
  test("has correct id and type", () => {
    const plugin = ${factoryFn}();
    expect(plugin.id).toBe("${pluginName}");
    expect(plugin.type).toBe("${pluginType}");
  });

  test("has a version string", () => {
    const plugin = ${factoryFn}();
    expect(plugin.version).toBeTruthy();
  });

  test("initialize logs a message", async () => {
    const plugin = ${factoryFn}();
    const { ctx, logs } = createMockContext();
    await plugin.initialize?.(ctx);
    expect(logs.some((l) => l.level === "info")).toBe(true);
  });

  test("health check returns healthy", async () => {
    const plugin = ${factoryFn}();
    const result = await plugin.healthCheck?.();
    expect(result?.healthy).toBe(true);
  });`;

  const typeSpecificTests: Record<PluginType, string> = {
    datasource: `

  test("connection has create and dbType", () => {
    const plugin = ${factoryFn}();
    expect(typeof plugin.connection.create).toBe("function");
    expect(plugin.connection.dbType).toBeTruthy();
  });`,

    context: `

  test("contextProvider loads context string", async () => {
    const plugin = ${factoryFn}();
    const context = await plugin.contextProvider.load();
    expect(typeof context).toBe("string");
    expect(context.length).toBeGreaterThan(0);
  });`,

    interaction: `

  test("has routes function", () => {
    const plugin = ${factoryFn}();
    expect(typeof plugin.routes).toBe("function");
  });`,

    action: `

  test("has at least one action", () => {
    const plugin = ${factoryFn}();
    expect(plugin.actions.length).toBeGreaterThan(0);
    expect(plugin.actions[0].name).toBeTruthy();
  });`,

    sandbox: `

  test("sandbox has create function", () => {
    const plugin = ${factoryFn}();
    expect(typeof plugin.sandbox.create).toBe("function");
  });

  test("sandbox has priority", () => {
    const plugin = ${factoryFn}();
    expect(typeof plugin.sandbox.priority).toBe("number");
  });`,
  };

  return `${baseImport}

describe("${pluginName} plugin", () => {${baseTests}${typeSpecificTests[pluginType]}
});
`;
}

function generatePackageJson(
  pluginName: string,
  pluginType: PluginType,
  scope: string,
): string {
  const scopedName = scope ? `${scope}/${pluginName}` : pluginName;

  const peerDeps: Record<string, string> = {
    "@useatlas/plugin-sdk": ">=0.0.1",
  };
  const devDeps: Record<string, string> = {
    "@useatlas/plugin-sdk": "^0.0.2",
    "@types/bun": "^1.3.9",
    typescript: "^5.9.3",
  };

  // Action plugins need ai + zod
  if (pluginType === "action") {
    peerDeps["ai"] = "^6.0.0";
    devDeps["ai"] = "^6.0.97";
    devDeps["zod"] = "^4.3.6";
  }

  // Interaction plugins need hono
  if (pluginType === "interaction") {
    peerDeps["hono"] = "^4.0.0";
    devDeps["hono"] = "^4.12.3";
  }

  const obj = {
    name: scopedName,
    version: "0.0.1",
    description: `Atlas ${pluginType} plugin`,
    type: "module",
    main: "./src/index.ts",
    types: "./src/index.ts",
    exports: {
      ".": {
        types: "./src/index.ts",
        default: "./src/index.ts",
      },
    },
    files: ["src/", "README.md", "LICENSE"],
    scripts: {
      test: `bun test src/index.test.ts`,
    },
    keywords: ["atlas", "text-to-sql", "plugin", pluginType],
    license: "Apache-2.0",
    peerDependencies: peerDeps,
    devDependencies: devDeps,
  };

  return JSON.stringify(obj, null, 2) + "\n";
}

function generateTsconfig(): string {
  const obj = {
    compilerOptions: {
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "bundler",
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
      outDir: "./dist",
      rootDir: "./src",
      declaration: true,
      declarationMap: true,
      sourceMap: true,
      types: ["bun-types"],
    },
    include: ["src/**/*.ts"],
    exclude: ["node_modules", "dist"],
  };
  return JSON.stringify(obj, null, 2) + "\n";
}

function generateReadme(pluginName: string, pluginType: PluginType, scope: string): string {
  const scopedName = scope ? `${scope}/${pluginName}` : pluginName;
  const factoryFn = `${toCamelCase(pluginName)}Plugin`;
  const nameTitle = pluginName
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

  return `# ${scopedName}

Atlas ${pluginType} plugin — ${nameTitle}.

## Install

\`\`\`bash
bun add ${scopedName}
\`\`\`

## Configure

Add the plugin to your \`atlas.config.ts\`:

\`\`\`typescript
import { defineConfig } from "@atlas/api/lib/config";
import { ${factoryFn} } from "${scopedName}";

export default defineConfig({
  plugins: [${factoryFn}()],
});
\`\`\`

## Usage

Once configured, the plugin will be loaded automatically when Atlas starts.

## Development

\`\`\`bash
bun install
bun test
\`\`\`

## License

Apache-2.0
`;
}

function generateLicense(): string {
  const year = new Date().getFullYear();
  return `
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   Copyright ${year} Atlas Contributors

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
`.trimStart();
}

function generateGitignore(): string {
  return `node_modules/
dist/
*.tsbuildinfo
.env
.env.*
`;
}

// ---------------------------------------------------------------------------
// String utilities
// ---------------------------------------------------------------------------

function toCamelCase(str: string): string {
  return str
    .split("-")
    .map((word, i) =>
      i === 0 ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    )
    .join("");
}

function toPascalCase(str: string): string {
  return str
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join("");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("");
  p.intro(
    `${pc.bgCyan(pc.black(" @useatlas/create-plugin "))} ${pc.dim(`v${VERSION}`)}`
  );

  // ── 1. Plugin name ─────────────────────────────────────────────────
  let pluginName: string;

  if (positionalArgs[0]) {
    pluginName = positionalArgs[0];
    if (!/^[a-z0-9._-]+$/i.test(pluginName)) {
      console.error("Plugin name can only contain letters, numbers, dots, hyphens, and underscores.");
      process.exit(1);
    }
    p.log.info(`Plugin name: ${pc.cyan(pluginName)}`);
  } else if (useDefaults) {
    pluginName = "my-atlas-plugin";
    p.log.info(`Plugin name: ${pc.cyan(pluginName)} ${pc.dim("(default)")}`);
  } else {
    const result = await p.text({
      message: "What is your plugin name?",
      placeholder: "my-atlas-plugin",
      defaultValue: "my-atlas-plugin",
      validate(value) {
        if (!value.trim()) return "Plugin name is required.";
        if (!/^[a-z0-9._-]+$/i.test(value))
          return "Plugin name can only contain letters, numbers, dots, hyphens, and underscores.";
      },
    });
    if (p.isCancel(result)) bail();
    pluginName = result as string;
  }

  const targetDir = path.resolve(process.cwd(), pluginName);

  if (fs.existsSync(targetDir)) {
    if (useDefaults) {
      bail(`Directory ${pluginName} already exists.`);
    }
    const overwrite = await p.confirm({
      message: `Directory ${pc.yellow(pluginName)} already exists. Overwrite?`,
      initialValue: false,
    });
    if (p.isCancel(overwrite) || !overwrite) bail("Directory already exists.");
    try {
      fs.rmSync(targetDir, { recursive: true });
    } catch (err) {
      bail(`Could not remove existing directory ${pluginName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── 2. Plugin type ─────────────────────────────────────────────────
  let pluginType: PluginType;

  if (typeFlag) {
    pluginType = typeFlag;
    p.log.info(`Plugin type: ${pc.cyan(pluginType)}`);
  } else if (useDefaults) {
    pluginType = "datasource";
    p.log.info(`Plugin type: ${pc.cyan("datasource")} ${pc.dim("(default)")}`);
  } else {
    const result = await p.select({
      message: "What type of plugin?",
      options: [
        { value: "datasource", label: "Datasource", hint: "Connect a new database or data source" },
        { value: "context", label: "Context", hint: "Inject additional context into the agent prompt" },
        { value: "interaction", label: "Interaction", hint: "Add HTTP routes for external integrations" },
        { value: "action", label: "Action", hint: "Add approval-gated write operations" },
        { value: "sandbox", label: "Sandbox", hint: "Custom explore backend for code isolation" },
      ],
      initialValue: "datasource" as PluginType,
    });
    if (p.isCancel(result)) bail();
    pluginType = result as PluginType;
  }

  // ── 3. Package scope ───────────────────────────────────────────────
  let scope: string;

  if (scopeFlag) {
    scope = scopeFlag;
    p.log.info(`Package scope: ${pc.cyan(scope + "/")}`);
  } else if (useDefaults) {
    scope = "@useatlas";
    p.log.info(`Package scope: ${pc.cyan("@useatlas/")} ${pc.dim("(default)")}`);
  } else {
    const result = await p.text({
      message: "Package scope:",
      placeholder: "@useatlas",
      defaultValue: "@useatlas",
      validate(value) {
        if (value && !value.startsWith("@"))
          return "Scope must start with @ (e.g. @useatlas)";
      },
    });
    if (p.isCancel(result)) bail();
    scope = (result as string) || "@useatlas";
  }

  // ── Scaffold ───────────────────────────────────────────────────────
  const s = p.spinner();
  s.start("Creating plugin project...");

  try {
    fs.mkdirSync(path.join(targetDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(targetDir, "src", "index.ts"),
      generatePluginSource(pluginName, pluginType)
    );
    fs.writeFileSync(
      path.join(targetDir, "src", "index.test.ts"),
      generateTestSource(pluginName, pluginType)
    );
    fs.writeFileSync(
      path.join(targetDir, "package.json"),
      generatePackageJson(pluginName, pluginType, scope)
    );
    fs.writeFileSync(
      path.join(targetDir, "tsconfig.json"),
      generateTsconfig()
    );
    fs.writeFileSync(
      path.join(targetDir, "README.md"),
      generateReadme(pluginName, pluginType, scope)
    );
    fs.writeFileSync(
      path.join(targetDir, "LICENSE"),
      generateLicense()
    );
    fs.writeFileSync(
      path.join(targetDir, ".gitignore"),
      generateGitignore()
    );
  } catch (err) {
    s.stop("Failed to create plugin project.");
    const detail = err instanceof Error ? err.message : String(err);
    p.log.error(`Could not write project files: ${detail}`);
    p.log.warn(
      `Partial files may exist in ${pc.yellow(pluginName)}/. Remove the directory and try again.`
    );
    process.exit(1);
  }

  s.stop("Plugin project created.");

  // Install dependencies
  s.start("Installing dependencies...");
  try {
    execSync("bun install", {
      cwd: targetDir,
      stdio: "pipe",
      timeout: 60_000,
    });
    s.stop("Dependencies installed.");
  } catch (err) {
    s.stop("Failed to install dependencies.");
    p.log.warn(
      `Could not run ${pc.cyan("bun install")}: ${err instanceof Error ? err.message : String(err)}`
    );
    p.log.warn(`Run it manually in ${pc.yellow(pluginName)}/`);
  }

  // ── Success ────────────────────────────────────────────────────────
  const scopedName = scope ? `${scope}/${pluginName}` : pluginName;

  p.note(
    [
      `${pc.cyan(`cd ${pluginName}`)}`,
      `${pc.cyan("bun test")}              ${pc.dim("# Run tests")}`,
      "",
      pc.dim(`Edit src/index.ts to implement your ${pluginType} plugin.`),
      pc.dim(`Then add it to atlas.config.ts:`),
      "",
      pc.dim(`  import { ${toCamelCase(pluginName)}Plugin } from "${scopedName}";`),
      pc.dim(`  plugins: [${toCamelCase(pluginName)}Plugin()]`),
    ].join("\n"),
    "Next steps"
  );

  p.outro(
    `${pc.green("Done!")} Your Atlas plugin is ready at ${pc.cyan(`./${pluginName}`)}`
  );
}

main().catch((err) => {
  p.log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
