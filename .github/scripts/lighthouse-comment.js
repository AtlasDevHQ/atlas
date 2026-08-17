"use strict";

/**
 * The Lighthouse PR-comment renderer (#2009, #4899, #5174).
 *
 * ## Why this is a committed file rather than a YAML `script:` block
 *
 * It used to be ~250 lines of JavaScript inside
 * `.github/workflows/lighthouse.yml`, where NO gate in this repo could see it:
 * oxlint does not parse YAML, `bun run type` never reached it,
 * `scripts/test-others.ts` only discovers workspace packages, and there is no
 * `actionlint` step. The only validation was running the workflow — on a PR that
 * happened to touch the filtered paths.
 *
 * That mattered because the thing this file renders is a CLAIM about a run, and
 * #4899 was precisely a false one: for three months and 1200+ runs the comment
 * said *"No reports found"* on runs that had produced nine reports. Fixing it
 * cost two review rounds and six separate false-or-overreaching message claims,
 * FOUR of them introduced by the fix for a previous one. The class-closure that
 * PR claimed was guarded only by review attention, which is the thing that had
 * just failed. `scripts/__tests__/lighthouse-comment.test.sh` is that guard now,
 * and its wording ratchet pins every retired sentence.
 *
 * ## The rule every sentence here obeys
 *
 * ⚠️ **Describe what was OBSERVED; never name a cause the signal cannot
 * establish.** Where a cause is genuinely useful, name it as a candidate and
 * point at the logs. Each `EMPTY_STATE` entry below carries the wording that was
 * retired for breaking that rule, and the ratchet fails if one comes back.
 *
 * ## Shape
 *
 * `buildBody({ fs, path, core, env })` is a pure-ish function of the report tree
 * plus two step outcomes — every dependency is injected, so the fixture drives
 * it against a throwaway tree with a stub `core`. The comment UPSERT stays in
 * the workflow, because that half needs `github` + `context` and is three API
 * calls with no branching worth testing.
 */

/**
 * The report tree's root, and the ONE place it is spelled in JavaScript.
 *
 * ⚠️ `lighthouserc.js`'s `upload.outputDir` is the source of truth, and
 * `scripts/check-lighthouse-report-paths.sh` asserts this agrees with it — by
 * EXECUTING that config rather than grepping it. The path was duplicated six
 * ways when this file was extracted (the rc config, the verify step's `dir=`,
 * the artifact `path:`, two literals in this renderer, and `.gitignore`), and
 * #4899 was born of exactly that shape: a `mv` target that no longer agreed
 * with what lhci wrote.
 */
const REPORT_ROOT = "lighthouse-reports";

/** Where `lhci upload` writes one form factor's reports. */
function reportDir(formFactor) {
  return `${REPORT_ROOT}/${formFactor}`;
}

/**
 * The form factors, in comment order.
 *
 * `key` must match `lighthouserc.js`'s `PROFILES` keys — the report-paths guard
 * derives that list from the config's own validation error rather than from a
 * second hand-written copy, and fails if the two disagree.
 */
const FORM_FACTORS = [
  { key: "desktop", label: "Desktop", outcomeEnv: "DESKTOP_OUTCOME" },
  { key: "mobile", label: "Mobile", outcomeEnv: "MOBILE_OUTCOME" },
];

const COMMENT_MARKER = "<!-- atlas-lighthouse-budget #2009 -->";

/**
 * What the empty state is allowed to say, per step `outcome`.
 *
 * `outcome` is the step's PRE-`continue-on-error` result, so it is `failure`
 * whenever `lhci autorun` exited non-zero even though the job carried on. It is
 * NOT limited to success/failure: a step that never executed reports `skipped`
 * or `''`, and a job torn down mid-flight reports `cancelled`. Nothing before
 * the two Lighthouse steps carries `continue-on-error`, so a build or `Wait for
 * servers` failure lands here — and an earlier draft collapsed every
 * non-`failure` outcome into "No reports found.", i.e. it answered "Lighthouse
 * never ran" with #4899's own sentence.
 *
 * The RETIRED wordings named below are pinned by the ratchet in
 * `scripts/__tests__/lighthouse-comment.test.sh`, so a future edit that reaches
 * for one goes red rather than shipping a comment that asserts what it cannot
 * know.
 */
