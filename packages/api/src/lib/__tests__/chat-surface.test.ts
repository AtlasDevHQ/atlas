/**
 * The surface header is MIRRORED across two packages (#5496), so it gets a
 * drift guard.
 *
 * `packages/api/src/lib/chat-surface.ts` and
 * `packages/web/src/ui/lib/correct-fact-types.ts` each declare the header name
 * and the workspace surface value. They are copies rather than one import
 * because `@useatlas/types` is published and the scaffold smoke test builds the
 * template against npm — a new VALUE export there fails Scaffold CI at build
 * time until a release is cut (which is exactly how this pair started life, and
 * why it now lives in two places).
 *
 * A copy is only acceptable with something that fails when the copies diverge.
 * Divergence here is silent and total: the web app would send a header the
 * server does not recognize, the server would resolve the widget's registry, and
 * `correct_fact` would simply stop being offered in web chat — no error, no log,
 * just a capability quietly gone. Nothing else in the suite would notice, because
 * every test that exercises the header imports the SERVER's constant and would
 * agree with itself.
 *
 * So this reads the web file as TEXT. Importing it would defeat the point twice
 * over: `@atlas/api` must not depend on `@atlas/web`, and a shared import is the
 * very thing that is unavailable here.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ATLAS_SURFACE_HEADER, ATLAS_WORKSPACE_SURFACE, rendersConfirmations } from "../chat-surface";

const WEB_MIRROR = join(
  import.meta.dir,
  "..", "..", "..", "..",
  "web", "src", "ui", "lib", "correct-fact-types.ts",
);

/** Read `export const <name> = "<value>";` out of the web mirror. */
function webConstant(name: string): string {
  const source = readFileSync(WEB_MIRROR, "utf8");
  const match = new RegExp(`export const ${name} = "([^"]*)"`).exec(source);
  if (!match?.[1]) {
    throw new Error(
      `${WEB_MIRROR} no longer declares \`export const ${name} = "…"\`. Either the web mirror was ` +
        "renamed or removed — re-point this guard, or it passes vacuously while the two halves drift.",
    );
  }
  return match[1];
}

describe("the chat surface header is mirrored, not shared — so it is pinned", () => {
  it("the web app sends the header name this server reads", () => {
    expect(
      webConstant("ATLAS_SURFACE_HEADER"),
      "packages/web's ATLAS_SURFACE_HEADER no longer equals the server's. The web app would send a " +
        "header the server ignores, the server would resolve the widget's registry, and correct_fact " +
        "would silently stop being offered in web chat — no error anywhere.",
    ).toBe(ATLAS_SURFACE_HEADER);
  });

  it("the web app claims the surface value this server recognizes", () => {
    expect(
      webConstant("ATLAS_WORKSPACE_SURFACE"),
      "packages/web's ATLAS_WORKSPACE_SURFACE no longer equals the server's — same silent failure as above.",
    ).toBe(ATLAS_WORKSPACE_SURFACE);
  });
});

describe("rendersConfirmations fails closed", () => {
  it("accepts only the exact workspace-surface value", () => {
    expect(rendersConfirmations(ATLAS_WORKSPACE_SURFACE)).toBe(true);
  });

  // Absence is the widget, an SDK caller, and anything bespoke. Every one of
  // them must land on `false`, because the alternative is offering a write verb
  // whose confirmation the caller cannot render.
  for (const value of [null, undefined, "", "Workspace", "workspace ", "widget", "true"]) {
    it(`refuses ${JSON.stringify(value)}`, () => {
      expect(rendersConfirmations(value)).toBe(false);
    });
  }
});
