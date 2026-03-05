import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import {
  pluginTemplate,
  pluginTestTemplate,
  pluginPackageJsonTemplate,
  pluginTsconfigTemplate,
  handlePluginCreate,
  handlePluginAdd,
} from "../atlas";

// ---------------------------------------------------------------------------
// Template generation — pure functions, no mocks needed
// ---------------------------------------------------------------------------

describe("pluginTemplate", () => {
  test("generates datasource template with definePlugin", () => {
    const result = pluginTemplate("my-source", "datasource");
    expect(result).toContain('import { definePlugin } from "@useatlas/plugin-sdk"');
    expect(result).toContain('id: "my-source"');
    expect(result).toContain('type: "datasource"');
    expect(result).toContain("satisfies AtlasDatasourcePlugin");
    expect(result).toContain("connection:");
    expect(result).toContain("dbType:");
  });

  test("generates context template with contextProvider", () => {
    const result = pluginTemplate("my-ctx", "context");
    expect(result).toContain('id: "my-ctx"');
    expect(result).toContain('type: "context"');
    expect(result).toContain("contextProvider:");
    expect(result).toContain("satisfies AtlasContextPlugin");
  });

  test("generates interaction template with routes", () => {
    const result = pluginTemplate("my-interaction", "interaction");
    expect(result).toContain('id: "my-interaction"');
    expect(result).toContain('type: "interaction"');
    expect(result).toContain("routes(app:");
    expect(result).toContain("satisfies AtlasInteractionPlugin");
  });

  test("generates action template with actions array", () => {
    const result = pluginTemplate("my-action", "action");
    expect(result).toContain('id: "my-action"');
    expect(result).toContain('type: "action"');
    expect(result).toContain("actions:");
    expect(result).toContain("satisfies AtlasActionPlugin");
    expect(result).toContain('import { tool } from "ai"');
  });

  test("converts kebab-case name to PascalCase for display name", () => {
    const result = pluginTemplate("my-cool-plugin", "datasource");
    expect(result).toContain("MyCoolPlugin");
  });
});

describe("pluginTestTemplate", () => {
  test("generates test with correct plugin id assertion", () => {
    const result = pluginTestTemplate("test-plugin", "datasource");
    expect(result).toContain('expect(plugin.id).toBe("test-plugin")');
    expect(result).toContain('expect(plugin.type).toBe("datasource")');
    expect(result).toContain("healthCheck");
  });
});

describe("pluginPackageJsonTemplate", () => {
  test("generates valid JSON with correct name", () => {
    const result = pluginPackageJsonTemplate("my-plugin");
    const parsed = JSON.parse(result);
    expect(parsed.name).toBe("atlas-plugin-my-plugin");
    expect(parsed.peerDependencies["@useatlas/plugin-sdk"]).toBe("workspace:*");
    expect(parsed.main).toBe("src/index.ts");
  });
});

describe("pluginTsconfigTemplate", () => {
  test("generates valid JSON extending root config", () => {
    const result = pluginTsconfigTemplate();
    const parsed = JSON.parse(result);
    expect(parsed.extends).toBe("../../../tsconfig.json");
    expect(parsed.include).toContain("src");
  });
});

// ---------------------------------------------------------------------------
// handlePluginCreate — integration test (writes to tmp directory)
// ---------------------------------------------------------------------------

