import { describe, expect, test } from "bun:test";

import { generatePkce, generateState } from "../src/pkce";
import { deterministicRandom } from "./_helpers";

describe("generatePkce", () => {
  test("returns method=S256 (OAuth 2.1 mandates; plain forbidden)", async () => {
    const result = await generatePkce({ randomBytesImpl: deterministicRandom });
    expect(result.method).toBe("S256");
  });

  test("codeVerifier is base64url (no padding, no +, no /)", async () => {
    const result = await generatePkce({ randomBytesImpl: deterministicRandom });
    expect(result.codeVerifier).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(result.codeVerifier).not.toContain("=");
  });

  test("codeChallenge is the base64url SHA-256 of the verifier", async () => {
    const result = await generatePkce({ randomBytesImpl: deterministicRandom });
    // Recompute the SHA-256 of the verifier and compare.
    const data = new TextEncoder().encode(result.codeVerifier);
    const digest = await crypto.subtle.digest("SHA-256", data);
    const bytes = new Uint8Array(digest);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const expected = btoa(bin)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(result.codeChallenge).toBe(expected);
  });

  test("deterministic when randomBytesImpl is pinned", async () => {
    const a = await generatePkce({ randomBytesImpl: deterministicRandom });
    const b = await generatePkce({ randomBytesImpl: deterministicRandom });
    expect(a.codeVerifier).toBe(b.codeVerifier);
    expect(a.codeChallenge).toBe(b.codeChallenge);
  });

  test("real RNG produces unique verifiers across calls", async () => {
    const a = await generatePkce();
    const b = await generatePkce();
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
  });
});

describe("generateState", () => {
  test("returns a base64url string", () => {
    const s = generateState({ randomBytesImpl: deterministicRandom });
    expect(s).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  test("real RNG produces unique state values", () => {
    expect(generateState()).not.toBe(generateState());
  });
});