const EMPTY_STATE = {
  // Says only that the step exited non-zero and no reports were read —
  // deliberately not why.
  failure: "Run failed.",
  // RETIRED: "wrote no manifest.json". A manifest containing `[]`, or one that
  // failed to parse, is also read as zero representative runs. "None were read"
  // is what this branch actually establishes.
  success:
    'No reports found. `lhci autorun` reported success but no representative runs could be read — see the "Verify reports landed" step.',
  // RETIRED: "before reports were written" — `upload` writes `manifest.json`
  // LAST, so a cancellation can land after the per-run reports exist. RETIRED:
  // "superseded" — this workflow has no `concurrency:` block, so a push cannot
  // cancel a run in flight, and naming a cause the configuration makes
  // unreachable is the defect this whole comment is about.
  cancelled:
    "Run cancelled. No representative runs could be read — reports written before it stopped may still be in the artifact.",
  // RETIRED: "because an earlier step failed" — a step that never executed does
  // not say why, and a cancelled job produces this too. Point at the job;
  // assert nothing about it.
  skipped: "Lighthouse did not run — see the earlier steps in this job.",
  "": "Lighthouse did not run — see the earlier steps in this job.",
};

/**
 * Parse the lhci `manifest.json` written into one form-factor dir. Each entry
 * has `{ url, isRepresentativeRun, summary: { performance, accessibility,
 * 'best-practices', seo } }`.
 *
 * Warns rather than returning a bare `[]`. This was the last silent reader in
 * the script, and it is the residual signal for the one drift class the report
 * path still allows: if this renderer's root ever disagrees with
 * `lighthouserc.js`'s `outputDir` while the "Verify reports landed" step's own
 * path does not, that step passes, the artifact uploads, and the comment
 * renders its empty state — with this line as the only trace anywhere that a
 * path was wrong. `check-lighthouse-report-paths.sh` is what makes that
 * unreachable rather than merely annotated.
 */
