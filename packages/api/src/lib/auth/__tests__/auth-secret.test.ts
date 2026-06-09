/**
 * parseAuthSecret — length floor + published-placeholder denylist
 * (#3342 L-6). The `.env.example` value passes the ≥32-char check and
 * doubles as the at-rest encryption-key fallback, so a production deploy
 * that shipped it would have a publicly-known signing AND encryption key.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { parseAuthSecret } from "../server";

const PLACEHOLDER = "atlas-dev-secret-do-not-use-in-production!!";

describe("parseAuthSecret", () => {
  const origNodeEnv = process.env.NODE_ENV;
  const origDeployMode = process.env.ATLAS_DEPLOY_MODE;

  beforeEach(() => {
    delete process.env.ATLAS_DEPLOY_MODE;
  });

  afterEach(() => {
    if (origNodeEnv !== undefined) process.env.NODE_ENV = origNodeEnv;
    else delete process.env.NODE_ENV;
    if (origDeployMode !== undefined) process.env.ATLAS_DEPLOY_MODE = origDeployMode;
    else delete process.env.ATLAS_DEPLOY_MODE;
  });

  it("throws on missing secret", () => {
    expect(() => parseAuthSecret(undefined)).toThrow(/not set/);
  });

  it("throws on short secret", () => {
    expect(() => parseAuthSecret("too-short")).toThrow(/at least 32/);
  });

  it("accepts a ≥32-char random secret", () => {
    expect(parseAuthSecret("0123456789abcdef0123456789abcdef")).toBe(
      "0123456789abcdef0123456789abcdef" as ReturnType<typeof parseAuthSecret>,
    );
  });

  it("refuses the published .env.example placeholder in production (#3342 L-6)", () => {
    process.env.NODE_ENV = "production";
    expect(() => parseAuthSecret(PLACEHOLDER)).toThrow(/placeholder/);
  });

  it("refuses the published placeholder under SaaS deploy mode", () => {
    process.env.NODE_ENV = "test";
    process.env.ATLAS_DEPLOY_MODE = "saas";
    expect(() => parseAuthSecret(PLACEHOLDER)).toThrow(/placeholder/);
  });

  it("allows (with a warning) the placeholder in local dev", () => {
    process.env.NODE_ENV = "test";
    expect(parseAuthSecret(PLACEHOLDER)).toBe(
      PLACEHOLDER as ReturnType<typeof parseAuthSecret>,
    );
  });
});
