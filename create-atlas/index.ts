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

// Parse --defaults / -y flag for non-interactive mode
const args = process.argv.slice(2);
const useDefaults = args.includes("--defaults") || args.includes("-y");
const positionalArgs = args.filter((a) => !a.startsWith("-"));

// Platform → template mapping
const VALID_PLATFORMS = ["vercel", "railway", "render", "docker", "other"] as const;
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
    railway: `[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template/from-repo?repo=AtlasDevHQ%2Fatlas-starter-railway&referralCode=N5vD3S)`,
    render: `[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/AtlasDevHQ/atlas-starter-render)`,
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

    render: `## Deploy to Render

1. Push to GitHub:
   \`\`\`bash
   git init && git add -A && git commit -m "Initial commit"
   gh repo create ${projectName} --public --source=. --push
   \`\`\`

2. Go to [Render Dashboard](https://dashboard.render.com/) > **New > Blueprint**.

3. Connect your repo. Render reads \`render.yaml\` and creates two services:
   - **Web** — Main API (Dockerfile)
   - **Sidecar** — Explore sandbox (sidecar/Dockerfile)

4. Set the prompted environment variables:
   - \`ATLAS_DATASOURCE_URL\` — Your analytics database
   - \`ANTHROPIC_API_KEY\` — Your API key
   - \`SIDECAR_AUTH_TOKEN\` — Shared secret (same on both services)

5. After deploy, update \`ATLAS_SANDBOX_URL\` on the web service with the sidecar's private URL.`,

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

A text-to-SQL data analyst agent powered by [Atlas](https://useatlas.dev).

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
| \`bun run atlas -- init --demo\` | Load simple demo dataset |
| \`bun run atlas -- init --demo cybersec\` | Load cybersec demo (62 tables) |
| \`bun run atlas -- diff\` | Compare DB schema vs semantic layer |
| \`bun run atlas -- query "question"\` | Headless query (table output) |
| \`bun run test\` | Run tests |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| \`ATLAS_PROVIDER\` | Yes | LLM provider (\`anthropic\`, \`openai\`, \`bedrock\`, \`ollama\`, \`gateway\`) |
| Provider API key | Yes | e.g. \`ANTHROPIC_API_KEY=sk-ant-...\` |
| \`ATLAS_DATASOURCE_URL\` | Yes | Analytics database connection string |
| \`DATABASE_URL\` | No | Atlas internal Postgres (auth, audit). Auto-set on most platforms |
| \`ATLAS_MODEL\` | No | Override the default LLM model |
| \`ATLAS_ROW_LIMIT\` | No | Max rows per query (default: 1000) |

See \`docs/deploy.md\` for the full variable reference.

## Learn More

- [Atlas Documentation](https://useatlas.dev)
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
  Usage: bun create @useatlas [project-name] [options]

  Options:
    --platform <name>  Deploy target (${VALID_PLATFORMS.join(", ")}) [default: docker]
    --preset <name>    Alias for --platform
    --defaults, -y     Use all default values (non-interactive)
    --help, -h         Show this help message

  Platforms:
    vercel     Next.js + embedded API — auto-detects Vercel sandbox
    railway    Hono API + Docker — sidecar sandbox (internal networking)
    render     Hono API + Docker — sidecar sandbox (private service)
    docker     Hono API + Docker — nsjail sandbox (built into image)
    other      Hono API + Docker — choose sandbox: nsjail, sidecar, E2B, Daytona, or none

  Examples:
    bun create @useatlas my-app
    bun create @useatlas my-app --platform vercel
    bun create @useatlas my-app --preset railway
    bun create @useatlas my-app --defaults
`);
  process.exit(0);
}

