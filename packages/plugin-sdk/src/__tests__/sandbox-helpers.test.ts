/**
 * Tests for the shared sandbox helpers (#3373) — `collectSemanticFiles` and
 * `runHealthCheckWithTimeout`.
 *
 * These single-source two blocks that were copy-pasted across the four sandbox
 * plugins (vercel-sandbox, e2b, daytona, railway-sandbox). The symlink-escape
 * guard in `collectSemanticFiles` is a SECURITY property — a symlink that
 * resolves outside the semantic root must never be uploaded into a sandbox.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { collectSemanticFiles, runHealthCheckWithTimeout } from "../helpers";

function makeLogger() {
  const warnings: string[] = [];
  return {
    warnings,
    logger: { warn: (msg: string) => warnings.push(msg) },
  };
}

// ---------------------------------------------------------------------------
// collectSemanticFiles
// ---------------------------------------------------------------------------

describe("collectSemanticFiles", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "collect-semantic-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("collects files into POSIX-style sandbox paths with Buffer content", () => {
    fs.mkdirSync(path.join(root, "entities"), { recursive: true });
    fs.writeFileSync(path.join(root, "entities", "users.yml"), "table: users\n");
    fs.writeFileSync(path.join(root, "glossary.yml"), "term: revenue\n");

    const files = collectSemanticFiles(root, "semantic");

    const byPath = Object.fromEntries(files.map((f) => [f.path, f.content]));
    expect(Object.keys(byPath).sort()).toEqual([
      "semantic/entities/users.yml",
      "semantic/glossary.yml",
    ]);
    expect(Buffer.isBuffer(byPath["semantic/glossary.yml"])).toBe(true);
    expect(byPath["semantic/entities/users.yml"].toString()).toBe("table: users\n");
  });

  test("preserves binary content unchanged (no encoding round-trip)", () => {
    const bytes = Buffer.from([0x00, 0xff, 0x10, 0x7f, 0x80]);
    fs.writeFileSync(path.join(root, "blob.bin"), bytes);

    const files = collectSemanticFiles(root, "semantic");
    expect(files).toHaveLength(1);
    // content is typed Uint8Array (a Node Buffer at runtime); wrap to compare.
    expect(Buffer.from(files[0].content).equals(bytes)).toBe(true);
  });

  test("follows symlinks that stay inside the semantic root", () => {
    fs.mkdirSync(path.join(root, "real"), { recursive: true });
    fs.writeFileSync(path.join(root, "real", "inner.yml"), "ok: true\n");
    fs.symlinkSync(path.join(root, "real", "inner.yml"), path.join(root, "link.yml"));

    const files = collectSemanticFiles(root, "semantic");
    const paths = files.map((f) => f.path).sort();
    expect(paths).toContain("semantic/link.yml");
    expect(paths).toContain("semantic/real/inner.yml");
  });

  test("SECURITY: rejects a symlink escaping the semantic root", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-secret-"));
    try {
      fs.writeFileSync(path.join(outside, "secret.yml"), "password: hunter2\n");
      fs.writeFileSync(path.join(root, "real.yml"), "table: real\n");
      fs.symlinkSync(path.join(outside, "secret.yml"), path.join(root, "leak.yml"));

      const { warnings, logger } = makeLogger();
      const files = collectSemanticFiles(root, "semantic", logger);

      const paths = files.map((f) => f.path);
      expect(paths).toContain("semantic/real.yml");
      expect(paths).not.toContain("semantic/leak.yml");
      const contents = files.map((f) => f.content.toString());
      expect(contents.some((c) => c.includes("hunter2"))).toBe(false);
      expect(warnings.some((w) => w.includes("escaping semantic root"))).toBe(true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("SECURITY: rejects a symlink to a prefix-collision sibling of the root", () => {
    // `${base}/semantic_evil` shares the `${base}/semantic` string prefix — a
    // bare startsWith() containment check would wrongly accept it. The
    // path.relative-based guard rejects it.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "prefix-collision-"));
    try {
      fs.mkdirSync(path.join(base, "semantic"), { recursive: true });
      fs.mkdirSync(path.join(base, "semantic_evil"), { recursive: true });
      fs.writeFileSync(path.join(base, "semantic", "real.yml"), "table: real\n");
      fs.writeFileSync(path.join(base, "semantic_evil", "secret.yml"), "secret: yes\n");
      fs.symlinkSync(
        path.join(base, "semantic_evil", "secret.yml"),
        path.join(base, "semantic", "leak.yml"),
      );

      const files = collectSemanticFiles(path.join(base, "semantic"), "semantic");
      const paths = files.map((f) => f.path);
      expect(paths.some((p) => p.endsWith("real.yml"))).toBe(true);
      expect(paths.some((p) => p.endsWith("leak.yml"))).toBe(false);
      expect(files.some((f) => f.content.toString().includes("secret: yes"))).toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test("SECURITY: rejects a symlinked DIRECTORY escaping the semantic root", () => {
    // The escape guard must cover the directory-recursion arm, not just files —
    // a symlinked dir pointing outside the root would otherwise leak a whole
    // subtree (e.g. semantic/x -> /etc), the higher-impact exfiltration vector.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-dir-"));
    try {
      fs.mkdirSync(path.join(outside, "secrets"), { recursive: true });
      fs.writeFileSync(path.join(outside, "secrets", "secret.yml"), "password: hunter2\n");
      fs.writeFileSync(path.join(root, "real.yml"), "table: real\n");
      fs.symlinkSync(path.join(outside, "secrets"), path.join(root, "linkdir"));

      const { warnings, logger } = makeLogger();
      const files = collectSemanticFiles(root, "semantic", logger);

      const paths = files.map((f) => f.path);
      expect(paths).toContain("semantic/real.yml");
      expect(paths.some((p) => p.includes("linkdir"))).toBe(false);
      expect(files.some((f) => f.content.toString().includes("hunter2"))).toBe(false);
      expect(warnings.some((w) => w.includes("escaping semantic root"))).toBe(true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("SECURITY: rejects a relative ../ symlink escaping the root", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "relative-escape-"));
    try {
      fs.mkdirSync(path.join(base, "semantic"), { recursive: true });
      fs.writeFileSync(path.join(base, "secret.yml"), "password: hunter2\n");
      fs.writeFileSync(path.join(base, "semantic", "real.yml"), "table: real\n");
      // Relative target climbing out of the root — distinct from the absolute
      // targets the other escape tests use.
      fs.symlinkSync("../secret.yml", path.join(base, "semantic", "leak.yml"));

      const { warnings, logger } = makeLogger();
      const files = collectSemanticFiles(path.join(base, "semantic"), "semantic", logger);
      const paths = files.map((f) => f.path);
      expect(paths.some((p) => p.endsWith("real.yml"))).toBe(true);
      expect(paths.some((p) => p.endsWith("leak.yml"))).toBe(false);
      expect(files.some((f) => f.content.toString().includes("hunter2"))).toBe(false);
      expect(warnings.some((w) => w.includes("escaping semantic root"))).toBe(true);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test("terminates on a self-referential symlink cycle (no duplicate explosion)", () => {
    // A directory symlink pointing back at the root is inside the root, so the
    // escape guard allows it — the cycle-break (visited realpaths) is what
    // stops it from re-walking the tree until the OS aborts with ELOOP.
    fs.writeFileSync(path.join(root, "real.yml"), "table: real\n");
    fs.symlinkSync(root, path.join(root, "selflink"));

    const files = collectSemanticFiles(root, "semantic");
    const realYmls = files.filter((f) => f.path.endsWith("real.yml"));
    // real.yml is collected exactly once; the self-link is not re-walked.
    expect(realYmls).toHaveLength(1);
    expect(files.some((f) => f.path.includes("selflink"))).toBe(false);
  });

  test("returns empty (logs warn) when the semantic root is unreadable/missing", () => {
    const { warnings, logger } = makeLogger();
    const files = collectSemanticFiles(
      path.join(root, "does-not-exist"),
      "semantic",
      logger,
    );
    expect(files).toEqual([]);
    expect(warnings.some((w) => w.includes("unreadable semantic root"))).toBe(true);
  });

  test("skips an unreadable file but keeps the rest (logs warn)", () => {
    fs.writeFileSync(path.join(root, "good.yml"), "ok: true\n");
    fs.writeFileSync(path.join(root, "bad.yml"), "secret: 1\n");

    const realReadFileSync = fs.readFileSync;
    const spy = spyOn(fs, "readFileSync").mockImplementation(
      ((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
        if (typeof p === "string" && p.endsWith("bad.yml")) {
          throw new Error("EACCES: permission denied");
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (realReadFileSync as any)(p, ...rest);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    );

    try {
      const { warnings, logger } = makeLogger();
      const files = collectSemanticFiles(root, "semantic", logger);
      const paths = files.map((f) => f.path);
      expect(paths).toContain("semantic/good.yml");
      expect(paths).not.toContain("semantic/bad.yml");
      expect(warnings.some((w) => w.includes("unreadable file") && w.includes("bad.yml"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test("skips an unreadable subdirectory but keeps the rest (logs warn)", () => {
    fs.mkdirSync(path.join(root, "open"), { recursive: true });
    fs.mkdirSync(path.join(root, "locked"), { recursive: true });
    fs.writeFileSync(path.join(root, "open", "a.yml"), "a: 1\n");
    fs.writeFileSync(path.join(root, "locked", "b.yml"), "b: 1\n");

    const realReaddirSync = fs.readdirSync;
    const spy = spyOn(fs, "readdirSync").mockImplementation(
      ((p: fs.PathLike, ...rest: unknown[]) => {
        if (typeof p === "string" && p.endsWith(`${path.sep}locked`)) {
          throw new Error("EACCES: permission denied");
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (realReaddirSync as any)(p, ...rest);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    );

    try {
      const { warnings, logger } = makeLogger();
      const files = collectSemanticFiles(root, "semantic", logger);
      const paths = files.map((f) => f.path);
      expect(paths).toContain("semantic/open/a.yml");
      expect(paths).not.toContain("semantic/locked/b.yml");
      expect(warnings.some((w) => w.includes("unreadable directory"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// runHealthCheckWithTimeout
// ---------------------------------------------------------------------------

describe("runHealthCheckWithTimeout", () => {
  test("returns the probe result plus a measured latency on success", async () => {
    const cleanup = mock(() => Promise.resolve());
    const result = await runHealthCheckWithTimeout(
      async () => ({ healthy: true }),
      { timeoutMs: 1_000, cleanup },
    );
    expect(result.healthy).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    // Cleanup is the timeout/error safety net — never invoked on success.
    expect(cleanup).not.toHaveBeenCalled();
  });

  test("passes through an unhealthy probe result without invoking cleanup", async () => {
    const cleanup = mock(() => Promise.resolve());
    const result = await runHealthCheckWithTimeout(
      async () => ({ healthy: false, message: "exit 1" }),
      { timeoutMs: 1_000, cleanup },
    );
    expect(result.healthy).toBe(false);
    expect(result.message).toBe("exit 1");
    expect(typeof result.latencyMs).toBe("number");
    expect(cleanup).not.toHaveBeenCalled();
  });

  test("times out a hung probe and runs cleanup", async () => {
    let cleaned = false;
    // Simulates a create() that hangs past the timeout — the helper must not
    // wait for it, and must run cleanup so the sandbox reference is reaped.
    const result = await runHealthCheckWithTimeout(
      () => new Promise(() => {}),
      {
        timeoutMs: 20,
        cleanup: () => {
          cleaned = true;
        },
      },
    );
    expect(result.healthy).toBe(false);
    expect(result.message).toContain("timed out after 20ms");
    // latencyMs is attached on the timeout branch too — the branch a refactor
    // is most likely to forget.
    expect(typeof result.latencyMs).toBe("number");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(cleaned).toBe(true);
  });

  test("times out mid-create and cleans up the reference the probe assigned", async () => {
    // Mirrors the real plugins: the probe assigns a sandbox ref while creating,
    // the timeout wins before create resolves, and cleanup destroys whatever
    // the probe left behind.
    let sandbox: { destroyed: boolean } | null = null;
    const cleanup = mock(async () => {
      if (sandbox) {
        sandbox.destroyed = true;
        sandbox = null;
      }
    });
    const result = await runHealthCheckWithTimeout(
      async () => {
        sandbox = { destroyed: false };
        await new Promise((r) => setTimeout(r, 200)); // create hangs past timeout
        return { healthy: true };
      },
      { timeoutMs: 20, cleanup },
    );
    expect(result.healthy).toBe(false);
    expect(result.message).toContain("timed out after 20ms");
    // cleanup is the timeout safety net — it must fire exactly once even though
    // the probe also nulls its own ref on its (losing) happy path.
    expect(cleanup).toHaveBeenCalledTimes(1);
    // wait for the slow probe to finish so the ref it set is observable
    await new Promise((r) => setTimeout(r, 250));
    // cleanup nulled it before the probe's create resolved
    expect(sandbox).toBeNull();
  });

  test("returns unhealthy and runs cleanup when the probe throws", async () => {
    const cleanup = mock(() => Promise.resolve());
    const result = await runHealthCheckWithTimeout(
      async () => {
        throw new Error("quota exceeded");
      },
      { timeoutMs: 1_000, cleanup },
    );
    expect(result.healthy).toBe(false);
    expect(result.message).toBe("quota exceeded");
    expect(cleanup).toHaveBeenCalled();
  });

  test("a throwing cleanup is logged, not propagated", async () => {
    const { warnings, logger } = makeLogger();
    const result = await runHealthCheckWithTimeout(
      async () => {
        throw new Error("probe boom");
      },
      {
        timeoutMs: 1_000,
        cleanup: () => {
          throw new Error("cleanup boom");
        },
        logger,
      },
    );
    expect(result.healthy).toBe(false);
    expect(result.message).toBe("probe boom");
    expect(warnings.some((w) => w.includes("cleanup") && w.includes("cleanup boom"))).toBe(true);
  });

  test("normalizes a non-Error probe rejection into a string message", async () => {
    const result = await runHealthCheckWithTimeout(
      async () => {
        throw "plain string failure";
      },
      { timeoutMs: 1_000, cleanup: () => {} },
    );
    expect(result.healthy).toBe(false);
    expect(result.message).toBe("plain string failure");
  });

  test("handles a synchronously-throwing probe (not just async rejection)", async () => {
    // Promise.race invokes fn() synchronously, so a sync throw escapes the race
    // and is caught only by the outer try/catch — a distinct code path.
    const cleanup = mock(() => Promise.resolve());
    const result = await runHealthCheckWithTimeout(
      (() => {
        throw new Error("sync boom");
      }) as unknown as () => Promise<{ healthy: boolean }>,
      { timeoutMs: 1_000, cleanup },
    );
    expect(result.healthy).toBe(false);
    expect(result.message).toBe("sync boom");
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  test("logs a warning on the probe-throw branch", async () => {
    const { warnings, logger } = makeLogger();
    await runHealthCheckWithTimeout(
      async () => {
        throw new Error("quota exceeded");
      },
      { timeoutMs: 1_000, cleanup: () => {}, logger },
    );
    expect(warnings.some((w) => w.includes("probe failed") && w.includes("quota exceeded"))).toBe(
      true,
    );
  });

  test("logs a warning on the timeout branch", async () => {
    const { warnings, logger } = makeLogger();
    await runHealthCheckWithTimeout(() => new Promise(() => {}), {
      timeoutMs: 20,
      cleanup: () => {},
      logger,
    });
    expect(warnings.some((w) => w.includes("timed out after 20ms"))).toBe(true);
  });

  test("throws on a non-positive or non-finite timeoutMs", async () => {
    for (const bad of [0, -5, NaN, Infinity]) {
      await expect(
        runHealthCheckWithTimeout(async () => ({ healthy: true }), {
          timeoutMs: bad,
          cleanup: () => {},
        }),
      ).rejects.toThrow(/timeoutMs must be a positive, finite number/);
    }
  });
});
