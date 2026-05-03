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
const ATLAS_VERSION: string = pkg.version;

// Provider → API key env var mapping
const PROVIDER_KEY_MAP: Record<string, { envVar: string; placeholder: string }> = {
  anthropic: { envVar: "ANTHROPIC_API_KEY", placeholder: "sk-ant-..." },
  openai: { envVar: "OPENAI_API_KEY", placeholder: "sk-..." },
  bedrock: { envVar: "AWS_ACCESS_KEY_ID", placeholder: "AKIA..." },
  ollama: { envVar: "OLLAMA_BASE_URL", placeholder: "http://localhost:11434" },
  gateway: { envVar: "AI_GATEWAY_API_KEY", placeholder: "vcel_gw_..." },
};

// Default models per provider
const PROVIDER_DEFAULT_MODEL: Record<string, string> = {
  anthropic: "claude-opus-4-6",
  openai: "gpt-4o",
  bedrock: "anthropic.claude-opus-4-6-v1",
  ollama: "llama3.1",
  gateway: "anthropic/claude-opus-4.6",
};

function copyDirRecursive(src: string, dest: string): void {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function bail(message?: string): never {
  p.cancel(message ?? "Setup cancelled.");
  process.exit(1);
}

/** Extract a stream from an execSync error. Returns the stream content, or err.message as fallback. */
function extractExecOutput(err: unknown, stream: "stdout" | "stderr" = "stderr"): string {
  if (err && typeof err === "object" && stream in err) {
    const value = String((err as Record<string, unknown>)[stream]).trim();
    if (value) return value;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Extract a stream from an execSync error. Returns empty string if not present. */
function extractExecStream(err: unknown, stream: "stdout" | "stderr"): string {
  if (err && typeof err === "object" && stream in err) {
    return String((err as Record<string, unknown>)[stream]).trim();
  }
  return "";
}

// Parse --defaults / -y flag for non-interactive mode
const args = process.argv.slice(2);
const useDefaults = args.includes("--defaults") || args.includes("-y");

const skipDoctor = args.includes("--skip-doctor");

// Parse --demo flag — boolean (load the canonical demo dataset).
// Atlas ships a single canonical demo (ecommerce / NovaMart). Prior versions
// supported `--demo simple|cybersec|ecommerce` and a `--seed` alias; both were
// removed in 1.4.0 (#2021). Legacy `--demo <name>` invocations error with a
// migration message.
let demoFlag = false;
const demoIdx = args.indexOf("--demo");
if (demoIdx !== -1) {
  demoFlag = true;
  const next = args[demoIdx + 1];
  if (next && !next.startsWith("-")) {
    if (next === "simple" || next === "cybersec") {
      console.error(
        `The "${next}" demo dataset was removed in 1.4.0 (#2021). ` +
          `Atlas now ships a single canonical demo (ecommerce). ` +
          `Use \`--demo\` without a value.`,
      );
      process.exit(1);
    }
    if (next !== "ecommerce") {
      console.error(
        `Unknown --demo value "${next}". Atlas ships a single canonical demo — use \`--demo\` without a value.`,
      );
      process.exit(1);
    }
  }
}
if (args.includes("--seed")) {
  console.error(
    `The --seed flag was removed in 1.4.0 (#2021). Use \`--demo\` (no value) to load the canonical demo dataset.`,
  );
  process.exit(1);
}

const positionalArgs = args.filter((a, i) => {
  if (a.startsWith("-")) return false;
  // Skip the optional value after --demo (e.g. legacy `--demo ecommerce`)
  if (i > 0 && args[i - 1] === "--demo") return false;
  return true;
});

// Platform → template mapping
const VALID_PLATFORMS = ["vercel", "railway", "docker", "other"] as const;
type Platform = (typeof VALID_PLATFORMS)[number];

const VALID_SANDBOX_CHOICES = ["nsjail", "sidecar", "e2b", "daytona", "none"] as const;
type SandboxChoice = (typeof VALID_SANDBOX_CHOICES)[number];

type Template = "docker" | "nextjs-standalone";

function templateForPlatform(platform: Platform): Template {
  return platform === "vercel" ? "nextjs-standalone" : "docker";
}

function generateReadme(projectName: string, platform: Platform, dbChoice: string): string {
  const deployBadges: Record<Platform, string> = {
    vercel: `[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?env=AI_GATEWAY_API_KEY,BETTER_AUTH_SECRET&envDescription=AI_GATEWAY_API_KEY%3A%20Vercel%20AI%20Gateway%20key%20(vercel.com%2F~%2Fai%2Fapi-keys).%20BETTER_AUTH_SECRET%3A%20Random%20string%2C%2032%2B%20chars%20(openssl%20rand%20-base64%2032).&project-name=${projectName})`,
    railway: `[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/_XHuNP?referralCode=N5vD3S)`,
    docker: "",
    other: "",
  };
  const deployBadge = deployBadges[platform];

  const localDesc = platform === "vercel"
    ? "Open [http://localhost:3000](http://localhost:3000)."
    : "API at [http://localhost:3000](http://localhost:3000).";

  const localQuickStart = `## Quick Start

1. **Install dependencies:**
   \`\`\`bash
   bun install
   \`\`\`

2. **Configure environment:** Edit \`.env\` with your API key and database URL.

3. **Generate semantic layer:**
   \`\`\`bash
   bun run atlas -- init          # From your database
   bun run atlas -- init --demo   # Or load demo data
   \`\`\`

4. **Run locally:**
   \`\`\`bash
   bun run dev
   \`\`\`
   ${localDesc}`;

  const deploySections: Record<Platform, string> = {
    vercel: `## Deploy to Vercel

1. Push to GitHub:
   \`\`\`bash
   git init && git add -A && git commit -m "Initial commit"
   gh repo create ${projectName} --public --source=. --push
   \`\`\`

2. Import in the [Vercel Dashboard](https://vercel.com/new) and set environment variables:
   - \`ATLAS_PROVIDER\` — \`anthropic\` (or \`gateway\` for Vercel AI Gateway)
   - \`ANTHROPIC_API_KEY\` — Your API key
   - \`ATLAS_DATASOURCE_URL\` — Your analytics database (\`postgresql://...\`)
   - \`DATABASE_URL\` — Atlas internal Postgres (auth, audit)

3. Deploy. Vercel auto-detects \`@vercel/sandbox\` for secure explore isolation.`,

    railway: `## Deploy to Railway

1. Push to GitHub:
   \`\`\`bash
   git init && git add -A && git commit -m "Initial commit"
   gh repo create ${projectName} --public --source=. --push
   \`\`\`

2. Create a [Railway project](https://railway.app/) and add a **Postgres** plugin (auto-sets \`DATABASE_URL\`).

3. Add two services from your GitHub repo:
   - **API** — Root directory, uses \`railway.json\` + \`Dockerfile\`
   - **Sidecar** — \`sidecar/\` directory, uses \`sidecar/Dockerfile\`

4. Set environment variables on the API service:
   \`\`\`
   ATLAS_PROVIDER=anthropic
   ANTHROPIC_API_KEY=sk-ant-...
   ATLAS_DATASOURCE_URL=postgresql://...
   ATLAS_SANDBOX_URL=http://sidecar.railway.internal:8080
   SIDECAR_AUTH_TOKEN=<shared-secret>
   \`\`\`
   Set \`SIDECAR_AUTH_TOKEN\` on the sidecar service too.

5. Deploy. Railway builds from the Dockerfile and runs health checks automatically.`,

    docker: `## Deploy with Docker

1. Build the image (includes nsjail for explore isolation):
   \`\`\`bash
   docker build -t ${projectName} .
   \`\`\`

2. Run:
   \`\`\`bash
   docker run -p 3000:3000 \\
     -e ATLAS_PROVIDER=anthropic \\
     -e ANTHROPIC_API_KEY=sk-ant-... \\
     -e ATLAS_DATASOURCE_URL=postgresql://... \\
     ${projectName}
   \`\`\`

3. To build without nsjail (smaller image, dev only):
   \`\`\`bash
   docker build --build-arg INSTALL_NSJAIL=false -t ${projectName} .
   \`\`\``,

    other: `## Deploy

Build and deploy the Docker image to your platform of choice. See \`docs/deploy.md\` for detailed guides.`,
  };

  const dbNote = dbChoice === "mysql"
    ? "This project is configured for **MySQL**."
    : "This project is configured for **PostgreSQL**.";

  const badgeLine = deployBadge ? `${deployBadge}\n\n` : "";

  return `# ${projectName}

A text-to-SQL data analyst agent powered by [Atlas](https://www.useatlas.dev).

${badgeLine}${dbNote} Ask natural-language questions, and the agent explores a semantic layer, writes validated SQL, and returns interpreted results.

${localQuickStart}

${deploySections[platform]}

## Project Structure

\`\`\`
${projectName}/
├── src/                # Application source (API + UI)
├── bin/                # CLI tools (atlas init, enrich, eval)
├── data/               # Demo datasets (SQL seed files)
├── semantic/           # Semantic layer (YAML — entities, metrics, glossary)
├── .env                # Environment configuration
└── docs/deploy.md      # Full deployment guide
\`\`\`

## Commands

| Command | Description |
|---------|-------------|
| \`bun run dev\` | Start dev server |
| \`bun run build\` | Production build |
| \`bun run start\` | Start production server |
| \`bun run atlas -- init\` | Generate semantic layer from database |
| \`bun run atlas -- init --demo\` | Load the canonical demo dataset (NovaMart ecommerce, 13 entities) |
| \`bun run atlas -- diff\` | Compare DB schema vs semantic layer |
| \`bun run atlas -- query "question"\` | Headless query (table output) |
| \`bun run test\` | Run tests |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| \`ATLAS_PROVIDER\` | Yes | LLM provider (\`anthropic\`, \`openai\`, \`bedrock\`, \`ollama\`, \`openai-compatible\`, \`gateway\`) |
| Provider API key | Yes | e.g. \`ANTHROPIC_API_KEY=sk-ant-...\` |
| \`ATLAS_DATASOURCE_URL\` | Yes | Analytics database connection string |
| \`DATABASE_URL\` | No | Atlas internal Postgres (auth, audit). Auto-set on most platforms |
| \`ATLAS_MODEL\` | No | Override the default LLM model |
| \`ATLAS_ROW_LIMIT\` | No | Max rows per query (default: 1000) |

See \`docs/deploy.md\` for the full variable reference.

## Learn More

- [Atlas Documentation](https://www.useatlas.dev)
- [GitHub](https://github.com/AtlasDevHQ/atlas)
`;
}

// Parse --platform / --preset flag (--preset is an alias)
let platformFlag: Platform | undefined;
const platformArgIdx = args.indexOf("--platform");
const presetArgIdx = args.indexOf("--preset");
if (platformArgIdx !== -1 && presetArgIdx !== -1) {
  console.error("Cannot use both --platform and --preset. They are aliases — pick one.");
  process.exit(1);
}
const platformIdx = Math.max(platformArgIdx, presetArgIdx);
if (platformIdx !== -1) {
  const val = args[platformIdx + 1];
  if (!val || val.startsWith("-")) {
    console.error("--platform requires a value. Available: " + VALID_PLATFORMS.join(", "));
    process.exit(1);
  }
  if (!VALID_PLATFORMS.includes(val as Platform)) {
    console.error(`Unknown platform "${val}". Available: ${VALID_PLATFORMS.join(", ")}`);
    process.exit(1);
  }
  platformFlag = val as Platform;
}

// Handle --help / -h
if (args.includes("--help") || args.includes("-h")) {
  console.log(`
  Usage: bun create atlas-agent [project-name] [options]

  Options:
    --demo             Load the canonical demo dataset (NovaMart ecommerce, 13 entities)
    --platform <name>  Deploy target (${VALID_PLATFORMS.join(", ")}) [default: docker]
    --preset <name>    Alias for --platform
    --defaults, -y     Use all default values (non-interactive)
    --skip-doctor      Skip health check after scaffolding
    --help, -h         Show this help message

  Demo dataset:
    Atlas ships a single canonical demo — NovaMart, an e-commerce DTC brand
    with 13 entities (products, orders, customers, payments, returns,
    shipments, sellers, …). 52 tables, ~480K rows.

  Platforms:
    vercel     Next.js + embedded API — auto-detects Vercel sandbox
    railway    Hono API + Docker — sidecar sandbox (internal networking)
    docker     Hono API + Docker — nsjail sandbox (built into image)
    other      Hono API + Docker — choose sandbox: nsjail, sidecar, E2B, Daytona, or none

  Examples:
    bun create atlas-agent my-app
    bun create atlas-agent my-app --demo
    bun create atlas-agent my-app --demo --defaults
    bun create atlas-agent my-app --platform vercel
`);
  process.exit(0);
}

// Reject unknown flags
const knownFlags = new Set(["--defaults", "-y", "--help", "-h", "--platform", "--preset", "--demo", "--skip-doctor"]);
const unknownFlags = args.filter((a, i) => {
  if (!a.startsWith("-")) return false;
  if (knownFlags.has(a)) return false;
  // Value arguments for flags that take a parameter
  if (i > 0 && (args[i - 1] === "--platform" || args[i - 1] === "--preset" || args[i - 1] === "--demo")) return false;
  return true;
});
if (unknownFlags.length > 0) {
  console.error(`Unknown flag(s): ${unknownFlags.join(", ")}`);
  console.error("Run with --help for usage information.");
  process.exit(1);
}

// Helpers to deduplicate useDefaults branches
async function selectOrDefault<T extends string>(opts: {
  label: string;
  message: string;
  options: { value: T; label: string; hint?: string }[];
  initialValue: T;
  defaultDisplay: string;
}): Promise<T> {
  if (useDefaults) {
    p.log.info(`${opts.label}: ${pc.cyan(opts.defaultDisplay)} ${pc.dim("(default)")}`);
    return opts.initialValue;
  }
  const result = await p.select({
    message: opts.message,
    options: opts.options,
    initialValue: opts.initialValue,
  });
  if (p.isCancel(result)) bail();
  return result as T;
}

async function confirmOrDefault(opts: {
  label: string;
  message: string;
  initialValue: boolean;
  defaultDisplay: string;
}): Promise<boolean> {
  if (useDefaults) {
    p.log.info(`${opts.label}: ${pc.cyan(opts.defaultDisplay)} ${pc.dim("(default)")}`);
    return opts.initialValue;
  }
  const result = await p.confirm({
    message: opts.message,
    initialValue: opts.initialValue,
  });
  if (p.isCancel(result)) bail();
  return result as boolean;
}

async function main() {
  const startTime = Date.now();
  console.log("");
  p.intro(
    `${pc.bgCyan(pc.black(" create-atlas-agent "))} ${pc.dim(`v${ATLAS_VERSION}`)}`
  );

  // ── 1. Project name ──────────────────────────────────────────────
  let projectName: string;

  if (positionalArgs[0]) {
    projectName = positionalArgs[0];
    p.log.info(`Project name: ${pc.cyan(projectName)}`);
  } else if (useDefaults) {
    projectName = "my-atlas-app";
    p.log.info(`Project name: ${pc.cyan(projectName)} ${pc.dim("(default)")}`);
  } else {
    const result = await p.text({
      message: "What is your project name?",
      placeholder: "my-atlas-app",
      defaultValue: "my-atlas-app",
      validate(value) {
        if (!value.trim()) return "Project name is required.";
        if (!/^[a-z0-9._-]+$/i.test(value))
          return "Project name can only contain letters, numbers, dots, hyphens, and underscores.";
      },
    });
    if (p.isCancel(result)) bail();
    projectName = result as string;
  }

  const targetDir = path.resolve(process.cwd(), projectName);

  if (fs.existsSync(targetDir)) {
    if (useDefaults) {
      bail(`Directory ${projectName} already exists.`);
    }
    const overwrite = await p.confirm({
      message: `Directory ${pc.yellow(projectName)} already exists. Overwrite?`,
      initialValue: false,
    });
    if (p.isCancel(overwrite) || !overwrite) bail("Directory already exists.");
  }

  // ── 1b. Platform selection ──────────────────────────────────────────
  let platform: Platform;
  if (platformFlag) {
    platform = platformFlag;
    p.log.info(`Platform: ${pc.cyan(platform)}`);
  } else {
    platform = await selectOrDefault({
      label: "Platform",
      message: "Where will you deploy?",
      options: [
        { value: "docker", label: "Docker", hint: "nsjail sandbox built into image (default)" },
        { value: "railway", label: "Railway", hint: "Sidecar sandbox via internal networking" },
        { value: "vercel", label: "Vercel", hint: "Next.js + embedded API — auto-detected sandbox" },
        { value: "other", label: "Other", hint: "Choose your sandbox backend" },
      ],
      initialValue: "docker" as Platform,
      defaultDisplay: "Docker",
    });
  }

  const template = templateForPlatform(platform);

  // ── 1c. Sandbox choice (only for "other" platform) ────────────────
  let sandboxChoice: SandboxChoice = "nsjail";
  let sandboxApiKey = "";

  if (platform === "other") {
    sandboxChoice = await selectOrDefault({
      label: "Sandbox",
      message: "Which explore sandbox backend?",
      options: [
        { value: "nsjail", label: "nsjail", hint: "Process-level isolation (default, requires Linux)" },
        { value: "sidecar", label: "Sidecar", hint: "HTTP-isolated container (deploy separately)" },
        { value: "e2b", label: "E2B", hint: "Cloud sandbox (requires API key)" },
        { value: "daytona", label: "Daytona", hint: "Cloud sandbox (requires API key)" },
        { value: "none", label: "None", hint: "No isolation (dev only — not for production)" },
      ],
      initialValue: "nsjail" as SandboxChoice,
      defaultDisplay: "nsjail",
    });

    // Collect API key for cloud sandboxes
    if (sandboxChoice === "e2b" || sandboxChoice === "daytona") {
      const envVarName = sandboxChoice === "e2b" ? "E2B_API_KEY" : "DAYTONA_API_KEY";
      if (useDefaults) {
        sandboxApiKey = "your-api-key-here";
        p.log.warn(`${envVarName} set to placeholder. Edit .env and set a real key before running.`);
      } else {
        const keyResult = await p.text({
          message: `Enter your ${pc.cyan(envVarName)}:`,
          placeholder: "your-api-key-here",
          validate(value) {
            if (!value.trim()) return `${envVarName} is required.`;
          },
        });
        if (p.isCancel(keyResult)) bail();
        sandboxApiKey = keyResult as string;
      }
    }
  }

  // ── 2. Database choice ────────────────────────────────────────────
  const dbChoice = await selectOrDefault({
    label: "Database",
    message: "Which database?",
    options: [
      { value: "postgres", label: "PostgreSQL", hint: "Bring your connection string (default)" },
      { value: "mysql", label: "MySQL", hint: "Bring your connection string" },
    ],
    initialValue: "postgres",
    defaultDisplay: "PostgreSQL",
  });

  // ── 3. Database connection string ──────────────────────────────────
  let databaseUrl: string;
  if (dbChoice === "postgres") {
    if (useDefaults) {
      databaseUrl = "postgresql://atlas:atlas@localhost:5432/atlas";
      p.log.info(`Database URL: ${pc.cyan(databaseUrl)} ${pc.dim("(default)")}`);
    } else {
      const connResult = await p.text({
        message: "PostgreSQL connection string:",
        placeholder: "postgresql://atlas:atlas@localhost:5432/atlas",
        defaultValue: "postgresql://atlas:atlas@localhost:5432/atlas",
        validate(value) {
          if (!value.trim()) return "Database URL is required.";
          if (!value.startsWith("postgresql://") && !value.startsWith("postgres://"))
            return "Must be a PostgreSQL connection string (postgresql://...).";
        },
      });
      if (p.isCancel(connResult)) bail();
      databaseUrl = connResult as string;
    }
  } else if (dbChoice === "mysql") {
    if (useDefaults) {
      databaseUrl = "mysql://root:root@localhost:3306/atlas";
      p.log.info(`Database URL: ${pc.cyan(databaseUrl)} ${pc.dim("(default)")}`);
    } else {
      const connResult = await p.text({
        message: "MySQL connection string:",
        placeholder: "mysql://user:pass@localhost:3306/dbname",
        defaultValue: "mysql://root:root@localhost:3306/atlas",
        validate(value) {
          if (!value.trim()) return "Database URL is required.";
          if (!value.startsWith("mysql://") && !value.startsWith("mysql2://"))
            return "Must be a MySQL connection string (mysql://...).";
        },
      });
      if (p.isCancel(connResult)) bail();
      databaseUrl = connResult as string;
    }
  } else {
    // Exhaustive — only postgres and mysql are offered
    bail("Unexpected database choice.");
  }

  // ── 4. LLM Provider ──────────────────────────────────────────────
  const provider = await selectOrDefault({
    label: "LLM provider",
    message: "Which LLM provider?",
    options: [
      { value: "anthropic", label: "Anthropic", hint: "Claude (default)" },
      { value: "openai", label: "OpenAI", hint: "GPT-4o" },
      { value: "bedrock", label: "AWS Bedrock", hint: "Region-specific" },
      { value: "ollama", label: "Ollama", hint: "Local models" },
      { value: "gateway", label: "Vercel AI Gateway", hint: "One key, hundreds of models" },
    ],
    initialValue: "anthropic",
    defaultDisplay: "Anthropic",
  });

  // ── 5. API Key ────────────────────────────────────────────────────
  const keyInfo = PROVIDER_KEY_MAP[provider];
  let apiKey = "";

  if (useDefaults) {
    apiKey = keyInfo.placeholder;
    p.log.warn(
      `${keyInfo.envVar} set to placeholder value. Edit .env and set a real API key before running.`
    );
  } else if (provider === "bedrock") {
    // Bedrock needs multiple AWS credentials
    const accessKeyId = await p.text({
      message: `Enter your ${pc.cyan("AWS_ACCESS_KEY_ID")}:`,
      placeholder: "AKIA...",
      validate(value) {
        if (!value.trim()) return "AWS Access Key ID is required.";
      },
    });
    if (p.isCancel(accessKeyId)) bail();

    const secretAccessKey = await p.text({
      message: `Enter your ${pc.cyan("AWS_SECRET_ACCESS_KEY")}:`,
      placeholder: "wJalr...",
      validate(value) {
        if (!value.trim()) return "AWS Secret Access Key is required.";
      },
    });
    if (p.isCancel(secretAccessKey)) bail();

    const awsRegion = await p.text({
      message: `Enter your ${pc.cyan("AWS_REGION")}:`,
      placeholder: "us-east-1",
      defaultValue: "us-east-1",
    });
    if (p.isCancel(awsRegion)) bail();

    // Store all three as a composite — we'll unpack when writing .env
    apiKey = `AWS_ACCESS_KEY_ID=${accessKeyId}\nAWS_SECRET_ACCESS_KEY=${secretAccessKey}\nAWS_REGION=${awsRegion}`;
  } else {
    const keyPrompt = await p.text({
      message: `Enter your ${pc.cyan(keyInfo.envVar)}:`,
      placeholder: keyInfo.placeholder,
      validate(value) {
        if (provider !== "ollama" && !value.trim())
          return `${keyInfo.envVar} is required.`;
      },
    });
    if (p.isCancel(keyPrompt)) bail();
    apiKey = (keyPrompt as string) || keyInfo.placeholder;
  }

  // ── 6. Model override ────────────────────────────────────────────
  const defaultModel = PROVIDER_DEFAULT_MODEL[provider];
  let modelOverride = "";

  if (!useDefaults) {
    const result = await p.text({
      message: `Model override? ${pc.dim(`(default: ${defaultModel})`)}`,
      placeholder: defaultModel,
      defaultValue: "",
    });
    if (p.isCancel(result)) bail();
    modelOverride = result as string;
  }

  // ── 7. Semantic layer / demo data ─────────────────────────────────
  // Atlas ships a single canonical demo — NovaMart e-commerce, 13 entities.
  // No picker; the only choice is whether to load it.
  let loadDemo = demoFlag;
  let generateSemantic = false;

  // Demo data is not available for MySQL (SQL files use PostgreSQL-specific syntax)
  if (dbChoice === "mysql") {
    if (demoFlag) {
      p.log.warn(`Demo data is not available for MySQL. The --demo flag will be ignored.`);
      loadDemo = false;
    }
    p.log.info(`Demo data: ${pc.dim("not available for MySQL — use your own database")}`);
    generateSemantic = await confirmOrDefault({
      label: "Generate semantic layer",
      message: "Generate semantic layer now? (requires database access)",
      initialValue: false,
      defaultDisplay: "no",
    });
  } else if (demoFlag) {
    // --demo flag was provided — skip the prompt
    p.log.info(`Demo data: ${pc.cyan("NovaMart ecommerce")} ${pc.dim("(--demo)")}`);
  } else {
    loadDemo = await confirmOrDefault({
      label: "Demo data",
      message: "Load the demo dataset (NovaMart ecommerce, 13 entities)?",
      initialValue: false,
      defaultDisplay: "no",
    });

    if (!loadDemo) {
      generateSemantic = await confirmOrDefault({
        label: "Generate semantic layer",
        message: "Generate semantic layer now? (requires database access)",
        initialValue: false,
        defaultDisplay: "no",
      });
    }
  }

  // ── Pre-flight checks ───────────────────────────────────────────
  try {
    const bunVersion = execSync("bun --version", { encoding: "utf-8", stdio: "pipe" }).trim();
    const major = parseInt(bunVersion.split(".")[0], 10);
    if (isNaN(major) || major < 1) {
      p.log.warn(`Bun ${bunVersion} detected. Atlas requires Bun 1.0+.`);
    }
  } catch (err) {
    p.log.warn(`Could not detect bun version: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── DB connectivity check (Postgres/MySQL) ──────────────────────
  if (generateSemantic && (dbChoice === "postgres" || dbChoice === "mysql")) {
    const connSpinner = p.spinner();
    connSpinner.start("Checking database connectivity...");
    try {
      if (dbChoice === "mysql") {
        execSync(
          `bun -e "const m=require('mysql2/promise');const p=m.createPool({uri:process.env.ATLAS_DATASOURCE_URL,connectionLimit:1,connectTimeout:5000});const c=await p.getConnection();c.release();await p.end()"`,
          { stdio: "pipe", timeout: 15_000, env: { ...process.env, ATLAS_DATASOURCE_URL: databaseUrl } }
        );
      } else {
        execSync(
          `bun -e "const{Pool}=require('pg');const p=new Pool({connectionString:process.env.ATLAS_DATASOURCE_URL,connectionTimeoutMillis:5000});const c=await p.connect();c.release();await p.end()"`,
          { stdio: "pipe", timeout: 15_000, env: { ...process.env, ATLAS_DATASOURCE_URL: databaseUrl } }
        );
      }
      connSpinner.stop("Database is reachable.");
    } catch (err) {
      connSpinner.stop("Could not connect to database.");
      const connStderr = extractExecStream(err, "stderr");
      if (connStderr) p.log.warn(connStderr);
      const proceed = await p.confirm({
        message: "Database is not reachable. Try generating semantic layer anyway?",
        initialValue: false,
      });
      if (p.isCancel(proceed) || !proceed) {
        generateSemantic = false;
        p.log.info("Skipping. Run 'bun run atlas -- init' later when the DB is available.");
      }
    }
  }

  // ── Scaffold ──────────────────────────────────────────────────────
  const s = p.spinner();

  // Step 1: Copy template (self-contained — includes src/, bin/, data/)
  s.start("Copying project files...");
  const templateDir = path.join(import.meta.dir, "templates", template);

  if (!fs.existsSync(templateDir)) {
    s.stop("Template directory not found.");
    bail(`Could not find templates/${template}/ directory. Is the package installed correctly?`);
  }

  try {
    copyDirRecursive(templateDir, targetDir);
  } catch (err) {
    s.stop("Failed to copy project files.");
    p.log.error(`Copy failed: ${err instanceof Error ? err.message : String(err)}`);
    if (fs.existsSync(targetDir)) {
      p.log.warn(
        `Partial directory may remain at ${pc.yellow(targetDir)}. Remove it manually before retrying.`
      );
    }
    process.exit(1);
  }

  // Rename gitignore → .gitignore (npm/bun strips .gitignore from published tarballs)
  const gitignoreSrc = path.join(targetDir, "gitignore");
  const gitignoreDest = path.join(targetDir, ".gitignore");
  if (fs.existsSync(gitignoreSrc)) {
    try {
      fs.renameSync(gitignoreSrc, gitignoreDest);
    } catch (err) {
      p.log.warn(
        `Failed to rename gitignore to .gitignore: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else if (!fs.existsSync(gitignoreDest)) {
    p.log.warn(
      "No .gitignore found in template. Your project may accidentally commit secrets (.env). Add one manually."
    );
  }

  // Remove platform-irrelevant files from the docker template
  if (template === "docker") {
    const needsSidecar = platform === "railway" ||
      (platform === "other" && sandboxChoice === "sidecar");
    if (!needsSidecar) {
      fs.rmSync(path.join(targetDir, "sidecar"), { recursive: true, force: true });
    }
    if (platform !== "railway") {
      fs.rmSync(path.join(targetDir, "railway.json"), { force: true });
    }
    // vercel.json in docker template is noise
    fs.rmSync(path.join(targetDir, "vercel.json"), { force: true });
  }

  // The template's `semantic/` directory is already the canonical ecommerce
  // semantic layer (regenerated by prepare-templates.sh from the repo root).
  // No per-seed install or prune step is needed.

  // Replace %PROJECT_NAME% in templated files (only files that exist in the template)
  const filesToReplace = ["package.json"];
  for (const file of filesToReplace) {
    const filePath = path.join(targetDir, file);
    if (!fs.existsSync(filePath)) continue; // not all templates have every file
    const content = fs.readFileSync(filePath, "utf-8");
    const replaced = content.replace(/%PROJECT_NAME%/g, projectName);
    if (content === replaced && content.includes("PROJECT_NAME")) {
      p.log.warn(`${file} may contain unreplaced template variables.`);
    }
    fs.writeFileSync(filePath, replaced);
  }

  // Write platform-specific README
  try {
    const readme = generateReadme(projectName, platform, dbChoice);
    fs.writeFileSync(path.join(targetDir, "README.md"), readme);
  } catch (err) {
    p.log.warn(`Could not write README.md: ${err instanceof Error ? err.message : String(err)}`);
  }

  s.stop("Project files copied.");

  // Track partial failures — we continue scaffolding but warn at the end
  let setupFailed = false;

  // Step 2: Write .env
  s.start("Writing environment configuration...");

  let envContent = `# Generated by create-atlas-agent v${ATLAS_VERSION}\n\n`;

  envContent += `# Database\n`;
  envContent += `ATLAS_DATASOURCE_URL=${databaseUrl}\n`;

  envContent += `\n# LLM Provider\n`;
  envContent += `ATLAS_PROVIDER=${provider}\n`;

  if (provider === "bedrock") {
    envContent += `${apiKey}\n`;
  } else {
    envContent += `${keyInfo.envVar}=${apiKey}\n`;
  }

  if (modelOverride) {
    envContent += `\n# Model override\n`;
    envContent += `ATLAS_MODEL=${modelOverride}\n`;
  }

  envContent += `\n# Security (defaults)\n`;
  envContent += `ATLAS_TABLE_WHITELIST=true\n`;
  envContent += `ATLAS_ROW_LIMIT=1000\n`;
  envContent += `ATLAS_QUERY_TIMEOUT=30000\n`;

  // Platform-specific sandbox configuration
  switch (platform) {
    case "vercel":
      envContent += `\n# Explore Sandbox\n`;
      envContent += `# Vercel auto-detects @vercel/sandbox — no config needed.\n`;
      envContent += `\n# Scheduled Tasks (Vercel Cron)\n`;
      envContent += `# ATLAS_SCHEDULER_ENABLED=true\n`;
      envContent += `# ATLAS_SCHEDULER_BACKEND=vercel\n`;
      envContent += `# CRON_SECRET=...  # Set in Vercel dashboard\n`;
      break;
    case "railway": {
      const sidecarToken = crypto.randomUUID();
      envContent += `\n# Explore Sandbox (sidecar)\n`;
      envContent += `# Deploy the sidecar/ directory as a second Railway service.\n`;
      envContent += `ATLAS_SANDBOX_URL=http://sidecar.railway.internal:8080\n`;
      envContent += `SIDECAR_AUTH_TOKEN=${sidecarToken}\n`;
      break;
    }
    case "docker":
      envContent += `\n# Explore Sandbox (nsjail — built into Docker image)\n`;
      envContent += `ATLAS_SANDBOX=nsjail\n`;
      break;
    case "other":
      switch (sandboxChoice) {
        case "nsjail":
          envContent += `\n# Explore Sandbox (nsjail)\n`;
          envContent += `ATLAS_SANDBOX=nsjail\n`;
          break;
        case "sidecar": {
          const sidecarToken = crypto.randomUUID();
          envContent += `\n# Explore Sandbox (sidecar)\n`;
          envContent += `# Deploy sidecar/ as a separate service, then update the URL below.\n`;
          envContent += `ATLAS_SANDBOX_URL=http://localhost:8080\n`;
          envContent += `SIDECAR_AUTH_TOKEN=${sidecarToken}\n`;
          break;
        }
        case "e2b":
          envContent += `\n# Explore Sandbox (E2B)\n`;
          envContent += `E2B_API_KEY=${sandboxApiKey}\n`;
          break;
        case "daytona":
          envContent += `\n# Explore Sandbox (Daytona)\n`;
          envContent += `DAYTONA_API_KEY=${sandboxApiKey}\n`;
          break;
        case "none":
          envContent += `\n# Explore Sandbox\n`;
          envContent += `# No sandbox configured — explore runs without isolation.\n`;
          envContent += `# This is acceptable for development but NOT for production.\n`;
          break;
      }
      break;
  }

  try {
    fs.writeFileSync(path.join(targetDir, ".env"), envContent);
    s.stop("Environment file written.");
  } catch (err) {
    s.stop("Failed to write .env file.");
    p.log.error(`Could not write .env: ${err instanceof Error ? err.message : String(err)}`);
    p.log.info(`Create ${pc.cyan(path.join(projectName, ".env"))} manually with your configuration.`);
    setupFailed = true;
  }

  // Generate atlas.config.ts for plugin-based sandboxes (E2B, Daytona)
  if (platform === "other" && (sandboxChoice === "e2b" || sandboxChoice === "daytona")) {
    const pluginPkg = sandboxChoice === "e2b"
      ? "@useatlas/e2b"
      : "@useatlas/daytona";
    const pluginExport = sandboxChoice === "e2b"
      ? "e2bSandboxPlugin"
      : "daytonaSandboxPlugin";

    const configContent = `import { defineConfig } from "@atlas/api/lib/config";
import { ${pluginExport} } from "${pluginPkg}";

export default defineConfig({
  plugins: [${pluginExport}()],
});
`;
    try {
      fs.writeFileSync(path.join(targetDir, "atlas.config.ts"), configContent);
      p.log.warn(
        `Generated atlas.config.ts with ${pc.cyan(pluginPkg)}. ` +
        `This plugin is not yet published — install it manually when available.`
      );
    } catch (err) {
      p.log.error(`Could not write atlas.config.ts: ${err instanceof Error ? err.message : String(err)}`);
      p.log.info(`Create atlas.config.ts manually:\n${configContent}`);
    }
  }

  // Step 3: Install dependencies
  s.start("Installing dependencies with bun...");
  try {
    execSync("bun install", {
      cwd: targetDir,
      stdio: "pipe",
      timeout: 120_000,
    });
    s.stop("Dependencies installed.");
  } catch (err) {
    s.stop("Failed to install dependencies.");
    setupFailed = true;
    p.log.warn(
      `Could not run ${pc.cyan("bun install")}: ${err instanceof Error ? err.message : String(err)}`
    );
    p.log.warn(`Run it manually in ${pc.yellow(projectName)}/`);
  }

  // Step 4: Load demo data + generate semantic layer
  if (loadDemo) {
    const demoInitFlag = "--demo";
    const timeoutMs = 120_000;

    // Check if Postgres is reachable before attempting to seed
    s.start("Checking database connectivity...");
    let dbReachable = false;
    try {
      execSync(
        `bun -e "const{Pool}=require('pg');const p=new Pool({connectionString:process.env.ATLAS_DATASOURCE_URL,connectionTimeoutMillis:5000});const c=await p.connect();c.release();await p.end()"`,
        { stdio: "pipe", timeout: 10_000, cwd: targetDir, env: { ...process.env, ATLAS_DATASOURCE_URL: databaseUrl } }
      );
      dbReachable = true;
      s.stop("Database is reachable.");
    } catch (connErr) {
      s.stop("Database is not reachable.");
      const connDetail = extractExecOutput(connErr);

      // If the error is about a missing module, bun install likely failed — don't chase Docker
      if (connDetail.includes("Cannot find module") || connDetail.includes("MODULE_NOT_FOUND")) {
        p.log.warn("pg module not found — bun install may have failed. Skipping DB check.");
        p.log.warn(`Run: cd ${projectName} && bun install && bun run atlas -- init ${demoInitFlag}`);
      } else {
        // Provide actionable guidance based on the connection string
        const isLocalhost = databaseUrl.includes("localhost") || databaseUrl.includes("127.0.0.1");
        if (isLocalhost) {
          // Check if Docker is available
          let dockerRunning = false;
          let dockerError = "";
          try {
            execSync("docker info", { stdio: "pipe", timeout: 5_000 });
            dockerRunning = true;
          } catch (dockerCheckErr) {
            dockerError = extractExecOutput(dockerCheckErr);
          }
          if (!dockerRunning) {
            if (dockerError.includes("permission denied")) {
              p.log.warn("Docker is running but inaccessible (permission denied). Try: sudo usermod -aG docker $USER");
            } else {
              p.log.warn("Docker is not running. Demo data requires a PostgreSQL database.");
            }
            p.log.warn(`Start Docker, then run:\n  cd ${projectName} && docker compose up -d postgres && bun run atlas -- init ${demoInitFlag}`);
          } else if (!fs.existsSync(path.join(targetDir, "docker-compose.yml")) && !fs.existsSync(path.join(targetDir, "compose.yml"))) {
            // No compose file (e.g. Vercel template) — can't auto-start Postgres
            p.log.warn("PostgreSQL is not reachable and no docker-compose.yml found in the project.");
            p.log.warn(`Run manually: cd ${projectName} && bun run atlas -- init ${demoInitFlag}`);
          } else {
            p.log.warn("PostgreSQL is not running. Starting it with Docker Compose...");
            try {
              execSync("docker compose up -d postgres", {
                cwd: targetDir,
                stdio: "pipe",
                timeout: 30_000,
              });
              // Wait for Postgres to become healthy
              const waitStart = Date.now();
              while (Date.now() - waitStart < 20_000) {
                try {
                  execSync(
                    `bun -e "const{Pool}=require('pg');const p=new Pool({connectionString:process.env.ATLAS_DATASOURCE_URL,connectionTimeoutMillis:2000});const c=await p.connect();c.release();await p.end()"`,
                    { stdio: "pipe", timeout: 5_000, cwd: targetDir, env: { ...process.env, ATLAS_DATASOURCE_URL: databaseUrl } }
                  );
                  dbReachable = true;
                  break;
                } catch (retryErr) {
                  // Break immediately on non-retryable errors
                  const retryDetail = extractExecOutput(retryErr);
                  if (retryDetail.includes("Cannot find module") || retryDetail.includes("password authentication failed")) {
                    p.log.warn(`Connection error: ${retryDetail}`);
                    break;
                  }
                  // Retryable (ECONNREFUSED, timeout) — wait and try again
                  await new Promise((r) => setTimeout(r, 1_000));
                }
              }
              if (dbReachable) {
                p.log.info("PostgreSQL is ready.");
              } else {
                p.log.warn("PostgreSQL did not become ready in time.");
                p.log.warn(`Run manually: cd ${projectName} && bun run atlas -- init ${demoInitFlag}`);
              }
            } catch (dockerErr) {
              p.log.warn(`Could not start PostgreSQL: ${extractExecOutput(dockerErr)}`);
              p.log.warn(`Run manually:\n  cd ${projectName} && docker compose up -d postgres && bun run atlas -- init ${demoInitFlag}`);
            }
          }
        } else {
          p.log.warn(`Cannot connect to ${databaseUrl.replace(/\/\/[^@]*@/, "//***@")}: ${connDetail.replace(/\/\/[^@]*@/g, "//***@")}`);
          p.log.warn("Check that the database server is running and the connection string is correct.");
          p.log.warn(`Then run: cd ${projectName} && bun run atlas -- init ${demoInitFlag}`);
        }
      }
    }

    if (dbReachable) {
      s.start("Loading demo data and generating semantic layer...");
      try {
        execSync(`bun run atlas -- init ${demoInitFlag}`, {
          cwd: targetDir,
          stdio: "pipe",
          timeout: timeoutMs,
          env: { ...process.env, ATLAS_DATASOURCE_URL: databaseUrl },
        });
        s.stop("Demo data loaded and semantic layer generated.");
      } catch (err) {
        s.stop("Failed to load demo data.");
        setupFailed = true;
        const signal = err && typeof err === "object" && "signal" in err ? (err as { signal: unknown }).signal : null;
        const detail = signal === "SIGTERM"
          ? `Timed out after ${timeoutMs / 1000}s. The demo dataset may need more time on slow connections.`
          : extractExecOutput(err);
        p.log.error(`Demo seeding failed: ${detail}`);
        p.log.error(
          `Run ${pc.cyan(`bun run atlas -- init ${demoInitFlag}`)} manually after resolving the issue.`
        );
      }
    } else {
      setupFailed = true;
      p.log.warn("Skipping demo data seeding (no database connection). The project is ready — seed later.");
    }
  }

  // Step 4b: Generate semantic layer (Postgres/MySQL)
  if (generateSemantic && (dbChoice === "postgres" || dbChoice === "mysql")) {
    s.start("Generating semantic layer from database...");
    try {
      execSync("bun run atlas -- init --enrich", {
        cwd: targetDir,
        stdio: "pipe",
        timeout: 300_000,
        env: { ...process.env, ATLAS_DATASOURCE_URL: databaseUrl },
      });
      s.stop("Semantic layer generated.");
    } catch (err) {
      s.stop("Failed to generate semantic layer.");
      setupFailed = true;
      p.log.error(
        `Semantic layer generation failed: ${err instanceof Error ? err.message : String(err)}`
      );
      p.log.error(
        `Run ${pc.cyan("bun run atlas -- init --enrich")} manually after resolving the issue.`
      );
    }
  }

  // ── Success ───────────────────────────────────────────────────────
  const nextSteps = [`cd ${projectName}`, "bun run dev"];

  let noteBody =
    nextSteps.map((step) => pc.cyan(step)).join("\n");

  if (useDefaults) {
    noteBody += "\n\n" + pc.yellow("Note: .env contains a placeholder API key. Edit it before running.");
  }

  // Platform-specific deployment guidance
  switch (platform) {
    case "vercel":
      noteBody += "\n\n" + pc.dim("Deploy: push to GitHub + connect in Vercel, or run `vercel deploy`.");
      break;
    case "railway":
      noteBody += "\n\n" + pc.dim(
        "Deploy: create 2 Railway services (main + sidecar/).\n" +
        "Set SIDECAR_AUTH_TOKEN on both. Internal networking is pre-configured."
      );
      break;
    case "docker":
      noteBody += "\n\n" + pc.dim(
        "Deploy: docker build -f Dockerfile -t atlas . && docker run -p 3001:3001 atlas\n" +
        "nsjail isolation is built into the Docker image."
      );
      break;
    case "other":
      if (sandboxChoice === "sidecar") {
        noteBody += "\n\n" + pc.dim("Deploy sidecar/ as a separate service. Set SIDECAR_AUTH_TOKEN on both.");
      } else if (sandboxChoice === "e2b" || sandboxChoice === "daytona") {
        noteBody += "\n\n" + pc.dim(`Install ${sandboxChoice === "e2b" ? "@useatlas/e2b" : "@useatlas/daytona"} when available.`);
      }
      break;
  }

  p.note(noteBody, "Next steps");

  let doctorFailed = false;
  if (!skipDoctor && !setupFailed) {
    s.start("Running atlas doctor...");
    try {
      const doctorOutput = execSync("bun run atlas -- doctor", {
        cwd: targetDir,
        stdio: "pipe",
        timeout: 30_000,
        env: { ...process.env, ATLAS_DATASOURCE_URL: databaseUrl },
      });
      s.stop("Health check complete.");
      const output = doctorOutput.toString().trim();
      if (output) {
        console.log(output);
      }
    } catch (err) {
      doctorFailed = true;
      const isExecError = err && typeof err === "object";
      const signal = isExecError && "signal" in err ? (err as { signal: unknown }).signal : null;
      const status = isExecError && "status" in err ? (err as { status: unknown }).status : null;

      if (signal === "SIGTERM") {
        s.stop("Health check timed out.");
        p.log.warn(
          `Atlas doctor timed out after 30s. Run ${pc.cyan("bun run atlas -- doctor")} manually.`
        );
      } else if (status === 1) {
        s.stop("Health check found issues.");
        const stdout = extractExecStream(err, "stdout");
        const stderr = extractExecStream(err, "stderr");
        if (stdout) console.log(stdout);
        if (stderr) p.log.warn(stderr);
        p.log.warn(
          `Some checks failed. Run ${pc.cyan("bun run atlas -- doctor")} after fixing the issues above.`
        );
      } else {
        s.stop("Could not run health check.");
        p.log.warn(`Atlas doctor could not run: ${extractExecOutput(err)}`);
        p.log.warn(
          `Run ${pc.cyan("bun run atlas -- doctor")} manually to validate your setup.`
        );
      }
    }
  }

  // Print total elapsed time
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const timeStr = elapsed >= 60
    ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
    : `${elapsed}s`;

  if (setupFailed) {
    p.outro(`${pc.yellow("Partial setup")} in ${pc.dim(timeStr)}. See errors above.`);
  } else if (doctorFailed) {
    p.outro(`${pc.yellow("Setup complete")} in ${pc.dim(timeStr)} — fix issues above, then ${pc.cyan("bun run dev")}.`);
  } else {
    p.outro(
      `${pc.green("Done!")} Setup complete in ${pc.dim(timeStr)} — ${pc.cyan(`./${projectName}`)} is ready.`
    );
  }
}

main().catch((err) => {
  // Show actionable message, not a stack trace
  const code = err && typeof err === "object" && "code" in err ? (err as { code: string }).code : "";
  const message = err instanceof Error ? err.message : String(err);
  if (code === "EADDRINUSE" || message.includes("EADDRINUSE")) {
    p.log.error(`Port already in use. Stop the process using that port and try again.`);
  } else if (code === "EACCES" || message.includes("EACCES")) {
    p.log.error(`Permission denied. Check file permissions or try a different directory.`);
  } else if (code === "ENOSPC" || message.includes("ENOSPC")) {
    p.log.error(`No space left on disk. Free up space and try again.`);
  } else {
    p.log.error(message);
  }
  process.exit(1);
});
