/**
 * E2E: Scaffold tests (Phase 6).
 *
 * Tests the full @useatlas/create scaffolding flow in isolated temp
 * directories. No Docker services or secrets needed.
 *
 * Issue: https://github.com/AtlasDevHQ/atlas/issues/225
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

// --- Constants ---

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const CREATE_ATLAS = path.join(REPO_ROOT, "create-atlas");
const SCAFFOLDER = path.join(CREATE_ATLAS, "index.ts");

// Generous timeouts — builds can take 60s+ on slow machines
const SCAFFOLD_TIMEOUT = 120_000;
const BUILD_TIMEOUT = 180_000;

// --- Helpers ---

/** Create a temp directory for scaffolding and return its path. */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? "/tmp"), "atlas-e2e-scaffold-"));
}

/** Run a shell command, re-throwing with captured stderr/stdout on failure. */
function run(cmd: string, opts: { cwd: string; timeout: number; env?: NodeJS.ProcessEnv }): void {
  try {
    execSync(cmd, { ...opts, stdio: "pipe" });
  } catch (err: unknown) {
    const e = err as Error & { stderr?: Buffer; stdout?: Buffer };
    const stderr = e.stderr?.toString().trim();
    const stdout = e.stdout?.toString().trim();
    throw new Error(
      [
        e.message,
        stderr && `--- stderr ---\n${stderr}`,
        stdout && `--- stdout ---\n${stdout}`,
      ].filter(Boolean).join("\n"),
    );
  }
}

/** Scaffold a project using create-atlas with --defaults and a given platform. */
function scaffold(
  tmpDir: string,
  projectName: string,
  platform: string,
  extraFlags = "",
): void {
  run(
    `bun ${SCAFFOLDER} ${projectName} --defaults --platform ${platform} ${extraFlags}`.trim(),
    { cwd: tmpDir, timeout: SCAFFOLD_TIMEOUT, env: { ...process.env, NO_COLOR: "1" } },
  );
}

/** Check if Postgres is reachable at the default demo connection string. */
function isPostgresReachable(): boolean {
  try {
    execSync(
      `bun -e "const{Pool}=require('pg');const p=new Pool({connectionString:'postgresql://atlas:atlas@localhost:5432/atlas',connectionTimeoutMillis:3000});const c=await p.connect();c.release();await p.end()"`,
      { stdio: "pipe", timeout: 10_000 },
    );
    return true;
  } catch {
    return false;
  }
}

/** Read and parse a JSON file, including the file path in any parse error. */
function readJson(filePath: string): Record<string, unknown> {
  const content = fs.readFileSync(filePath, "utf-8");
  try {
    return JSON.parse(content);
  } catch (err) {
    throw new Error(`Failed to parse JSON from ${filePath}: ${(err as Error).message}`);
  }
}

// --- Setup: ensure templates are prepared ---

beforeAll(() => {
  // Install create-atlas deps (not a workspace package — has its own node_modules)
  run("bun install", { cwd: CREATE_ATLAS, timeout: 30_000 });
  // Run prepublishOnly to sync templates from monorepo source
  run("bun run prepublishOnly", { cwd: CREATE_ATLAS, timeout: 60_000 });
});

// --- Tests ---

describe("E2E: Scaffold — Docker template", () => {
  const projectName = "e2e-scaffold-docker";
  let tmpDir: string;
  let targetDir: string;

  beforeAll(() => {
    tmpDir = makeTempDir();
    targetDir = path.join(tmpDir, projectName);
    scaffold(tmpDir, projectName, "docker");
  });

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates the project directory", () => {
    expect(fs.existsSync(targetDir)).toBe(true);
  });

  it("has .gitignore (renamed from gitignore)", () => {
    expect(fs.existsSync(path.join(targetDir, ".gitignore"))).toBe(true);
    // Source file should be renamed, not duplicated
    expect(fs.existsSync(path.join(targetDir, "gitignore"))).toBe(false);
  });

  it("has .env with required variables", () => {
    const envPath = path.join(targetDir, ".env");
    expect(fs.existsSync(envPath)).toBe(true);

    const envContent = fs.readFileSync(envPath, "utf-8");
    expect(envContent).toContain("ATLAS_PROVIDER=anthropic");
    expect(envContent).toContain("ATLAS_DATASOURCE_URL=");
    expect(envContent).toContain("ATLAS_SANDBOX=nsjail");
  });

  it("has package.json with correct project name", () => {
    const pkg = readJson(path.join(targetDir, "package.json"));
    expect(pkg.name).toBe(projectName);
  });

  it("has Dockerfile", () => {
    expect(fs.existsSync(path.join(targetDir, "Dockerfile"))).toBe(true);
  });

  it("has semantic/ directory", () => {
    expect(fs.existsSync(path.join(targetDir, "semantic"))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, "semantic", "catalog.yml"))).toBe(true);
  });

  it("has public/ directory", () => {
    expect(fs.existsSync(path.join(targetDir, "public"))).toBe(true);
  });

  it("has node_modules (bun install succeeded)", () => {
    expect(fs.existsSync(path.join(targetDir, "node_modules"))).toBe(true);
  });

  it("removes platform-irrelevant files", () => {
    // Docker platform should not have railway.json or sidecar/
    expect(fs.existsSync(path.join(targetDir, "railway.json"))).toBe(false);
    expect(fs.existsSync(path.join(targetDir, "sidecar"))).toBe(false);
    expect(fs.existsSync(path.join(targetDir, "vercel.json"))).toBe(false);
  });
});

