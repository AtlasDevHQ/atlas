import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";

// Mock @clack/prompts BEFORE importing env-check — Bun requires mock.module() to precede the import
const mockConfirm = mock(() => Promise.resolve(true));
const mockLogWarn = mock(() => {});
const mockLogSuccess = mock(() => {});
const mockCancel = mock(() => {});
const mockIsCancel = mock(() => false);

mock.module("@clack/prompts", () => ({
  confirm: mockConfirm,
  isCancel: mockIsCancel,
  cancel: mockCancel,
  log: {
    warn: mockLogWarn,
    success: mockLogSuccess,
    info: mock(() => {}),
    error: mock(() => {}),
    message: mock(() => {}),
    step: mock(() => {}),
  },
  intro: mock(() => {}),
  outro: mock(() => {}),
  spinner: mock(() => ({ start: mock(() => {}), stop: mock(() => {}) })),
  text: mock(() => Promise.resolve("")),
  password: mock(() => Promise.resolve("")),
  select: mock(() => Promise.resolve("")),
  selectKey: mock(() => Promise.resolve("")),
  multiselect: mock(() => Promise.resolve([])),
  groupMultiselect: mock(() => Promise.resolve([])),
  note: mock(() => {}),
  group: mock(() => Promise.resolve({})),
  tasks: mock(() => Promise.resolve()),
  updateSettings: mock(() => {}),
  stream: { message: mock(() => Promise.resolve()) },
}));

import { checkEnvFile, ENV_COMMANDS } from "../env-check";

describe("env-check", () => {
  let origCwd: typeof process.cwd;
  let tmpDir: string;
  let origIsTTY: boolean | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join("/tmp", "env-check-test-"));
    origCwd = process.cwd;
    process.cwd = () => tmpDir;
    origIsTTY = process.stdin.isTTY;

    mockConfirm.mockReset();
    mockConfirm.mockResolvedValue(true);
    mockLogWarn.mockReset();
    mockLogSuccess.mockReset();
    mockCancel.mockReset();
    mockIsCancel.mockReset();
    mockIsCancel.mockReturnValue(false);
  });

  afterEach(() => {
    process.cwd = origCwd;
    Object.defineProperty(process.stdin, "isTTY", { value: origIsTTY, writable: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("ENV_COMMANDS", () => {
    test("includes all env-dependent commands", () => {
      for (const cmd of ["init", "diff", "query", "doctor", "validate", "mcp", "migrate"]) {
        expect(ENV_COMMANDS.has(cmd)).toBe(true);
      }
    });

    test("does not include env-independent commands", () => {
      for (const cmd of ["eval", "benchmark", "smoke", "completions", "plugin"]) {
        expect(ENV_COMMANDS.has(cmd)).toBe(false);
      }
    });
  });

  describe("checkEnvFile", () => {
    test("skips when .env already exists", async () => {
      fs.writeFileSync(path.join(tmpDir, ".env"), "EXISTING=1");
      fs.writeFileSync(path.join(tmpDir, ".env.example"), "EXAMPLE=1");
      Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });

      await checkEnvFile("init");

      expect(mockConfirm).not.toHaveBeenCalled();
      expect(mockLogWarn).not.toHaveBeenCalled();
    });

    test("skips when neither .env nor .env.example exists", async () => {
      Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });

      await checkEnvFile("init");

      expect(mockConfirm).not.toHaveBeenCalled();
      expect(mockLogWarn).not.toHaveBeenCalled();
    });

    test("skips for non-env commands", async () => {
      fs.writeFileSync(path.join(tmpDir, ".env.example"), "EXAMPLE=1");
      Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });

      await checkEnvFile("completions");

      expect(mockConfirm).not.toHaveBeenCalled();
    });

    test("skips for undefined command", async () => {
      fs.writeFileSync(path.join(tmpDir, ".env.example"), "EXAMPLE=1");
      Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });

      await checkEnvFile(undefined);

      expect(mockConfirm).not.toHaveBeenCalled();
    });

    test("warns in non-TTY when .env.example exists but .env does not", async () => {
      fs.writeFileSync(path.join(tmpDir, ".env.example"), "EXAMPLE=1");
      Object.defineProperty(process.stdin, "isTTY", { value: false, writable: true });

      await checkEnvFile("init");

      expect(mockLogWarn).toHaveBeenCalledWith(
        "No .env file found. Copy .env.example to .env and configure it.",
      );
      expect(mockConfirm).not.toHaveBeenCalled();
    });

    test("prompts in TTY and copies on confirmation", async () => {
      const exampleContent = "ATLAS_DATASOURCE_URL=postgresql://localhost/mydb\nATLAS_PROVIDER=anthropic\n";
      fs.writeFileSync(path.join(tmpDir, ".env.example"), exampleContent);
      Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });
      mockConfirm.mockResolvedValue(true);

      await checkEnvFile("doctor");

      expect(mockConfirm).toHaveBeenCalledWith({
        message: "No .env file found. Copy from .env.example?",
        initialValue: true,
      });
      expect(mockLogSuccess).toHaveBeenCalledWith(
        "Created .env — edit it with your database URL and API key.",
      );
      const created = fs.readFileSync(path.join(tmpDir, ".env"), "utf-8");
      expect(created).toBe(exampleContent);
    });

    test("does not copy when user declines", async () => {
      fs.writeFileSync(path.join(tmpDir, ".env.example"), "EXAMPLE=1");
      Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });
      mockConfirm.mockResolvedValue(false);

      await checkEnvFile("init");

      expect(mockConfirm).toHaveBeenCalled();
      expect(mockLogSuccess).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(tmpDir, ".env"))).toBe(false);
    });

    test("exits on cancel", async () => {
      fs.writeFileSync(path.join(tmpDir, ".env.example"), "EXAMPLE=1");
      Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });
      mockIsCancel.mockReturnValue(true);

      const exitError = new Error("process.exit");
      const origExit = process.exit;
      process.exit = (() => { throw exitError; }) as never;

      try {
        await checkEnvFile("init");
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBe(exitError);
      } finally {
        process.exit = origExit;
      }

      expect(mockCancel).toHaveBeenCalledWith("Operation cancelled.");
    });

    test("warns gracefully when copy fails", async () => {
      fs.writeFileSync(path.join(tmpDir, ".env.example"), "EXAMPLE=1");
      Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });
      mockConfirm.mockResolvedValue(true);

      // Make directory read-only so copyFileSync fails with EACCES
      fs.chmodSync(tmpDir, 0o555);

      await checkEnvFile("init");

      // Should have warned instead of crashing
      expect(mockLogWarn).toHaveBeenCalled();
      const warnCall = mockLogWarn.mock.calls[0] as unknown[];
      expect(warnCall[0]).toContain("Could not copy .env.example to .env");

      // Restore permissions for cleanup
      fs.chmodSync(tmpDir, 0o755);
    });

    test("works for all env-dependent commands", async () => {
      Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });

      for (const cmd of ENV_COMMANDS) {
        fs.writeFileSync(path.join(tmpDir, ".env.example"), "X=1");
        mockConfirm.mockReset();
        mockConfirm.mockResolvedValue(false);

        await checkEnvFile(cmd);

        expect(mockConfirm).toHaveBeenCalled();

        // Clean up .env for next iteration (may not exist if user declined)
        if (fs.existsSync(path.join(tmpDir, ".env"))) {
          fs.unlinkSync(path.join(tmpDir, ".env"));
        }
      }
    });
  });
});
