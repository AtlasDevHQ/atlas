import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  assembleNsjailArgs,
  buildNsjailArgs,
  buildPythonNsjailArgs,
  BASE_JAIL_ENV,
} from "@atlas/api/lib/tools/backends/nsjail";

// ---------------------------------------------------------------------------
// Golden exact-array locks for the shared nsjail arg assembler.
//
// nsjail arg-building is security-critical (it is the sandbox boundary) and,
// per #4187, now lives in ONE place (assembleNsjailArgs) fed by the explore and
// Python spec adapters. These tests pin the FULL arg array for each tool so any
// accidental drift in the shared serialization — a dropped `-u 65534`, a
// reordered mount, a changed rlimit — fails loudly rather than silently
// weakening isolation. The existing explore-nsjail / python-nsjail suites check
// individual flags; this file asserts byte-for-byte equality of the whole list.
// ---------------------------------------------------------------------------

const NSJAIL_LIMIT_ENV = [
  "ATLAS_NSJAIL_TIME_LIMIT",
  "ATLAS_NSJAIL_MEMORY_LIMIT",
] as const;

describe("assembleNsjailArgs golden arrays", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Neutralize any ambient resource-limit overrides so the golden arrays
    // reflect the built-in defaults (10s/256MB explore, 30s/512MB Python).
    for (const key of NSJAIL_LIMIT_ENV) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of NSJAIL_LIMIT_ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("explore args are byte-for-byte stable (defaults)", () => {
    expect(buildNsjailArgs("/usr/local/bin/nsjail", "/semantic-root", "ls -la")).toEqual([
      "/usr/local/bin/nsjail",
      "--mode", "o",
      "-R", "/semantic-root:/semantic",
      "-R", "/bin",
      "-R", "/usr/bin",
      "-R", "/lib",
      "-R", "/lib64",
      "-R", "/usr/lib",
      "-R", "/dev/null",
      "-R", "/dev/zero",
      "-R", "/dev/urandom",
      "--proc_path", "/proc",
      "-T", "/tmp",
      "--cwd", "/semantic",
      "-t", "10",
      "--rlimit_as", "256",
      "--rlimit_fsize", "10",
      "--rlimit_nproc", "5",
      "--rlimit_nofile", "64",
      "-u", "65534",
      "-g", "65534",
      "--quiet",
      "--", "/bin/bash", "-c", "ls -la",
    ]);
  });

  it("Python args are byte-for-byte stable (defaults)", () => {
    expect(
      buildPythonNsjailArgs(
        "/usr/local/bin/nsjail",
        "/tmp/pyexec-x",
        "/tmp/pyexec-x/user_code.py",
        "/tmp/pyexec-x/wrapper.py",
        "/tmp/pyexec-x/charts",
        "__ATLAS_RESULT_x__",
      ),
    ).toEqual([
      "/usr/local/bin/nsjail",
      "--mode", "o",
      "-R", "/bin",
      "-R", "/usr/bin",
      "-R", "/usr/local/bin",
      "-R", "/lib",
      "-R", "/lib64",
      "-R", "/usr/lib",
      "-R", "/usr/local/lib",
      "-R", "/dev/null",
      "-R", "/dev/zero",
      "-R", "/dev/urandom",
      "--proc_path", "/proc",
      "-T", "/tmp",
      "-R", "/tmp/pyexec-x/wrapper.py:/tmp/wrapper.py",
      "-R", "/tmp/pyexec-x/user_code.py:/tmp/user_code.py",
      "-B", "/tmp/pyexec-x/charts:/tmp/charts",
      "--cwd", "/tmp",
      "-t", "30",
      "--rlimit_as", "512",
      "--rlimit_fsize", "50",
      "--rlimit_nproc", "16",
      "--rlimit_nofile", "128",
      "-u", "65534",
      "-g", "65534",
      "--pass_fd", "0",
      "--quiet",
      "--", "/usr/bin/python3", "/tmp/wrapper.py", "/tmp/user_code.py",
    ]);
  });

  it("both tools run as nobody (65534) and suppress nsjail logs", () => {
    const explore = buildNsjailArgs("/nsjail", "/root", "echo hi");
    const python = buildPythonNsjailArgs("/nsjail", "/t", "/t/c.py", "/t/w.py", "/t/charts", "m");
    for (const args of [explore, python]) {
      expect(args[args.indexOf("-u") + 1]).toBe("65534");
      expect(args[args.indexOf("-g") + 1]).toBe("65534");
      expect(args).toContain("--quiet");
      expect(args).toContain("--mode");
    }
  });

  it("assembleNsjailArgs omits --pass_fd unless passStdin is set", () => {
    const withoutStdin = assembleNsjailArgs({
      nsjailPath: "/nsjail",
      systemMounts: ["/bin"],
      cwd: "/tmp",
      timeLimitSec: 5,
      rlimitAs: 128,
      rlimitFsize: 10,
      rlimitNproc: 3,
      rlimitNofile: 32,
      command: ["/bin/true"],
    });
    expect(withoutStdin).not.toContain("--pass_fd");

    const withStdin = assembleNsjailArgs({
      nsjailPath: "/nsjail",
      systemMounts: ["/bin"],
      cwd: "/tmp",
      timeLimitSec: 5,
      rlimitAs: 128,
      rlimitFsize: 10,
      rlimitNproc: 3,
      rlimitNofile: 32,
      passStdin: true,
      command: ["/bin/true"],
    });
    expect(withStdin[withStdin.indexOf("--pass_fd") + 1]).toBe("0");
  });

  it("BASE_JAIL_ENV carries no secrets", () => {
    expect(BASE_JAIL_ENV).toEqual({
      PATH: "/bin:/usr/bin",
      HOME: "/tmp",
      LANG: "C.UTF-8",
    });
  });
});
