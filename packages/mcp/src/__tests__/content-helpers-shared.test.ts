/**
 * Structural guard (#3609): the MCP success-content helpers `toJsonContent`
 * and `toStructuredContent` live in ONE shared module (`error-envelope.ts`),
 * the same place the failure shape (`toEnvelopeResult`) is defined — so a
 * change to the success envelope lands once.
 *
 * Before #3609 these helpers were copy-pasted into `datasource-tools.ts` and
 * `semantic-tools.ts`. This encodes the "the copies are gone" acceptance
 * criterion as a test: the tool files must IMPORT the helpers from
 * `error-envelope.js` and define no local copy, so the class of regression
 * ("someone re-inlines the helper") can't slip past CI.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve(import.meta.dir, "..");

function read(rel: string): string {
  return readFileSync(resolve(SRC, rel), "utf8");
}

describe("success-content helpers are shared, not copy-pasted (#3609)", () => {
  test("error-envelope.ts is the single home of toJsonContent + toStructuredContent", () => {
    const envelope = read("error-envelope.ts");
    expect(envelope).toContain("export function toJsonContent");
    expect(envelope).toContain("export function toStructuredContent");
  });

  test("datasource-tools.ts imports toJsonContent and keeps no local copy", () => {
    const source = read("datasource-tools.ts");
    // Imports the shared helper from the envelope module…
    expect(source).toMatch(/import\s+\{[^}]*\btoJsonContent\b[^}]*\}\s+from\s+"\.\/error-envelope\.js"/s);
    // …and no longer defines its own.
    expect(source).not.toContain("function toJsonContent");
  });

  test("semantic-tools.ts imports both helpers and keeps no local copies", () => {
    const source = read("semantic-tools.ts");
    expect(source).toMatch(
      /import\s+\{[^}]*\btoJsonContent\b[^}]*\btoStructuredContent\b[^}]*\}\s+from\s+"\.\/error-envelope\.js"/s,
    );
    expect(source).not.toContain("function toJsonContent");
    expect(source).not.toContain("function toStructuredContent");
  });
});