// Build tests are skipped until #270 is resolved (template package.json
// dependencies are out of sync with the API source they copy).
// See: https://github.com/AtlasDevHQ/atlas/issues/270
describe.skip("E2E: Scaffold — Docker template build", () => {
  const projectName = "e2e-scaffold-docker-build";
  let tmpDir: string;
  let targetDir: string;

  beforeAll(() => {
    tmpDir = makeTempDir();
    targetDir = path.join(tmpDir, projectName);
    scaffold(tmpDir, projectName, "docker");
  });

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("builds successfully", () => {
    run("bun run build", {
      cwd: targetDir,
      timeout: BUILD_TIMEOUT,
      env: { ...process.env, VERCEL: undefined },
    });

    expect(fs.existsSync(path.join(targetDir, ".next", "standalone"))).toBe(true);
  }, BUILD_TIMEOUT);
});

describe("E2E: Scaffold — NextJS Standalone template", () => {
  const projectName = "e2e-scaffold-nextjs";
  let tmpDir: string;
  let targetDir: string;

  beforeAll(() => {
    tmpDir = makeTempDir();
    targetDir = path.join(tmpDir, projectName);
    scaffold(tmpDir, projectName, "vercel");
  });

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates the project directory", () => {
    expect(fs.existsSync(targetDir)).toBe(true);
  });

  it("has .gitignore", () => {
    expect(fs.existsSync(path.join(targetDir, ".gitignore"))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, "gitignore"))).toBe(false);
  });

  it("has .env with Vercel-specific config", () => {
    const envPath = path.join(targetDir, ".env");
    expect(fs.existsSync(envPath)).toBe(true);

    const envContent = fs.readFileSync(envPath, "utf-8");
    expect(envContent).toContain("ATLAS_PROVIDER=anthropic");
    expect(envContent).toContain("ATLAS_DATASOURCE_URL=");
    // Vercel should NOT have nsjail sandbox config
    expect(envContent).not.toContain("ATLAS_SANDBOX=nsjail");
  });

  it("has package.json with correct project name", () => {
    const pkg = readJson(path.join(targetDir, "package.json"));
    expect(pkg.name).toBe(projectName);
  });

  it("has vercel.json", () => {
    expect(fs.existsSync(path.join(targetDir, "vercel.json"))).toBe(true);
  });

  it("has semantic/ directory", () => {
    expect(fs.existsSync(path.join(targetDir, "semantic"))).toBe(true);
  });

  it("has API catch-all route", () => {
    expect(
      fs.existsSync(path.join(targetDir, "src", "app", "api", "[...route]", "route.ts")),
    ).toBe(true);
  });

  it("has node_modules (bun install succeeded)", () => {
    expect(fs.existsSync(path.join(targetDir, "node_modules"))).toBe(true);
  });

  it("does not have Docker-specific files", () => {
    expect(fs.existsSync(path.join(targetDir, "Dockerfile"))).toBe(false);
  });
});

describe.skip("E2E: Scaffold — NextJS Standalone build", () => {
  const projectName = "e2e-scaffold-nextjs-build";
  let tmpDir: string;
  let targetDir: string;

  beforeAll(() => {
    tmpDir = makeTempDir();
    targetDir = path.join(tmpDir, projectName);
    scaffold(tmpDir, projectName, "vercel");
  });

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("builds successfully", () => {
    run("bun run build", {
      cwd: targetDir,
      timeout: BUILD_TIMEOUT,
      env: { ...process.env, VERCEL: undefined },
    });

    expect(fs.existsSync(path.join(targetDir, ".next"))).toBe(true);
  }, BUILD_TIMEOUT);
});