function readManifest({ fs, path, core }, dir) {
  const manifestPath = path.join(dir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    core.warning(`no manifest at ${manifestPath}; the ${dir} table will render its empty state`);
    return [];
  }
  try {
    const raw = fs.readFileSync(manifestPath, "utf8");
    const parsed = JSON.parse(raw);
    // `Array.isArray` + the `r &&` guard keep this EXACTLY as tolerant as the
    // "Verify reports landed" step's predicate. They used to differ: a manifest
    // like `[null, {…true}]` threw here (caught below → empty state) while that
    // step's `some()` passed it green — the two-readers-disagree divergence that
    // step's comment claims to have closed, one entry shape in.
    if (!Array.isArray(parsed)) {
      core.warning(
        `manifest at ${manifestPath} is not an array; the ${dir} table will render its empty state`,
      );
      return [];
    }
    return parsed.filter((r) => r && r.isRepresentativeRun);
  } catch (err) {
    core.warning(
      `manifest read failed for ${dir}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/**
 * `manifest.json` records ABSOLUTE report paths, baked in by `lhci upload` on
 * the machine that wrote them, so in the workflow they resolve as-is. The
 * basename fallback is defensive: it survives the absolute PREFIX changing
 * under us (a different workspace or checkout path with the same relative
 * layout). It does NOT make this renderer runnable against a downloaded
 * artifact — with a single search path the artifact's root IS the uploaded
 * directory, so an extracted artifact has `desktop/` and `mobile/` at its top
 * level and `readManifest(dir)` would miss the manifest first.
 *
 * Warns rather than returning a bare null: every reader here reports its own
 * failure, and an unannotated null would render `–` in LCP and CLS while
 * Perf/A11y/SEO — which come from the manifest summary, not the file — still
 * looked authoritative. That is #4899 at cell granularity, and #4899 is a bug
 * about a signal that stayed quiet.
 */
function resolveReportPath({ fs, path, core }, dir, recordedPath) {
  if (typeof recordedPath !== "string" || recordedPath === "") {
    core.warning(`manifest entry in ${dir} has no usable jsonPath; LCP/CLS will render as –`);
    return null;
  }
  if (fs.existsSync(recordedPath)) return recordedPath;
  const local = path.join(dir, path.basename(recordedPath));
  if (fs.existsSync(local)) return local;
  core.warning(
    `report file missing for ${dir}: tried ${recordedPath} and ${local}; LCP/CLS will render as –`,
  );
  return null;
}

/**
 * The two audit ids, named once so the id passed to {@link readAuditNumbers}
 * and the id read back out in the row formatter cannot drift apart. A mistyped
 * identifier is then a ReferenceError rather than a cell quietly reading `–`.
 */
const LCP = "largest-contentful-paint";
const CLS = "cumulative-layout-shift";

/**
 * Pull lighthouse-typed numeric audit values (LCP, CLS) from the per-run JSON
 * report alongside the manifest summary. Reads the report ONCE and pulls every
 * requested audit from it; a read-and-parse per metric meant parsing each
 * report twice per row.
 *
 * Every arm warns. An audit present but without a numeric value is the
 * realistic case rather than an exotic one — an LCP audit with
 * `scoreDisplayMode: 'error'` has no `numericValue` — and a bare null there
 * renders `–` beside authoritative-looking scores, which is the same cell-level
 * silence {@link resolveReportPath} was fixed for.
 */
function readAuditNumbers({ fs, core }, jsonReportPath, auditIds) {
  const empty = Object.fromEntries(auditIds.map((id) => [id, null]));
  if (jsonReportPath == null) return empty;
  try {
    const raw = fs.readFileSync(jsonReportPath, "utf8");
    const parsed = JSON.parse(raw);
    return Object.fromEntries(
      auditIds.map((id) => {
        const audit = parsed.audits && parsed.audits[id];
        if (audit && typeof audit.numericValue === "number") return [id, audit.numericValue];
        core.warning(`audit \`${id}\` has no numeric value in ${jsonReportPath}; it will render as –`);
        return [id, null];
      }),
    );
  } catch (err) {
    core.warning(
      `audit read failed for ${jsonReportPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return empty;
  }
}

/**
 * Strip the `http://localhost:NNNN` prefix so the comment shows a path the
 * reader recognizes (`/`, `/pricing`, `/demo`).
 */
function pathOf(u) {
  try {
    return new URL(u).pathname || "/";
  } catch {
    // intentionally ignored: `r.url` is manifest-supplied and lhci always
    // writes `lhr.requestedUrl` there, having itself parsed it with `new
    // URL(...)` before writing the entry — so this arm is unreachable today. If
    // a future writer ever puts something else in that field, rendering it raw
    // beats throwing away the whole comment.
    return u;
  }
}

function fmtScore(s) {
  if (s == null) return "–";
  return Math.round(s * 100).toString();
}

function fmtMs(ms) {
  if (ms == null) return "–";
  return `${Math.round(ms)} ms`;
}

function fmtCls(v) {
  if (v == null) return "–";
  return v.toFixed(2);
}

/**
 * Returns `{ markdown, rowCount }`. The count travels with the text so the
 * footer can ask "did anything render?" without re-deriving it by
 * pattern-matching this function's own markdown — a coupling that silently
 * inverts the moment the table's shape changes.
 */
function tableForFormFactor(deps, label, dir, outcome) {
  const runs = readManifest(deps, dir);
  const failed = outcome === "failure";
  if (runs.length === 0) {
    // `Object.hasOwn`, not `EMPTY_STATE[key] ?? fallback`: `??` only fires on
    // null/undefined, so every inherited `Object.prototype` key
    // (`constructor`, `toString`, `valueOf`) is truthy and would sail past the
    // fallback and render a native function into the comment. Unreachable with
    // GitHub's fixed vocabulary, but the whole point of this lookup is being
    // total.
    const key = outcome ?? "";
    const why = Object.hasOwn(EMPTY_STATE, key)
      ? EMPTY_STATE[key]
      : `Unrecognized step outcome \`${outcome}\`.`;
    return { markdown: `### ${label}\n\n_${why}_ See workflow logs.\n`, rowCount: 0 };
  }
  // Failed-but-populated. Exactly one thing is established — the step exited
  // non-zero — so that is all this says, plus where to look. It deliberately
  // names NO cause: the `assert` phase is the only door to this branch
  // (`collect` and `healthcheck` failures exit before `upload`, so they leave no
  // manifest), and `assert` exits non-zero for config and parse errors as well
  // as for a violated `error`-level budget — which, while every assertion in
  // `lighthouserc.js` is `warn`, cannot reach here at all. Two earlier drafts
  // named a cause anyway and were wrong both times.
  //
  // "The representative runs from the manifest" is also deliberate: the rows are
  // what `readManifest` kept, which is 3 of 9 entries at `numberOfRuns: 3` —
  // not "everything the run wrote".
  const note = failed
    ? `\n> ⚠️ \`lhci autorun\` exited non-zero for ${label.toLowerCase()}. The rows below are the representative runs from the manifest it wrote; see the workflow logs for why the step failed.\n`
    : "";
  const header =
    "| Surface | Perf | A11y | Best Practices | SEO | LCP | CLS |\n" + "|---|---|---|---|---|---|---|";
  const rows = runs.map((r) => {
    const audits = readAuditNumbers(deps, resolveReportPath(deps, dir, r.jsonPath), [LCP, CLS]);
    const s = r.summary || {};
    return `| \`${pathOf(r.url)}\` | ${fmtScore(s.performance)} | ${fmtScore(s.accessibility)} | ${fmtScore(s["best-practices"])} | ${fmtScore(s.seo)} | ${fmtMs(audits[LCP])} | ${fmtCls(audits[CLS])} |`;
  });
  return {
    markdown: `### ${label}\n${note}\n${header}\n${rows.join("\n")}\n`,
    rowCount: rows.length,
  };
}

/**
 * Build the PR comment body from the report tree in the CURRENT WORKING
 * DIRECTORY plus the two step outcomes in `env`.
 *
 * @param {{ fs: typeof import("node:fs"), path: typeof import("node:path"),
 *   core: { warning: (m: string) => void, info: (m: string) => void },
 *   env: Record<string, string | undefined> }} deps
 * @returns {{ body: string, anyTables: boolean, rowCounts: Record<string, number> }}
 */
function buildBody(deps) {
  const tables = FORM_FACTORS.map((ff) => ({
    key: ff.key,
    ...tableForFormFactor(deps, ff.label, reportDir(ff.key), deps.env[ff.outcomeEnv]),
  }));

  // Pointing at the artifact unconditionally would send the reader to a 404 on
  // the runs where they most want the reports. But this establishes only "a
  // table rendered", i.e. a readable manifest — NOT "an artifact exists":
  // `if-no-files-found: warn` uploads whatever is under the report root, so
  // reports written before an interrupted manifest write DO produce an artifact
  // with no table. So the false arm describes the observation and sends the
  // reader looking anyway, rather than asserting no artifact exists.
  //
  // Read from the builders' own `rowCount` rather than pattern-matching their
  // markdown, which would quietly invert the moment a table gains a column or
  // moves inside a `<details>` — printing "no table" beside two tables.
  const anyTables = tables.reduce((sum, t) => sum + t.rowCount, 0) > 0;

  const body = [
    COMMENT_MARKER,
    "## Lighthouse budget",
    "",
    "> Budget defined in `lighthouserc.js`. Baselines under `apps/www/.design/{landing,pricing,demo}/lighthouse-baseline.md`.",
    "",
    // Precise on purpose: budget assertions are warn-only and never fail a PR,
    // but this job CAN go red — a build or server-start failure fails it, and so
    // does a run that delivered no reports at all. `lighthouse` is not a
    // required check either way.
    "> First-month policy: budget assertions are `warn`-only and never fail a PR. This comment is the signal.",
    "",
    ...tables.map((t) => t.markdown),
    "",
    anyTables
      ? `<sub>Full HTML reports are in the \`${REPORT_ROOT}\` artifact on this run · workflow: \`.github/workflows/lighthouse.yml\`</sub>`
      : `<sub>No table could be built. Check the \`Verify reports landed\` step and the run's \`${REPORT_ROOT}\` artifact, if one was produced, for whatever did land · workflow: \`.github/workflows/lighthouse.yml\`</sub>`,
  ].join("\n");

  return {
    body,
    anyTables,
    rowCounts: Object.fromEntries(tables.map((t) => [t.key, t.rowCount])),
  };
}

module.exports = {
  buildBody,
  reportDir,
  COMMENT_MARKER,
  EMPTY_STATE,
  FORM_FACTORS,
  REPORT_ROOT,
};
