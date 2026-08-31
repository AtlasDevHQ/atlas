/**
 * The extraction only holds if the copies do not grow back.
 *
 * ADR-0045 deferred `lib/vendor-http` on the grounds that the duplication,
 * while real, had not yet produced a cross-connector bug. It then did: three
 * verbatim `isAbortError` copies and a fourth sibling with no timeout at all.
 * A spine that is merely *available* re-accumulates exactly that — so this
 * suite reads the action clients off disk and fails if a second home appears.
 *
 * ⚠️ Scoped to `lib/tools/actions/` on purpose. The vendor connectors adopt
 * the spine opportunistically when next touched (#5569), so widening this
 * glob would turn a deliberate non-migration into a red suite. When a
 * directory has adopted, widen it in the same commit — not before.
 *
 * The connectors are `lib/knowledge/{confluence,freshdesk,front,gitbook,
 * helpscout,intercom,notion,salesforce,support,zendesk}` — the ten ADR-0045
 * enumerates — plus `lib/brain/ingest/{outlook,slack,zoom}`. Both live under
 * `lib/`, and neither is this glob.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ACTIONS_DIR = join(import.meta.dir, "..", "..", "tools", "actions");

/**
 * Strip comments, so these cases scan CODE and not prose.
 *
 * The distinction is load-bearing here: every one of these modules should go
 * on explaining `assertBaseUrlAllowed`, the 200-char bound and the abort
 * duck-typing in its header — that reasoning is why the spine is legible from
 * the call site. What must not come back is a second implementation.
 *
 * Block comments go wholesale; line comments only when `//` opens the line,
 * which never misfires on the `https://` inside a string literal. A trailing
 * `// …` after code survives the strip, which is a false positive this suite
 * would rather have than a false negative.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

/** The two halves of the hand-rolled-deadline shape. See the case below. */
const DEADLINE_CONTROLLER = /new AbortController\(\)/;
const DEADLINE_TIMER = /setTimeout\([^;]*\.abort\b/;

function handRolledDeadlines(): string[] {
  return actionClientSources()
    .filter(
      ({ source }) => DEADLINE_CONTROLLER.test(source) && DEADLINE_TIMER.test(source),
    )
    .map(({ file }) => file);
}

function actionClientSources(): Array<{ file: string; source: string }> {
  return readdirSync(ACTIONS_DIR)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((file) => ({
      file,
      source: stripComments(readFileSync(join(ACTIONS_DIR, file), "utf8")),
    }));
}

describe("lib/tools/actions has no second home for a spine concern", () => {
  it("⭐ defines isAbortError nowhere outside the spine", () => {
    // Acceptance criterion of #5569, and the finding that fired ADR-0045's
    // deferral trigger: three marked copies of this one function.
    //
    // Both a `function` declaration and a `const … =` binding, because the
    // three deleted copies were declarations and the cheapest way to
    // reintroduce one is the other form.
    const offenders = actionClientSources()
      .filter(({ source }) =>
        /(function\s+isAbortError\b|\b(?:const|let|var)\s+isAbortError\b)/.test(source),
      )
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("does not re-roll the 200-character truncation", () => {
    // `truncateFailureDetail` is the one definition, and the one place that
    // states what the bound is for. A literal here is a second, unexplained
    // one — and historically the number drifted between sites.
    const offenders = actionClientSources()
      .filter(({ source }) => /\.slice\(\s*0\s*,\s*200\s*\)/.test(source))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("does not hand-roll a deadline around a vendor fetch", () => {
    // `new AbortController()` paired with a `setTimeout(… .abort() …)` is the
    // shape `withVendorDeadline` owns. A client needing a different SCOPE
    // passes a different callback; it does not need its own controller.
    //
    // ⚠️ `[^;]` and not `[^)]`: the shape being banned is
    // `setTimeout(() => abort.abort(), MS)`, and a `[^)]*` class stops at the
    // `)` closing the arrow's empty parameter list — so the obvious-looking
    // regex matches none of the three copies this PR deleted and the case is
    // a no-op. `pins-the-banned-shape` below is what keeps it honest.
    expect(handRolledDeadlines()).toEqual([]);
  });

  it("⭐ the deadline case actually matches the shape it bans", () => {
    // Guards the guard, against the specific way this one failed review: a
    // regex that reads correctly, passes green, and matches nothing. The
    // fixture is byte-identical to what `jira.ts` carried on origin/main.
    const banned = [
      "  const abort = new AbortController();",
      "  const deadline = setTimeout(() => abort.abort(), JIRA_TIMEOUT_MS);",
    ].join("\n");
    expect(DEADLINE_CONTROLLER.test(banned) && DEADLINE_TIMER.test(banned)).toBe(true);
  });

  it("reaches the egress guard through the spine, not around it", () => {
    // `hostForLog` stays a direct import — it is a logging helper the clients
    // use on URLs the spine never sees. `assertBaseUrlAllowed` is the guard
    // call `pinVendorHost` owns, and a direct one is a second derivation of
    // the check that was missing from Jira for two releases.
    const offenders = actionClientSources()
      .filter(({ source }) => /\bassertBaseUrlAllowed\b/.test(source))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("reads a non-empty set of action clients, so a passing run means something", () => {
    // Guards the guard: a bad path would make every case above vacuously
    // green.
    const files = actionClientSources().map(({ file }) => file);
    expect(files).toContain("jira.ts");
    expect(files).toContain("github.ts");
    expect(files).toContain("linear.ts");
    expect(files).toContain("salesforce.ts");
  });
});
