import { describe, it, expect } from "bun:test";

import {
  captureDatasourceSecret,
  DATASOURCE_SECRET_ENV,
  type SecretCaptureDeps,
} from "../lib/datasource-secret";

const URL = "postgres://user:pw@host:5432/db";

/** Build capture deps with explicit branches; `promptSecret` defaults to never-called. */
function deps(over: Partial<SecretCaptureDeps>): SecretCaptureDeps {
  return {
    envValue: undefined,
    isTTY: false,
    promptSecret: async () => {
      throw new Error("promptSecret should not have been called");
    },
    ...over,
  };
}

describe("captureDatasourceSecret — env path (#4051)", () => {
  it("reads the URL from the env var without prompting, regardless of TTY", async () => {
    const result = await captureDatasourceSecret(deps({ envValue: URL, isTTY: true }));
    expect(result).toEqual({ kind: "captured", url: URL, source: "env" });
  });

  it("trims surrounding whitespace from the env value", async () => {
    const result = await captureDatasourceSecret(deps({ envValue: `  ${URL}\n` }));
    expect(result).toEqual({ kind: "captured", url: URL, source: "env" });
  });

  it("a set-but-blank env var defers as empty_env rather than silently prompting", async () => {
    // isTTY:true would otherwise allow a prompt — assert the blank env var is a
    // hard misconfiguration, not a fall-through (the prompt dep throws if called).
    const result = await captureDatasourceSecret(deps({ envValue: "   ", isTTY: true }));
    expect(result).toEqual({ kind: "deferred", reason: "empty_env" });
  });
});

describe("captureDatasourceSecret — stdin path (#4051)", () => {
  it("prompts when there is a TTY and no env var", async () => {
    const result = await captureDatasourceSecret(
      deps({ isTTY: true, promptSecret: async () => URL }),
    );
    expect(result).toEqual({ kind: "captured", url: URL, source: "stdin" });
  });

  it("trims the prompted value", async () => {
    const result = await captureDatasourceSecret(
      deps({ isTTY: true, promptSecret: async () => ` ${URL} ` }),
    );
    expect(result).toEqual({ kind: "captured", url: URL, source: "stdin" });
  });

  it("a cancelled prompt (null) defers as cancelled", async () => {
    const result = await captureDatasourceSecret(
      deps({ isTTY: true, promptSecret: async () => null }),
    );
    expect(result).toEqual({ kind: "deferred", reason: "cancelled" });
  });

  it("an empty prompt entry defers as empty_stdin", async () => {
    const result = await captureDatasourceSecret(
      deps({ isTTY: true, promptSecret: async () => "   " }),
    );
    expect(result).toEqual({ kind: "deferred", reason: "empty_stdin" });
  });
});

describe("captureDatasourceSecret — CI defer path (#4051)", () => {
  it("no TTY and no env var defers as no_tty_no_env (dashboard/MCP fallback)", async () => {
    const result = await captureDatasourceSecret(deps({ isTTY: false, envValue: undefined }));
    expect(result).toEqual({ kind: "deferred", reason: "no_tty_no_env" });
  });
});

describe("the secret env var name is stable (#4051)", () => {
  it("is ATLAS_DATASOURCE_SECRET", () => {
    expect(DATASOURCE_SECRET_ENV).toBe("ATLAS_DATASOURCE_SECRET");
  });
});