// Reject unknown flags
const knownFlags = new Set(["--defaults", "-y", "--help", "-h", "--platform", "--preset"]);
const unknownFlags = args.filter((a, i) => {
  if (!a.startsWith("-")) return false;
  if (knownFlags.has(a)) return false;
  // --platform/--preset value argument
  if (i > 0 && (args[i - 1] === "--platform" || args[i - 1] === "--preset")) return false;
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
  console.log("");
  p.intro(
    `${pc.bgCyan(pc.black(" @useatlas/create "))} ${pc.dim(`v${ATLAS_VERSION}`)}`
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
        { value: "render", label: "Render", hint: "Sidecar sandbox via private service" },
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
  let loadDemo = false;
  let demoDataset: "simple" | "cybersec" | "ecommerce" = "simple";
  let generateSemantic = false;

  // Demo data is not available for MySQL (SQL files use PostgreSQL-specific syntax)
  if (dbChoice === "mysql") {
    p.log.info(`Demo data: ${pc.dim("not available for MySQL — use your own database")}`);
    generateSemantic = await confirmOrDefault({
      label: "Generate semantic layer",
      message: "Generate semantic layer now? (requires database access)",
      initialValue: false,
      defaultDisplay: "no",
    });
  } else {
    loadDemo = await confirmOrDefault({
      label: "Demo data",
      message: "Load a demo dataset?",
      initialValue: false,
      defaultDisplay: "no",
    });

    if (loadDemo) {
      demoDataset = await selectOrDefault({
        label: "Demo dataset",
        message: "Which demo dataset?",
        options: [
          { value: "simple", label: "Simple", hint: "3 tables, ~330 rows — quick start" },
          { value: "cybersec", label: "Cybersecurity SaaS", hint: "62 tables, ~500K rows — realistic evaluation" },
          { value: "ecommerce", label: "E-commerce (NovaMart)", hint: "52 tables, ~480K rows — DTC brand + marketplace" },
        ],
        initialValue: "simple" as const,
        defaultDisplay: "Simple",
      });
    } else {
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
      if (err && typeof err === "object" && "stderr" in err) {
        const stderr = String((err as { stderr: unknown }).stderr).trim();
        if (stderr) p.log.warn(stderr);
      }
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
    const needsSidecar = platform === "railway" || platform === "render" ||
      (platform === "other" && sandboxChoice === "sidecar");
    if (!needsSidecar) {
      fs.rmSync(path.join(targetDir, "sidecar"), { recursive: true, force: true });
    }
    if (platform !== "render") {
      fs.rmSync(path.join(targetDir, "render.yaml"), { force: true });
    }
    if (platform !== "railway") {
      fs.rmSync(path.join(targetDir, "railway.json"), { force: true });
    }
    // vercel.json in docker template is noise
    fs.rmSync(path.join(targetDir, "vercel.json"), { force: true });
  }

  // Replace %PROJECT_NAME% in templated files (only files that exist in the template)
  const filesToReplace = ["package.json"];
  if (platform === "render") filesToReplace.push("render.yaml");
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

  let envContent = `# Generated by @useatlas/create v${ATLAS_VERSION}\n\n`;

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
    case "render": {
      const sidecarToken = crypto.randomUUID();
      envContent += `\n# Explore Sandbox (sidecar)\n`;
      envContent += `# Deploy sidecar/ as a Render private service, then update the URL below.\n`;
      envContent += `# ATLAS_SANDBOX_URL=http://<sidecar-private-url>:8080  # Update after deploying sidecar\n`;
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
      ? "@atlas/plugin-e2b-sandbox"
      : "@atlas/plugin-daytona-sandbox";
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
    p.log.warn(
      `Could not run ${pc.cyan("bun install")}: ${err instanceof Error ? err.message : String(err)}`
    );
    p.log.warn(`Run it manually in ${pc.yellow(projectName)}/`);
  }

  // Step 4: Load demo data + generate semantic layer
  if (loadDemo) {
    const demoFlag = `--demo ${demoDataset}`;
    const timeoutMs = demoDataset === "cybersec" || demoDataset === "ecommerce" ? 120_000 : 60_000;
    s.start(`Loading ${demoDataset} demo data and generating semantic layer...`);
    try {
      execSync(`bun run atlas -- init ${demoFlag}`, {
        cwd: targetDir,
        stdio: "pipe",
        timeout: timeoutMs,
        env: { ...process.env, ATLAS_DATASOURCE_URL: databaseUrl },
      });
      s.stop("Demo data loaded and semantic layer generated.");
    } catch (err) {
      s.stop("Failed to load demo data.");
      setupFailed = true;
      let detail = err instanceof Error ? err.message : String(err);
      if (err && typeof err === "object" && "stderr" in err) {
        const stderr = String((err as { stderr: unknown }).stderr).trim();
        if (stderr) detail = stderr;
      }
      if (err && typeof err === "object" && "signal" in err && (err as { signal: unknown }).signal === "SIGTERM") {
        detail = `Timed out after ${timeoutMs / 1000}s. The ${demoDataset} dataset may need more time on slow connections. Run the command manually without a timeout.`;
      }
      p.log.error(`Demo seeding failed: ${detail}`);
      p.log.error(
        `Run ${pc.cyan(`bun run atlas -- init ${demoFlag}`)} manually after resolving the issue.`
      );
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
    case "render":
      noteBody += "\n\n" + pc.dim(
        "Deploy: push to GitHub → New > Blueprint.\n" +
        "Set SIDECAR_AUTH_TOKEN on both services. Update ATLAS_SANDBOX_URL with the sidecar private URL."
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
        noteBody += "\n\n" + pc.dim(`Install ${sandboxChoice === "e2b" ? "@atlas/plugin-e2b-sandbox" : "@atlas/plugin-daytona-sandbox"} when available.`);
      }
      break;
  }

  p.note(noteBody, "Next steps");

  if (setupFailed) {
    p.outro(`${pc.yellow("Partial setup.")} See errors above.`);
  } else {
    p.outro(
      `${pc.green("Done!")} Your Atlas project is ready at ${pc.cyan(`./${projectName}`)}`
    );
  }
}

main().catch((err) => {
  p.log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
