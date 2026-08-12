// Lighthouse CI config for marketing surfaces (#2009).
//
// Re-run by `.github/workflows/lighthouse.yml` on every PR that touches
// `apps/www/**` or `packages/web/**`. The workflow invokes this twice —
// once with `LH_FORM_FACTOR=desktop` and once with `LH_FORM_FACTOR=mobile`
// — so the same threshold table is the single source of truth for both
// runs. Baselines that seeded these thresholds live next to the surfaces
// at `apps/www/.design/{landing,pricing}/lighthouse-baseline.md` and
// `apps/www/.design/demo/lighthouse-baseline.md` (#1945).
//
// Pass/fail policy: every assertion is `warn` for the first month while
// we calibrate flake on shared CI runners. Promote individual assertions
// to `error` once their PR-comment signal has been stable for ~4 weeks.

// The form factor is normalized here and VALIDATED further down, against the
// keys of the `PROFILES` table that actually selects the behaviour — see the
// note there for why the allowlist is derived from that table rather than
// written out twice.
const rawFormFactor = process.env.LH_FORM_FACTOR;
const DEFAULT_FORM_FACTOR = "desktop";
const formFactor = rawFormFactor || DEFAULT_FORM_FACTOR;

const wwwBase = process.env.LH_WWW_BASE_URL || "http://localhost:8080";
const webBase = process.env.LH_WEB_BASE_URL || "http://localhost:3000";

// Surfaces. `/demo` lives in `packages/web` (chat app); `/` and `/pricing`
// live in `apps/www` (static export). Active-state `/demo` (post-gate, with
// a seeded sessionStorage bearer) is deferred — it requires the API + DB
// stack at audit time, which is its own follow-up.
const urls = [
  `${wwwBase}/`,
  `${wwwBase}/pricing`,
  `${webBase}/demo`,
];

// Score thresholds were seeded from #1945 (`/demo`) and the day-1 baselines
// for `/` and `/pricing`. Scores sit close to the WSL2 measurements; LCP
// ceilings are deliberately *generous* (≈2× the seed) because CI runners
// measure noisier than a dev box and we want this in `warn`-only mode to
// surface real regressions, not benign per-runner variance.
const desktopAssertions = {
  "categories:performance": ["warn", { minScore: 0.95 }],
  "categories:accessibility": ["warn", { minScore: 1.0 }],
  "categories:best-practices": ["warn", { minScore: 1.0 }],
  "categories:seo": ["warn", { minScore: 1.0 }],
  "largest-contentful-paint": ["warn", { maxNumericValue: 1500 }],
  "cumulative-layout-shift": ["warn", { maxNumericValue: 0.1 }],
};

const mobileAssertions = {
  "categories:performance": ["warn", { minScore: 0.85 }],
  "categories:accessibility": ["warn", { minScore: 1.0 }],
  "categories:best-practices": ["warn", { minScore: 1.0 }],
  "categories:seo": ["warn", { minScore: 1.0 }],
  // Mobile LCP measured at ~3.9–4.1 s on the seed runs; threshold sits a
  // hair above so the day-1 numbers don't immediately flag.
  "largest-contentful-paint": ["warn", { maxNumericValue: 4500 }],
  "cumulative-layout-shift": ["warn", { maxNumericValue: 0.1 }],
};

// Every per-form-factor decision hangs off ONE table, so the allowlist and the
// behaviour it selects cannot drift apart.
//
// This replaced the two independent `isMobile ? … : …` ternaries — the assertion
// thresholds and the collect preset — and folded in the output directory, which
// was already keyed off the validated string. That last part was the trap:
// normalising `formFactor` fixed only the directory, so a third form factor
// added to the allowlist would still get `isMobile === false`, hence DESKTOP
// throttling and DESKTOP's 0.95/1500 ms thresholds, in a directory of its own.
// Reports that look like a passing new form factor but were measured as desktop
// is the exact failure the throw below exists to prevent, so it must not be
// reachable one derivation later.
const PROFILES = {
  desktop: {
    assertions: desktopAssertions,
    // Lighthouse's *default* config is mobile (Moto-G-class throttling, 4× CPU,
    // slow 4G). `preset: "desktop"` switches to desktop emulation with no
    // CPU/network throttling. We deliberately omit `formFactor` and
    // `throttling` — overriding either piecemeal is the canonical way to land
    // in a half-mobile-half-desktop hybrid that doesn't match the baseline.
    collect: { preset: "desktop" },
  },
  mobile: {
    assertions: mobileAssertions,
    // Nothing to set: mobile IS Lighthouse's default.
    collect: {},
  },
};

