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
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4o",
  bedrock: "anthropic.claude-sonnet-4-6-v1",
  ollama: "llama3.1",
  gateway: "anthropic/claude-sonnet-4.6",
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

// Handle --help / -h
if (args.includes("--help") || args.includes("-h")) {
  console.log(`
  Usage: bun create atlas-agent [project-name] [options]

  Options:
    --defaults, -y   Use all default values (non-interactive)
    --help, -h       Show this help message

  Examples:
    bun create atlas-agent my-app
    bun create atlas-agent my-app --defaults
`);
  process.exit(0);
}

// Reject unknown flags
const knownFlags = new Set(["--defaults", "-y", "--help", "-h"]);
const unknownFlags = args.filter((a) => a.startsWith("-") && !knownFlags.has(a));
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

  // ── 2. Database choice ────────────────────────────────────────────
  const dbChoice = await selectOrDefault({
    label: "Database",
    message: "Which database?",
    options: [
      { value: "sqlite", label: "SQLite", hint: "Instant start, no setup (default)" },
      { value: "postgres", label: "PostgreSQL", hint: "Bring your connection string" },
    ],
    initialValue: "sqlite",
    defaultDisplay: "SQLite",
  });

  // ── 3. PostgreSQL connection string (if postgres) ─────────────────
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
  } else {
    databaseUrl = "file:./data/atlas.db";
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
  let generateSemantic = false;

  if (dbChoice === "sqlite") {
    loadDemo = await confirmOrDefault({
      label: "Demo data",
      message: "Load demo dataset? (50 companies, ~200 people, 80 accounts)",
      initialValue: true,
      defaultDisplay: "yes",
    });
  } else {
    generateSemantic = await confirmOrDefault({
      label: "Generate semantic layer",
      message: "Generate semantic layer now? (requires database access)",
      initialValue: false,
      defaultDisplay: "no",
    });
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

  // ── DB connectivity check (Postgres only) ────────────────────────
  if (generateSemantic && dbChoice === "postgres") {
    const connSpinner = p.spinner();
    connSpinner.start("Checking database connectivity...");
    try {
      execSync(
        `bun -e "const{Pool}=require('pg');const p=new Pool({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000});const c=await p.connect();c.release();await p.end()"`,
        { stdio: "pipe", timeout: 15_000, env: { ...process.env, DATABASE_URL: databaseUrl } }
      );
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
  const templateDir = path.join(import.meta.dir, "template");

  if (!fs.existsSync(templateDir)) {
    s.stop("Template directory not found.");
    bail("Could not find template/ directory. Is the package installed correctly?");
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

  // Replace %PROJECT_NAME% in templated files
  const filesToReplace = ["package.json", "fly.toml", "render.yaml"];
  for (const file of filesToReplace) {
    const filePath = path.join(targetDir, file);
    if (!fs.existsSync(filePath)) {
      s.stop(`Template file missing: ${file}`);
      bail(`${file} was not found after copying the template. Is the package installed correctly?`);
    }
    const content = fs.readFileSync(filePath, "utf-8");
    const replaced = content.replace(/%PROJECT_NAME%/g, projectName);
    if (content === replaced && content.includes("PROJECT_NAME")) {
      p.log.warn(`${file} may contain unreplaced template variables.`);
    }
    fs.writeFileSync(filePath, replaced);
  }

  s.stop("Project files copied.");

  // Step 2: Write .env
  s.start("Writing environment configuration...");

  let envContent = `# Generated by create-atlas-agent v${ATLAS_VERSION}\n\n`;

  envContent += `# Database\n`;
  if (dbChoice === "sqlite") {
    envContent += `# SQLite — zero setup, data stored locally\n`;
    envContent += `DATABASE_URL=${databaseUrl}\n`;
    envContent += `# To switch to PostgreSQL later:\n`;
    envContent += `# DATABASE_URL=postgresql://user:pass@host:5432/dbname\n`;
  } else {
    envContent += `DATABASE_URL=${databaseUrl}\n`;
  }

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

  fs.writeFileSync(path.join(targetDir, ".env"), envContent);
  s.stop("Environment file written.");

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

  // Step 4: Load demo data + generate semantic layer (SQLite)
  if (loadDemo && dbChoice === "sqlite") {
    s.start("Loading demo data and generating semantic layer...");
    try {
      execSync("bun run atlas -- init --demo", {
        cwd: targetDir,
        stdio: "pipe",
        timeout: 60_000,
        env: { ...process.env, DATABASE_URL: databaseUrl },
      });
      s.stop("Demo data loaded and semantic layer generated.");
    } catch (err) {
      s.stop("Failed to load demo data.");
      let detail = err instanceof Error ? err.message : String(err);
      if (err && typeof err === "object" && "stderr" in err) {
        const stderr = String((err as { stderr: unknown }).stderr).trim();
        if (stderr) detail = stderr;
      }
      p.log.warn(`Demo seeding failed: ${detail}`);
      p.log.warn(
        `Run ${pc.cyan("bun run atlas -- init --demo")} manually after resolving the issue.`
      );
    }
  }

  // Step 4b: Generate semantic layer (Postgres)
  if (generateSemantic && dbChoice === "postgres") {
    s.start("Generating semantic layer from database...");
    try {
      execSync("bun run atlas -- init --enrich", {
        cwd: targetDir,
        stdio: "pipe",
        timeout: 300_000,
        env: { ...process.env, DATABASE_URL: databaseUrl },
      });
      s.stop("Semantic layer generated.");
    } catch (err) {
      s.stop("Failed to generate semantic layer.");
      p.log.warn(
        `Semantic layer generation failed: ${err instanceof Error ? err.message : String(err)}`
      );
      p.log.warn(
        `Run ${pc.cyan("bun run atlas -- init --enrich")} manually after resolving the issue.`
      );
    }
  }

  // ── Success ───────────────────────────────────────────────────────
  const nextSteps = [`cd ${projectName}`, "bun run dev"];

  let noteBody =
    nextSteps.map((step) => pc.cyan(step)).join("\n") +
    "\n\n" +
    pc.dim("See docs/deploy.md for deployment options (Railway, Fly.io, Docker, Vercel).");
  if (useDefaults) {
    noteBody += "\n" + pc.yellow("Note: .env contains a placeholder API key. Edit it before running.");
  }
  if (dbChoice === "sqlite") {
    noteBody += "\n" + pc.dim("Note: SQLite data is ephemeral in containers. Use PostgreSQL for production.");
  }

  p.note(noteBody, "Next steps");

  p.outro(
    `${pc.green("Done!")} Your Atlas project is ready at ${pc.cyan(`./${projectName}`)}`
  );
}

main().catch((err) => {
  p.log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
