#!/usr/bin/env bun
import * as p from "@clack/prompts";
import pc from "picocolors";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

const ATLAS_VERSION = "0.1.0";

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

async function main() {
  console.log("");
  p.intro(
    `${pc.bgCyan(pc.black(" create-atlas "))} ${pc.dim(`v${ATLAS_VERSION}`)}`
  );

  // ── 1. Project name ──────────────────────────────────────────────
  const cliArg = process.argv[2];
  let projectName: string;

  if (cliArg && !cliArg.startsWith("-")) {
    projectName = cliArg;
    p.log.info(`Project name: ${pc.cyan(projectName)}`);
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
    const overwrite = await p.confirm({
      message: `Directory ${pc.yellow(projectName)} already exists. Overwrite?`,
      initialValue: false,
    });
    if (p.isCancel(overwrite) || !overwrite) bail("Directory already exists.");
  }

  // ── 2. LLM Provider ──────────────────────────────────────────────
  const provider = await p.select({
    message: "Which LLM provider?",
    options: [
      { value: "anthropic", label: "Anthropic", hint: "Claude (default)" },
      { value: "openai", label: "OpenAI", hint: "GPT-4o" },
      { value: "bedrock", label: "AWS Bedrock", hint: "Region-specific" },
      { value: "ollama", label: "Ollama", hint: "Local models" },
      { value: "gateway", label: "Vercel AI Gateway", hint: "One key, hundreds of models" },
    ],
    initialValue: "anthropic",
  });
  if (p.isCancel(provider)) bail();

  // ── 3. API Key ────────────────────────────────────────────────────
  const keyInfo = PROVIDER_KEY_MAP[provider as string];
  let apiKey = "";

  if (provider === "bedrock") {
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

  // ── 4. Model override ────────────────────────────────────────────
  const defaultModel = PROVIDER_DEFAULT_MODEL[provider as string];
  const modelOverride = await p.text({
    message: `Model override? ${pc.dim(`(default: ${defaultModel})`)}`,
    placeholder: defaultModel,
    defaultValue: "",
  });
  if (p.isCancel(modelOverride)) bail();

  // ── 5. Database URL ───────────────────────────────────────────────
  const databaseUrl = await p.text({
    message: "PostgreSQL connection string:",
    placeholder: "postgresql://atlas:atlas@localhost:5432/atlas",
    defaultValue: "postgresql://atlas:atlas@localhost:5432/atlas",
    validate(value) {
      if (!value.trim()) return "Database URL is required.";
      if (!value.startsWith("postgresql://") && !value.startsWith("postgres://"))
        return "Must be a PostgreSQL connection string (postgresql://...).";
    },
  });
  if (p.isCancel(databaseUrl)) bail();

  // ── 6. Generate semantic layer? ───────────────────────────────────
  let generateSemantic = await p.confirm({
    message: "Generate semantic layer now? (requires database access)",
    initialValue: false,
  });
  if (p.isCancel(generateSemantic)) bail();

  // ── 7. Deployment platform ────────────────────────────────────────
  const platform = await p.select({
    message: "Deployment platform:",
    options: [
      { value: "local", label: "Local only", hint: "Just dev for now" },
      { value: "vercel", label: "Vercel", hint: "Serverless (recommended with Gateway provider)" },
      { value: "railway", label: "Railway" },
      { value: "flyio", label: "Fly.io" },
      { value: "docker", label: "Docker (generic)" },
    ],
    initialValue: "local",
  });
  if (p.isCancel(platform)) bail();

  // ── Pre-flight checks ───────────────────────────────────────────
  try {
    const bunVersion = execSync("bun --version", { encoding: "utf-8", stdio: "pipe" }).trim();
    const [major] = bunVersion.split(".").map(Number);
    if (major < 1) {
      p.log.warn(`Bun ${bunVersion} detected. Atlas requires Bun 1.0+.`);
    }
  } catch {
    p.log.warn("Could not detect bun version.");
  }

  if (["railway", "docker", "flyio"].includes(platform as string)) {
    try {
      execSync("docker --version", { encoding: "utf-8", stdio: "pipe" });
    } catch {
      p.log.warn("Docker not found. You'll need it for deployment.");
    }
  }

  // ── DB connectivity check ──────────────────────────────────────
  if (generateSemantic) {
    const connSpinner = p.spinner();
    connSpinner.start("Checking database connectivity...");
    try {
      execSync(
        `bun -e "const{Pool}=require('pg');const p=new Pool({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000});const c=await p.connect();c.release();await p.end()"`,
        { stdio: "pipe", timeout: 15_000, env: { ...process.env, DATABASE_URL: databaseUrl as string } }
      );
      connSpinner.stop("Database is reachable.");
    } catch {
      connSpinner.stop("Could not connect to database.");
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

  copyDirRecursive(templateDir, targetDir);

  // Replace %PROJECT_NAME% in package.json
  const pkgJsonPath = path.join(targetDir, "package.json");
  const pkgJson = fs.readFileSync(pkgJsonPath, "utf-8");
  fs.writeFileSync(pkgJsonPath, pkgJson.replace(/%PROJECT_NAME%/g, projectName));

  s.stop("Project files copied.");

  // Step 2: Write .env
  s.start("Writing environment configuration...");

  let envContent = `# Generated by create-atlas v${ATLAS_VERSION}\n\n`;
  envContent += `# LLM Provider\n`;
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

  envContent += `\n# Database\n`;
  envContent += `DATABASE_URL=${databaseUrl}\n`;

  if (platform === "vercel") {
    envContent += `\n# Runtime\n`;
    envContent += `ATLAS_RUNTIME=vercel\n`;
  }

  envContent += `\n# Security (defaults)\n`;
  envContent += `ATLAS_READ_ONLY=true\n`;
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
      `Could not run ${pc.cyan("bun install")}. Run it manually in ${pc.yellow(projectName)}/`
    );
  }

  // Step 4: Generate semantic layer if requested
  if (generateSemantic) {
    s.start("Generating semantic layer from database...");
    try {
      execSync("bun run atlas -- init --enrich", {
        cwd: targetDir,
        stdio: "pipe",
        timeout: 300_000,
        env: { ...process.env, DATABASE_URL: databaseUrl as string },
      });
      s.stop("Semantic layer generated.");
    } catch (err) {
      s.stop("Failed to generate semantic layer.");
      p.log.warn(
        `Could not auto-generate semantic layer. Run ${pc.cyan("bun run atlas -- init --enrich")} manually after ensuring your database is accessible.`
      );
    }
  }

  // ── Success ───────────────────────────────────────────────────────
  const nextSteps = [`cd ${projectName}`];

  if (databaseUrl === "postgresql://atlas:atlas@localhost:5432/atlas") {
    nextSteps.push("bun run db:up");
  }

  nextSteps.push("bun run dev");

  // Platform-specific deploy instructions
  const deployInstructions: Record<string, string[]> = {
    railway: [
      "",
      `${pc.bold("Deploy to Railway:")}`,
      `  1. Install Railway CLI: ${pc.cyan("npm i -g @railway/cli")}`,
      `  2. ${pc.cyan("railway login")}`,
      `  3. ${pc.cyan("railway init")}`,
      `  4. ${pc.cyan("railway up")}`,
      `  5. Add a Postgres plugin in the Railway dashboard`,
      `  6. Set env vars: ATLAS_PROVIDER, ${keyInfo?.envVar ?? "API_KEY"}, DATABASE_URL`,
    ],
    flyio: [
      "",
      `${pc.bold("Deploy to Fly.io:")}`,
      `  1. Install Fly CLI: ${pc.cyan("curl -L https://fly.io/install.sh | sh")}`,
      `  2. ${pc.cyan("fly launch")}`,
      `  3. ${pc.cyan("fly postgres create")} and ${pc.cyan("fly postgres attach")}`,
      `  4. Set secrets: ${pc.cyan(`fly secrets set ATLAS_PROVIDER=${provider} ${keyInfo?.envVar ?? "API_KEY"}=...`)}`,
    ],
    docker: [
      "",
      `${pc.bold("Deploy with Docker:")}`,
      `  ${pc.cyan(`docker build -t ${projectName} .`)}`,
      `  ${pc.cyan(`docker run -p 3000:3000 \\`)}`,
      `    ${pc.cyan(`-e ATLAS_PROVIDER=${provider} \\`)}`,
      `    ${pc.cyan(`-e ${keyInfo?.envVar ?? "API_KEY"}=... \\`)}`,
      `    ${pc.cyan(`-e DATABASE_URL=postgresql://... \\`)}`,
      `    ${pc.cyan(projectName)}`,
    ],
    vercel: [
      "",
      `${pc.bold("Deploy to Vercel:")}`,
      `  1. Install Vercel CLI: ${pc.cyan("npm i -g vercel")}`,
      `  2. ${pc.cyan("vercel login")}`,
      `  3. ${pc.cyan("vercel")}`,
      `  4. Set env vars in Vercel dashboard: ATLAS_PROVIDER, ${keyInfo?.envVar ?? "API_KEY"}, DATABASE_URL`,
    ],
    local: [],
  };

  const allSteps = [
    ...nextSteps.map((step) => pc.cyan(step)),
    ...(deployInstructions[platform as string] ?? []),
  ];

  p.note(allSteps.join("\n"), "Next steps");

  p.outro(
    `${pc.green("Done!")} Your Atlas project is ready at ${pc.cyan(`./${projectName}`)}`
  );
}

main().catch((err) => {
  p.log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
