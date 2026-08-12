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

const rawFormFactor = process.env.LH_FORM_FACTOR;
if (rawFormFactor && rawFormFactor !== "mobile" && rawFormFactor !== "desktop") {
  // Fail loudly — silently coercing a typo (e.g. "Mobile") to desktop
  // would produce results that look like passing mobile runs but were
  // really run with desktop throttling.
  throw new Error(
    `LH_FORM_FACTOR must be "mobile" or "desktop"; got: ${JSON.stringify(rawFormFactor)}`,
  );
}
const isMobile = rawFormFactor === "mobile";
const formFactor = isMobile ? "mobile" : "desktop";

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

const assertions = isMobile ? mobileAssertions : desktopAssertions;

// Lighthouse's *default* config is mobile (Moto-G-class throttling, 4× CPU,
// slow 4G). Setting `preset: "desktop"` switches to desktop emulation with
// no CPU/network throttling. We deliberately omit `formFactor` and
// `throttling` — overriding either piecemeal is the canonical way to land
// in a half-mobile-half-desktop hybrid that doesn't match the baseline.
const collectSettings = {
  ...(isMobile ? {} : { preset: "desktop" }),
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
      // score tables, so with the previous `temporary-public-storage` target
      // the comment rendered its "No reports found" empty state on every run
      // from #2009 (2026-07-22) until #4899. That target uploads the median
      // LHRs to a Google bucket and prints a link, but writes NOTHING to
      // disk, so there was never a manifest to read.
      //
      // Dropping `temporary-public-storage` also takes a network dependency
      // off the critical path: it ran *after* assertions, so a bucket hiccup
      // failed the step and flipped the comment to "Run failed." on a run
      // whose reports were complete. Its public URLs were never surfaced in
      // the comment anyway — the artifact is the documented delivery channel.
      // No LHCI server (operating one is its own follow-up; #2009 defers it).
      target: "filesystem",
      // Deliberately NOT dot-prefixed. `actions/upload-artifact` v4 defaults
      // `include-hidden-files: false` and silently drops every path with a
      // dot-prefixed segment, which is the second, independent half of #4899:
      // the `lighthouse-reports` artifact uploaded nothing because the old
      // `.lighthouseci-desktop/` and `.lighthouseci-mobile/` paths read as
      // hidden. Writing straight to a per-form-factor dir also removes the
      // need for the workflow to `mv` the reports out of `.lighthouseci`
      // between the two runs.
      outputDir: `lighthouse-reports/${formFactor}`,
    },
  },
};
