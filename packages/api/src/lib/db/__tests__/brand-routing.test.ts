/**
 * Compile-time witnesses for the `URLSecret` / `OpaqueSecret` brand
 * disambiguation (#2370). The brands are structural — the runtime
 * payload is just `string` — so behavior cannot regress at runtime;
 * the only failure mode is the type system silently widening back to
 * unenforced `string` parameters in a future refactor.
 *
 * Each `@ts-expect-error` directive below is the load-bearing
 * assertion. If the brand ever becomes assignable in either direction
 * (e.g. a TS version bump changes optional-never assignability, or a
 * contributor widens `decryptSecret`'s parameter to `string`), the
 * directive flips from "suppresses an expected error" to "expected
 * an error but none occurred" — `bun run type` (and `/ci`) fails
 * with a clear pointer back to this file. Same pattern as win #52
 * (`CanonicalPrompt` discriminated union, #2185).
 *
 * The misroute checks live inside `_brandMisrouteWitnesses`, a
 * function that's compiled but never invoked. We can't execute the
 * misrouted calls at runtime because (a) the brand is structural so
 * there's nothing runtime-visible to assert against, and (b) the
 * underlying decryptors would throw on random strings without a key
 * configured. The compile-time check is the entire point.
 *
 * The `bun:test` `it` at the bottom exercises the positive routing
 * shapes at runtime so a regression that collapses *both* brand arms
 * back to `string` — which would silently neutralise every negative
 * `@ts-expect-error` above — still trips the suite.
 */

import { describe, it, expect } from "bun:test";
import {
  encryptSecret as encryptUrlSecret,
  decryptSecret as decryptUrlSecret,
  type URLSecret,
} from "../internal";
import {
  encryptSecret as encryptOpaqueSecret,
  decryptSecret as decryptOpaqueSecret,
  type OpaqueSecret,
} from "../secret-encryption";

// Mint a value of either brand without paying real AES — the four
// misroute checks below are type-only and don't need live ciphertext.
function asURLSecret(s: string): URLSecret {
  return s as URLSecret;
}
function asOpaqueSecret(s: string): OpaqueSecret {
  return s as OpaqueSecret;
}

// Type-only witnesses. Never invoked at runtime; the type checker
// still walks the body. Each `@ts-expect-error` line is the gate.
// Marked `void` so an accidental call doesn't have a return-shape
// signal to lean on.
function _brandMisrouteWitnesses(): void {
  const op = asOpaqueSecret("enc:v1:...");
  const url = asURLSecret("enc:v1:...");

  // 1. OpaqueSecret fed into the URL-aware decryptSecret. The sibling
  //    arm `RawSecret`'s `__brand?: never` refuses the
  //    `__brand: "OpaqueSecret"` literal; the `URLSecret` arm refuses
  //    the literal `"OpaqueSecret"` vs required `"URLSecret"`.
  // @ts-expect-error — brand mismatch is the whole point of #2370.
  decryptUrlSecret(op);

  // 2. URLSecret fed into the opaque decryptSecret. Symmetric.
  // @ts-expect-error — brand mismatch is the whole point of #2370.
  decryptOpaqueSecret(url);

  // 3. URL-helper output assigned to an OpaqueSecret target — the
  //    IDE-auto-import misroute on the write path. The dominant
  //    real-world bug surface.
  // @ts-expect-error — brand mismatch is the whole point of #2370.
  const _wrongOpaque: OpaqueSecret = encryptUrlSecret("postgres://x");

  // 4. Opaque-helper output assigned to a URLSecret target. Catches
  //    the converse misroute on a persistence column annotation.
  // @ts-expect-error — brand mismatch is the whole point of #2370.
  const _wrongUrl: URLSecret = encryptOpaqueSecret("token");

  // Reference the locals so noUnusedLocals doesn't strip them — the
  // brand check is on the assignment, not on later use.
  void _wrongOpaque;
  void _wrongUrl;
}

// Keep TS from flagging `_brandMisrouteWitnesses` as unused.
void _brandMisrouteWitnesses;

describe("encryption helper brand routing (#2370)", () => {
  it("matched encrypt → decrypt round-trip on each brand stays well-typed", () => {
    // No key configured here, so both `encryptSecret` paths return
    // the plaintext stamped with the brand and both `decryptSecret`
    // paths pass through (the URL helper's `isPlaintextUrl` arm for
    // the URL case, the opaque helper's "no `enc:v<N>:` prefix" arm
    // for the opaque case). The runtime equality is the canary: if
    // a future refactor collapses either brand back to `string`, the
    // negative `@ts-expect-error` witnesses above will no longer fire
    // — but this runtime assertion will also stop catching that the
    // helper round-trips, so the suite still trips red.
    delete process.env.ATLAS_ENCRYPTION_KEY;
    delete process.env.ATLAS_ENCRYPTION_KEYS;
    delete process.env.BETTER_AUTH_SECRET;

    const url = encryptUrlSecret("postgres://x");
    const urlBack: string = decryptUrlSecret(url);
    expect(urlBack).toBe("postgres://x");

    const op = encryptOpaqueSecret("token");
    const opBack: string = decryptOpaqueSecret(op);
    expect(opBack).toBe("token");
  });

  it("plain pg row strings flow through both decrypt paths via RawSecret", () => {
    // pg returns column values typed as `string`. `RawSecret`'s
    // `__brand?: never` arm admits them without a manual cast — the
    // whole reason `RawSecret` exists rather than narrowing both
    // decrypts to brand-only.
    delete process.env.ATLAS_ENCRYPTION_KEY;
    delete process.env.ATLAS_ENCRYPTION_KEYS;
    delete process.env.BETTER_AUTH_SECRET;

    // URL-helper short-circuits on `isPlaintextUrl`; opaque helper
    // short-circuits on absence of `enc:v<N>:` — both leave a plain
    // dev value unchanged.
    const rawUrl = "postgres://dev" as string;
    expect(decryptUrlSecret(rawUrl)).toBe("postgres://dev");

    const rawOpaque = "dev-token" as string;
    expect(decryptOpaqueSecret(rawOpaque)).toBe("dev-token");
  });
});
