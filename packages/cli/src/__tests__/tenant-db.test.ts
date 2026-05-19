/**
 * Tests for the shared tenant-db helpers — covers `resolveTenantUrl`'s env
 * precedence (ATLAS_TEAM_PG_URL wins over DATABASE_URL) and the exit-with-
 * error path. `resolveWorkspaceId` is covered in proactive.test.ts.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { resolveTenantUrl } from "../../lib/tenant-db";

const errors: string[] = [];
const origConsoleError = console.error;
const origExit = process.exit;

let exitCode: number | null = null;

beforeEach(() => {
  errors.length = 0;
  exitCode = null;
  console.error = (...args: unknown[]) => {
    errors.push(args.map((a) => String(a)).join(" "));
  };
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`__process_exit__:${exitCode}`);
  }) as unknown as typeof process.exit;
});

afterEach(() => {
  console.error = origConsoleError;
  process.exit = origExit;
});

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k]!;
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  }
}

describe("resolveTenantUrl", () => {
  it("returns ATLAS_TEAM_PG_URL when only it is set", () => {
    withEnv(
      { ATLAS_TEAM_PG_URL: "postgresql://team", DATABASE_URL: undefined },
      () => {
        expect(resolveTenantUrl()).toBe("postgresql://team");
      },
    );
  });

  it("returns DATABASE_URL when only it is set", () => {
    withEnv(
      { ATLAS_TEAM_PG_URL: undefined, DATABASE_URL: "postgresql://db" },
      () => {
        expect(resolveTenantUrl()).toBe("postgresql://db");
      },
    );
  });

  it("prefers ATLAS_TEAM_PG_URL over DATABASE_URL when both are set", () => {
    // Pinning precedence — flipping `||` operands would silently point ops
    // tools at the dev DB while ATLAS_TEAM_PG_URL points at the tenant.
    withEnv(
      { ATLAS_TEAM_PG_URL: "postgresql://team", DATABASE_URL: "postgresql://db" },
      () => {
        expect(resolveTenantUrl()).toBe("postgresql://team");
      },
    );
  });

  it("exits 1 with a clear error when neither var is set", () => {
    const caughtMessage = withEnv(
      { ATLAS_TEAM_PG_URL: undefined, DATABASE_URL: undefined },
      (): string | null => {
        try {
          resolveTenantUrl();
          return null;
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      },
    );
    expect(caughtMessage).toBe("__process_exit__:1");
    expect(
      errors.some(
        (line) =>
          line.includes("ATLAS_TEAM_PG_URL") && line.includes("DATABASE_URL"),
      ),
    ).toBe(true);
  });
});