describe("E2E: Scaffold — Railway platform", () => {
  const projectName = "e2e-scaffold-railway";
  let tmpDir: string;
  let targetDir: string;

  beforeAll(() => {
    tmpDir = makeTempDir();
    targetDir = path.join(tmpDir, projectName);
    scaffold(tmpDir, projectName, "railway");
  });

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("has railway.json", () => {
    expect(fs.existsSync(path.join(targetDir, "railway.json"))).toBe(true);
  });

  it("has sidecar/ directory", () => {
    expect(fs.existsSync(path.join(targetDir, "sidecar"))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, "sidecar", "Dockerfile"))).toBe(true);
  });

  it("has .env with sidecar config", () => {
    const envPath = path.join(targetDir, ".env");
    expect(fs.existsSync(envPath)).toBe(true);

    const envContent = fs.readFileSync(envPath, "utf-8");
    expect(envContent).toContain("ATLAS_SANDBOX_URL=");
    expect(envContent).toContain("SIDECAR_AUTH_TOKEN=");
  });

  it("does not have vercel.json", () => {
    expect(fs.existsSync(path.join(targetDir, "vercel.json"))).toBe(false);
  });
});

describe("E2E: Scaffold — --demo flag", () => {
  const projectName = "e2e-scaffold-demo";
  let tmpDir: string;
  let targetDir: string;
  let pgAvailable: boolean;

  beforeAll(() => {
    pgAvailable = isPostgresReachable();
    tmpDir = makeTempDir();
    targetDir = path.join(tmpDir, projectName);
    scaffold(tmpDir, projectName, "docker", "--demo");
  }, SCAFFOLD_TIMEOUT);

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates the project directory", () => {
    expect(fs.existsSync(targetDir)).toBe(true);
  });

  it("has .env with correct variables", () => {
    const envContent = fs.readFileSync(path.join(targetDir, ".env"), "utf-8");
    expect(envContent).toContain("ATLAS_PROVIDER=anthropic");
    expect(envContent).toContain("ATLAS_DATASOURCE_URL=");
  });

  it("has package.json with correct name", () => {
    const pkg = readJson(path.join(targetDir, "package.json"));
    expect(pkg.name).toBe(projectName);
  });

  it("has node_modules (bun install succeeded)", () => {
    expect(fs.existsSync(path.join(targetDir, "node_modules"))).toBe(true);
  });

  it("has demo data files in data/", () => {
    expect(fs.existsSync(path.join(targetDir, "data", "demo.sql"))).toBe(true);
  });

  it("has semantic directory from template", () => {
    expect(fs.existsSync(path.join(targetDir, "semantic"))).toBe(true);
  });

  it.skipIf(!pgAvailable)("has profiled entity files when Postgres is available", () => {
    // With Postgres, the profiler should have generated entity files
    const entitiesDir = path.join(targetDir, "semantic", "entities");
    expect(fs.existsSync(entitiesDir)).toBe(true);
    const entityFiles = fs.readdirSync(entitiesDir).filter((f) => f.endsWith(".yml"));
    expect(entityFiles.length).toBeGreaterThanOrEqual(3); // simple demo: accounts, companies, people
  });
});

describe("E2E: Scaffold — --demo with dataset name", () => {
  it("accepts valid dataset name (cybersec)", () => {
    const tmpDir = makeTempDir();
    const projectName = "e2e-demo-cybersec";
    try {
      scaffold(tmpDir, projectName, "docker", "--demo cybersec");
      const targetDir = path.join(tmpDir, projectName);
      // Verify the project was created (not a project named "cybersec")
      expect(fs.existsSync(targetDir)).toBe(true);
      const pkg = readJson(path.join(targetDir, "package.json"));
      expect(pkg.name).toBe(projectName);
      // Verify demo data files exist
      expect(fs.existsSync(path.join(targetDir, "data", "cybersec.sql"))).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, SCAFFOLD_TIMEOUT);

  it("rejects unknown dataset names", () => {
    const tmpDir = makeTempDir();
    try {
      expect(() => {
        run(
          `bun ${SCAFFOLDER} test-bad-demo --defaults --demo badname`,
          { cwd: tmpDir, timeout: SCAFFOLD_TIMEOUT, env: { ...process.env, NO_COLOR: "1" } },
        );
      }).toThrow(/Unknown demo dataset/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("E2E: Scaffold — error handling", () => {
  it("rejects unknown flags", () => {
    const tmpDir = makeTempDir();
    try {
      expect(() => {
        run(
          `bun ${SCAFFOLDER} test-unknown-flag --defaults --banana`,
          { cwd: tmpDir, timeout: SCAFFOLD_TIMEOUT, env: { ...process.env, NO_COLOR: "1" } },
        );
      }).toThrow(/Unknown flag/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects existing directory with --defaults", () => {
    const tmpDir = makeTempDir();
    const projectName = "e2e-existing-dir";
    const targetDir = path.join(tmpDir, projectName);
    fs.mkdirSync(targetDir);
    try {
      expect(() => {
        run(
          `bun ${SCAFFOLDER} ${projectName} --defaults`,
          { cwd: tmpDir, timeout: SCAFFOLD_TIMEOUT, env: { ...process.env, NO_COLOR: "1" } },
        );
      }).toThrow(/already exists/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
