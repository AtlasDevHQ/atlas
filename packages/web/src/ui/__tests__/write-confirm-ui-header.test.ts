/**
 * #5495 — drift tripwire for the confirm-before-write surface declaration.
 *
 * The API gates the WRITE half of `executeRestOperation` on the
 * `x-atlas-write-confirm-ui` request header, and it FAILS CLOSED: a surface that
 * does not send it is offered REST reads only. That default is deliberate — it
 * is what fixes the embeddable `@useatlas/react` widget, which has no
 * `rest-write-confirm-card.tsx`, without shipping its published versions
 * anything.
 *
 * The cost of a fail-closed gate is that dropping the header from a web
 * transport does not throw, does not warn, and does not fail a type-check. It
 * silently turns the Atlas web app read-only for REST writes — and the symptom
 * ("Atlas says writes are off") points at the datasource's write allowlist,
 * which is the wrong place entirely. So the literals are pinned here.
 *
 * They are literals, not an import, because the frontend never imports from
 * `@atlas/api` — the same deliberate mirror as `ui/lib/rest-operation-types.ts`.
 * The canonical definition is `WRITE_CONFIRM_UI_HEADER` in
 * `packages/api/src/lib/openapi/rest-write-confirm.ts`.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// Anchored to THIS file, not `process.cwd()` — the suite runs from the repo root
// in CI and from `packages/web` locally.
const WEB_ROOT = resolve(import.meta.dir, "../../..");

const HEADER = "x-atlas-write-confirm-ui";

/** Every `.ts`/`.tsx` file under `dir`, recursively. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = resolve(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(e.name) ? [full] : [];
  });
}

/** Every web surface that renders `ToolPart` → `RestWriteConfirmCard`. */
const SURFACES = [
  "src/ui/hooks/use-atlas-transport.ts",
  "src/ui/components/dashboards/bound-chat-drawer.tsx",
];

describe("web chat surfaces declare the confirm-before-write banner (#5495)", () => {
  for (const rel of SURFACES) {
    it(`${rel} sends ${HEADER}`, () => {
      const src = readFileSync(resolve(WEB_ROOT, rel), "utf8");
      expect(src).toContain(HEADER);
    });
  }

  it("the widget package deliberately does NOT — it has no confirm card to render", () => {
    // If this ever fails, `@useatlas/react` grew the header. That is only correct
    // alongside a real confirm card in its own `tool-part.tsx`; adding the header
    // alone re-opens #5495 for widget users.
    //
    // Walks the whole package rather than naming `hooks/use-atlas-chat.ts`: the
    // widget could set the header from any transport it grows later, and a
    // tripwire that watches one file would pass while the bug came back.
    const offenders = sourceFiles(resolve(WEB_ROOT, "../react/src")).filter((f) =>
      readFileSync(f, "utf8").includes(HEADER),
    );
    expect(offenders).toEqual([]);
  });
});