// Validate against the table that selects the behaviour, not a hand-written
// list beside it. `Object.hasOwn` rather than `in` or a truthiness check so an
// inherited key (`constructor`, `toString`) cannot resolve to a bogus profile.
//
// Fail loudly — silently coercing a typo (e.g. "Mobile") to desktop would
// produce results that look like passing mobile runs but were really measured
// with desktop throttling.
if (!Object.hasOwn(PROFILES, formFactor)) {
  throw new Error(
    `LH_FORM_FACTOR must be one of ${Object.keys(PROFILES).join(", ")}; got: ${JSON.stringify(rawFormFactor)}`,
  );
}
const profile = PROFILES[formFactor];
const assertions = profile.assertions;

const collectSettings = {
  ...profile.collect,
  // Headless Chrome flags that match what the #1945 baselines were
  // captured under — keep these in sync if the baselines are ever
  // recaptured against different flags.
  chromeFlags: "--no-sandbox --disable-dev-shm-usage --disable-gpu",
  // `is-on-https` is permanently noisy here: the workflow audits
  // `http://localhost:{8080,3000}` because we build + serve in-runner.
  // Re-evaluate only if the workflow ever points at HTTPS URLs.
  skipAudits: ["is-on-https"],
};

module.exports = {
  ci: {
    collect: {
      url: urls,
      // 3 runs per URL — lhci picks the median run as the representative
      // result, which smooths over the worst of the CI-runner noise
      // without making the workflow slow.
      numberOfRuns: 3,
      settings: collectSettings,
    },
    assert: {
      // Warn-only first month. Workflow consumes the lhci JSON output and
      // posts a per-surface PR comment; nothing here fails the CI gate.
      assertMatrix: [
        {
          matchingUrlPattern: ".*",
          assertions,
        },
      ],
    },
    upload: {
      // `filesystem` is the ONLY target that writes `manifest.json` — see
      // `runFilesystemTarget` in @lhci/cli's `src/upload/upload.js`, which is
      // the sole `writeFileSync(manifestPath, ...)` call site in the package.
      // The workflow's PR-comment step reads exactly that file to build the
      // score tables, so with the previous `temporary-public-storage` target no
      // table ever rendered — on any run, since the workflow landed (#2009,
      // 2026-05-02) until #4899: roughly three months and 1200+ runs. (The
      // wording the reader saw depended on the step outcome; "No reports found"
      // whenever both steps exited 0.) That target uploads the median LHRs to a
      // Google bucket and prints a link, but writes NOTHING to disk, so there
      // was never a manifest to read.
      //
      // Dropping `temporary-public-storage` also takes a network dependency on
      // a Google bucket off the run, and its public URLs were never surfaced in
      // the comment anyway — the artifact is the documented delivery channel.
      // (An earlier draft of this comment also claimed a bucket failure had
      // been flipping the comment to "Run failed."; that was wrong twice over
      // and is recorded here so it does not get re-derived. `autorun` exits 0
      // on an upload failure unless `--failOnUploadFailure` is passed, which is
      // why the workflow now passes it — and under this target no manifest
      // existed on ANY run, so the comment's empty state was unconditional.)
      // No LHCI server (operating one is its own follow-up; #2009 defers it).
      target: "filesystem",
      // Deliberately NOT dot-prefixed. The pinned `actions/upload-artifact`
      // (v4.6.2) defaults `include-hidden-files: false`, which makes
      // `@actions/glob` skip any entry at or below the uploaded path whose own
      // name starts with `.` — including that path itself. That is the second,
      // independent half of #4899: the `lighthouse-reports` artifact uploaded
      // nothing because the old `.lighthouseci-desktop/` and
      // `.lighthouseci-mobile/` paths matched zero files. (A dot-prefixed
      // ancestor ABOVE the uploaded path is not examined, so only the leading
      // segment of what we pass matters.) Writing straight to a per-form-factor
      // dir also removes the need for the workflow to `mv` the reports out of
      // `.lighthouseci` between the two runs.
      outputDir: `lighthouse-reports/${formFactor}`,
    },
  },
};
