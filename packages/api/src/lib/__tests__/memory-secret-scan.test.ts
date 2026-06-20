/**
 * Unit tests for the durable-memory secret/credential heuristic (#3757,
 * ADR-0020). The detector is a write-time guard: a slot value that looks like a
 * credential is rejected BEFORE it is persisted, so memory never becomes an
 * exfiltration surface for a leaked key. It is deliberately conservative —
 * matching well-known credential SHAPES (provider key prefixes, PEM private-key
 * blocks, JWTs, bearer headers, connection-string passwords, and long
 * high-entropy tokens) rather than attempting universal secret detection.
 *
 * The detector walks the same JSON value the store persists, so a secret nested
 * inside an object/array is caught, not just a top-level string.
 */

import { describe, expect, it } from "bun:test";
import { findSecretLike } from "@atlas/api/lib/memory-secret-scan";

describe("findSecretLike — credential SHAPES are rejected", () => {
  it("flags common provider API-key prefixes", () => {
    // The prefix is split from the body so the literal credential SHAPE never
    // appears in source — GitHub push-protection / secret-scanning would block
    // the commit on a `ghp_…` / `xoxb-…` literal even though these are fake test
    // values. `findSecretLike` sees the JOINED string at runtime, so the
    // detector is exercised exactly as in production.
    const fakeBody = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
    for (const value of [
      `sk-ant-api03-${fakeBody}AbCdEfGhIj`, // Anthropic
      `sk-proj-${fakeBody}`, // OpenAI project key
      "AKIAIOSFODNN7EXAMPLE", // AWS access key id (GitHub's own canonical placeholder)
      `gh${"p"}_${fakeBody}`, // GitHub PAT
      `xox${"b"}-1234567890-ABCDEFGHIJKLMNOPQRSTUVWX`, // Slack bot token
    ]) {
      expect(findSecretLike(value)).not.toBeNull();
    }
  });

  it("flags a PEM private-key block", () => {
    expect(
      findSecretLike("-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----"),
    ).not.toBeNull();
  });

  it("flags a JWT (three base64url segments)", () => {
    expect(
      findSecretLike(
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      ),
    ).not.toBeNull();
  });

  it("flags a bearer authorization header", () => {
    expect(findSecretLike("Authorization: Bearer abcDEF123456ghiJKL789mnoPQR")).not.toBeNull();
  });

  it("flags a connection string carrying an inline password", () => {
    expect(findSecretLike("postgres://admin:s3cr3tPassw0rd@db.internal:5432/app")).not.toBeNull();
    expect(findSecretLike("password=hunter2-not-a-place-holder")).not.toBeNull();
  });

  it("flags a long high-entropy token even without a known prefix", () => {
    // 40+ chars, mixed case + digits, no whitespace — the shape of a raw secret.
    // A random base62 token runs ~5.2–6.0 bits/char, well clear of the 4.5
    // threshold (which DW identifiers at ~4.2–4.3 sit below), so raising the
    // threshold to admit table names must NOT let a real secret through.
    expect(findSecretLike("Zk8Qw3Lm7Rt9Yv2Xb5Nc1Pd4Fg6Hj0Sa8Ue3Wq7Ko9")).not.toBeNull();
    expect(findSecretLike("Ah7Kd92mZq4Xn5Rb8Lw3Tc6Vy1Pf0Gj4Hs7Mu2Eo9Iq")).not.toBeNull();
  });

  it("walks into nested objects and arrays", () => {
    // `gh${"p"}_` keeps the GitHub-PAT shape out of the source literal (push
    // protection) while the runtime-joined value still trips the detector.
    const ghpToken = `gh${"p"}_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789`;
    expect(findSecretLike({ config: { apiKey: "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789" } })).not.toBeNull();
    expect(findSecretLike(["ok", ["nested", ghpToken]])).not.toBeNull();
  });
});

describe("findSecretLike — ordinary analyst memory is allowed", () => {
  it("does not flag plain prose, identifiers, or short values", () => {
    for (const value of [
      "orders",
      "The user means EU revenue, not global.",
      { lastTable: "orders", filters: { region: "EU" }, rowCount: 1432 },
      ["2026-Q1", "2026-Q2"],
      "select * from orders where region = 'EU'",
      42,
      true,
      null,
    ]) {
      expect(findSecretLike(value)).toBeNull();
    }
  });

  it("does not flag a UUID (structured, but not a credential shape)", () => {
    expect(findSecretLike("11111111-2222-3333-4444-555555555555")).toBeNull();
  });

  it("does not flag a long but low-entropy string (repeated / dictionary words)", () => {
    expect(findSecretLike("the quick brown fox jumps over the lazy dog again and again")).toBeNull();
  });

  it("does not flag a content hash an analyst might remember (hex digest / git sha)", () => {
    // Hex digests sit at ~3.8–4.0 bits/char from a 16-symbol alphabet — below the
    // entropy threshold, so these realistic remembered values pass.
    expect(findSecretLike("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")).toBeNull();
    expect(findSecretLike("a70849d88f3c2e1b4d5a6c7e8f9012345678abcd")).toBeNull();
  });

  it("does not flag a long snake_case data-warehouse identifier with digits", () => {
    // Underscore-separated table/column names with a year/version suffix run
    // 40+ chars and land at ~4.2–4.3 bits/char — they MUST pass the entropy
    // fallback (a remembered table name is ordinary analyst memory, #3757 AC).
    for (const id of [
      "daily_revenue_summary_by_product_category_2024",
      "fact_daily_active_users_by_region_2026_q01_v2",
      "dim_customer_lifetime_value_cohort_2025_2026_v3",
    ]) {
      expect(findSecretLike(id)).toBeNull();
    }
  });

  it("does not flag a long SQL string or a dashed slug list", () => {
    expect(
      findSecretLike("select region, sum(revenue) from orders where fiscal_quarter = '2026-Q1' group by region"),
    ).toBeNull();
    expect(findSecretLike("us-east-prod, eu-west-prod, ap-south-staging, eu-central-prod")).toBeNull();
  });

  it("does not flag a remembered SQL query that COMPARES a credential-named COLUMN", () => {
    // The inline-credential-assignment shape (`api_key = …`, `password = …`)
    // legitimately appears in analyst SQL as a column predicate, not a secret.
    // A remembered query must not be rejected (#3757 AC: no SQL false positives).
    for (const sql of [
      "SELECT id FROM sessions WHERE api_key = '2026-q1-prod'",
      "SELECT * FROM users WHERE access_token = 'current_user_token'",
      "SELECT id FROM accounts WHERE password = 'changeme'",
      "select name from cfg where secret = 'foobar' order by name",
      "UPDATE jobs SET auth_token = 'pending' WHERE status = 'queued'",
    ]) {
      expect(findSecretLike(sql)).toBeNull();
    }
  });
});

describe("findSecretLike — inline credential assignment still caught WITHOUT SQL context", () => {
  it("flags a bare credential assignment (no surrounding SQL keywords)", () => {
    // The SQL guard must not blind the detector to a genuinely leaked secret
    // pasted as a key=value line. These carry NO SELECT/FROM/WHERE context.
    expect(findSecretLike("password=hunter2-not-a-place-holder")).not.toBeNull();
    expect(findSecretLike("api_key: prod-9f3a-do-not-share-2026")).not.toBeNull();
    expect(findSecretLike("AUTH_TOKEN = a8Xk2Lm9Qw7Rt4Yv1Zb")).not.toBeNull();
  });
});
