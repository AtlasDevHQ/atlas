import { describe, expect, test } from "bun:test";

import { decodeJwtPayload, enforceIssuer } from "../src/jwt";
import { OAuthHelperError } from "../src/errors";
import { makeJwt } from "./_helpers";

describe("decodeJwtPayload", () => {
  test("returns the parsed payload of a 3-part JWT", () => {
    const jwt = makeJwt({ iss: "atlas", sub: "u-1", x: 42 });
    const payload = decodeJwtPayload(jwt);
    expect(payload).toEqual({ iss: "atlas", sub: "u-1", x: 42 });
  });

  test("non-JWT (wrong segment count) → malformed_jwt", () => {
    try {
      decodeJwtPayload("a.b");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthHelperError);
      expect((err as OAuthHelperError).code).toBe("malformed_jwt");
    }
  });

  test("non-base64 middle segment → malformed_jwt", () => {
    try {
      decodeJwtPayload("a.!!!.c");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthHelperError);
      expect((err as OAuthHelperError).code).toBe("malformed_jwt");
    }
  });

  test("non-JSON payload bytes → malformed_jwt", () => {
    const enc = (s: string) =>
      Buffer.from(s)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    const jwt = `${enc('{"alg":"none"}')}.${enc("not-json-bytes")}.sig`;
    try {
      decodeJwtPayload(jwt);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthHelperError);
      expect((err as OAuthHelperError).code).toBe("malformed_jwt");
    }
  });
});

describe("enforceIssuer", () => {
  test("matches → no throw", () => {
    expect(() =>
      enforceIssuer({ iss: "https://api.useatlas.dev/api/auth" }, "https://api.useatlas.dev/api/auth"),
    ).not.toThrow();
  });

  test("missing iss → issuer_mismatch", () => {
    try {
      enforceIssuer({}, "https://api.useatlas.dev/api/auth");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthHelperError);
      expect((err as OAuthHelperError).code).toBe("issuer_mismatch");
    }
  });

  test("non-string iss → issuer_mismatch", () => {
    try {
      enforceIssuer({ iss: 42 }, "https://api.useatlas.dev/api/auth");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthHelperError);
      expect((err as OAuthHelperError).code).toBe("issuer_mismatch");
    }
  });

  test("wrong iss → issuer_mismatch with both values in the message", () => {
    try {
      enforceIssuer(
        { iss: "https://impostor.example.com" },
        "https://api.useatlas.dev/api/auth",
      );
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthHelperError);
      expect((err as OAuthHelperError).code).toBe("issuer_mismatch");
      expect((err as OAuthHelperError).message).toContain("impostor");
      expect((err as OAuthHelperError).message).toContain("api.useatlas.dev");
    }
  });
});
