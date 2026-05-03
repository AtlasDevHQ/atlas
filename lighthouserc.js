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

const formFactor = process.env.LH_FORM_FACTOR === "mobile" ? "mobile" : "desktop";

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

const isMobile = formFactor === "mobile";

// Thresholds seeded from #1945 (`/demo`) and the day-1 baselines for `/`
// and `/pricing`. Set a hair below the WSL2 measurements because CI
// runners are noisier — a CI-side recalibration pass after the workflow
// has run on a few PRs is expected.
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
  // Mobile LCP measured at ~3.9–4.1 s on the seed runs; threshold is set
  // at 4500 ms so the day-1 numbers don't immediately flag.
  "largest-contentful-paint": ["warn", { maxNumericValue: 4500 }],
  "cumulative-layout-shift": ["warn", { maxNumericValue: 0.1 }],
};

const assertions = isMobile ? mobileAssertions : desktopAssertions;

module.exports = {
  ci: {
    collect: {
      url: urls,
      // 3 runs per URL — Lighthouse reports the median, which smooths over
      // the worst of the CI-runner noise without making the workflow slow.
      numberOfRuns: 3,
      settings: {
        preset: isMobile ? undefined : "desktop",
        // Lighthouse's mobile preset is the default; explicitly null it so
        // `preset: undefined` doesn't surface as desktop.
        formFactor,
        // Headless Chrome flags that match what `apps/www/.design/demo/`
        // baselines were captured under — keep these in sync if the
        // baselines are ever recaptured against different flags.
        chromeFlags: "--no-sandbox --disable-dev-shm-usage --disable-gpu",
        // The demo page reads sessionStorage on mount; without this it
        // would race with Lighthouse's first paint and produce a flake.
        // For the cold-state audit the gate just renders synchronously,
        // so no special handling is needed beyond the standard preset.
        skipAudits: [
          // `is-on-https` always fails on http://localhost; re-enable
          // when the workflow points at HTTPS preview URLs.
          "is-on-https",
        ],
      },
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
      // Ephemeral by design — full reports land in the workflow artifact
      // and as a temporary public-storage URL on the PR comment. No LHCI
      // server (operating one is its own follow-up; #2009 explicitly
      // defers it).
      target: "temporary-public-storage",
    },
  },
};