describe("handlePluginCreate", () => {
  let tmpDir: string;
  let originalCwd: string;
  let originalExit: typeof process.exit;
  let exitCode: number | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join("/tmp", "atlas-plugin-test-"));
    originalCwd = process.cwd();
    process.chdir(tmpDir);
    originalExit = process.exit;
    exitCode = undefined;
  });

  afterEach(() => {
    process.exit = originalExit;
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function mockExit() {
    process.exit = ((code: number) => {
      exitCode = code;
      throw new Error("process.exit called");
    }) as never;
  }

  test("creates correct file structure for datasource plugin", async () => {
    await handlePluginCreate(["create", "test-ds", "--type", "datasource"]);

    const pluginDir = path.join(tmpDir, "plugins", "test-ds");
    expect(fs.existsSync(path.join(pluginDir, "src", "index.ts"))).toBe(true);
    expect(fs.existsSync(path.join(pluginDir, "src", "index.test.ts"))).toBe(true);
    expect(fs.existsSync(path.join(pluginDir, "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(pluginDir, "tsconfig.json"))).toBe(true);

    const indexContent = fs.readFileSync(path.join(pluginDir, "src", "index.ts"), "utf-8");
    expect(indexContent).toContain('type: "datasource"');
    expect(indexContent).toContain('id: "test-ds"');

    const pkgJson = JSON.parse(fs.readFileSync(path.join(pluginDir, "package.json"), "utf-8"));
    expect(pkgJson.name).toBe("atlas-plugin-test-ds");
  });

  test("creates correct file structure for action plugin", async () => {
    await handlePluginCreate(["create", "my-action", "--type", "action"]);

    const pluginDir = path.join(tmpDir, "plugins", "my-action");
    expect(fs.existsSync(path.join(pluginDir, "src", "index.ts"))).toBe(true);

    const indexContent = fs.readFileSync(path.join(pluginDir, "src", "index.ts"), "utf-8");
    expect(indexContent).toContain('type: "action"');
    expect(indexContent).toContain("actions:");
  });

  test("creates correct file structure for context plugin", async () => {
    await handlePluginCreate(["create", "my-ctx", "--type", "context"]);

    const pluginDir = path.join(tmpDir, "plugins", "my-ctx");
    const indexContent = fs.readFileSync(path.join(pluginDir, "src", "index.ts"), "utf-8");
    expect(indexContent).toContain('type: "context"');
    expect(indexContent).toContain("contextProvider:");
  });

  test("creates correct file structure for interaction plugin", async () => {
    await handlePluginCreate(["create", "my-web", "--type", "interaction"]);

    const pluginDir = path.join(tmpDir, "plugins", "my-web");
    const indexContent = fs.readFileSync(path.join(pluginDir, "src", "index.ts"), "utf-8");
    expect(indexContent).toContain('type: "interaction"');
    expect(indexContent).toContain("routes(app:");
  });

  test("exits with error if directory already exists", async () => {
    const pluginDir = path.join(tmpDir, "plugins", "existing");
    fs.mkdirSync(pluginDir, { recursive: true });
    mockExit();

    try {
      await handlePluginCreate(["create", "existing", "--type", "datasource"]);
    } catch {
      // expected — process.exit throws
    }

    expect(exitCode).toBe(1);
  });

  test("exits with error for invalid plugin type", async () => {
    mockExit();

    try {
      await handlePluginCreate(["create", "bad-plugin", "--type", "invalid"]);
    } catch {
      // expected
    }

    expect(exitCode).toBe(1);
  });

  test("exits with error when --type is missing", async () => {
    mockExit();

    try {
      await handlePluginCreate(["create", "no-type"]);
    } catch {
      // expected
    }

    expect(exitCode).toBe(1);
  });

  test("exits with error when name is missing", async () => {
    mockExit();

    try {
      await handlePluginCreate(["create", "--type", "datasource"]);
    } catch {
      // expected
    }

    expect(exitCode).toBe(1);
  });

  // Name validation — prevents path traversal and injection
  test("rejects name with path traversal characters", async () => {
    mockExit();

    try {
      await handlePluginCreate(["create", "../../../escape", "--type", "datasource"]);
    } catch {
      // expected
    }

    expect(exitCode).toBe(1);
  });

  test("rejects name starting with a digit", async () => {
    mockExit();

    try {
      await handlePluginCreate(["create", "1bad-name", "--type", "datasource"]);
    } catch {
      // expected
    }

    expect(exitCode).toBe(1);
  });

  test("rejects name with shell metacharacters", async () => {
    mockExit();

    try {
      await handlePluginCreate(["create", "name;rm", "--type", "datasource"]);
    } catch {
      // expected
    }

    expect(exitCode).toBe(1);
  });

  test("rejects name starting with a hyphen", async () => {
    mockExit();

    try {
      await handlePluginCreate(["create", "-dash-start", "--type", "datasource"]);
    } catch {
      // expected
    }

    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// handlePluginAdd — argument validation
// ---------------------------------------------------------------------------

describe("handlePluginAdd", () => {
  let originalExit: typeof process.exit;
  let exitCode: number | undefined;

  beforeEach(() => {
    originalExit = process.exit;
    exitCode = undefined;
  });

  afterEach(() => {
    process.exit = originalExit;
  });

  function mockExit() {
    process.exit = ((code: number) => {
      exitCode = code;
      throw new Error("process.exit called");
    }) as never;
  }

  test("exits with error when package name is missing", async () => {
    mockExit();

    try {
      await handlePluginAdd(["add"]);
    } catch {
      // expected
    }

    expect(exitCode).toBe(1);
  });

  test("exits with error when package name starts with --", async () => {
    mockExit();

    try {
      await handlePluginAdd(["add", "--something"]);
    } catch {
      // expected
    }

    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// handlePluginList — mock config to test listing
// ---------------------------------------------------------------------------

describe("handlePluginList (mock config)", () => {
  test("handler exists and is callable", async () => {
    // Full integration test deferred — requires mocking loadConfig, which is non-trivial with Bun's mock.module().
    expect(typeof (await import("../atlas")).handlePluginList).toBe("function");
  });
});
