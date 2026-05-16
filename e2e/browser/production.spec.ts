import { test, expect } from "@playwright/test";

// These tests run against production URLs without auth.
// They verify pages load and services are healthy — not functionality.

const PROD_APP_URL = process.env.PROD_APP_URL ?? "https://app.useatlas.dev";
const PROD_API_URL = process.env.PROD_API_URL ?? "https://api.useatlas.dev";
const PROD_API_EU_URL = process.env.PROD_API_EU_URL ?? "https://api-eu.useatlas.dev";
const PROD_API_APAC_URL = process.env.PROD_API_APAC_URL ?? "https://api-apac.useatlas.dev";
const PROD_WWW_URL = process.env.PROD_WWW_URL ?? "https://www.useatlas.dev";
const PROD_DOCS_URL = process.env.PROD_DOCS_URL ?? "https://docs.useatlas.dev";

test.describe("Production Smoke Tests", () => {
  test("landing page loads", async ({ page }) => {
    const response = await page.goto(PROD_WWW_URL);
    expect(response).not.toBeNull();
    expect(response!.status()).toBeLessThan(400);

    await expect(page.getByRole("navigation").getByText("atlas").first()).toBeVisible({ timeout: 10_000 });
  });

  test("docs site loads", async ({ page }) => {
    const response = await page.goto(PROD_DOCS_URL, { timeout: 15_000 }).catch(() => null);
    if (!response || response.status() >= 400) {
      test.skip(true, "Docs site unreachable — skipping in local dev");
      return;
    }

    // Fumadocs renders a sidebar nav or header nav
    await expect(
      page.locator("nav").first().or(page.locator("aside").first()),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("app shows login page", async ({ page }) => {
    const response = await page.goto(PROD_APP_URL);
    expect(response).not.toBeNull();
    expect(response!.status()).toBeLessThan(400);

    await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 10_000 });
  });

  test("app shows signup page", async ({ page }) => {
    const response = await page.goto(`${PROD_APP_URL}/signup`);
    expect(response).not.toBeNull();
    expect(response!.status()).toBeLessThan(400);

    await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: /create account/i })).toBeVisible();
  });

  test("app shell sets no-cache so deploys invalidate the bundle (#2488)", async ({ page }) => {
    // Regression guard for #2488: without `no-cache, must-revalidate` on the
    // entry HTML, tabs open across a Railway deploy still reference the old
    // bundle's hashed chunks (which no longer exist) and sign-in breaks until
    // a hard refresh. Asserts the runtime contract that the canonical
    // `headers()` policy in packages/web/next.config.ts is meant to enforce.
    const response = await page.goto(PROD_APP_URL);
    expect(response).not.toBeNull();
    const cacheControl = response!.headers()["cache-control"] ?? "";
    expect(cacheControl).toMatch(/no-cache/);
    expect(cacheControl).toMatch(/must-revalidate/);
  });

  test("hashed assets stay immutable (#2488)", async ({ request }) => {
    // Companion to the no-cache assertion above: hashed chunks under
    // /_next/static must remain long-cacheable. If a future config change
    // accidentally widens the no-cache rule to cover them, page loads
    // would balloon in download cost without any user-visible failure.
    const shell = await request.get(PROD_APP_URL);
    const html = await shell.text();
    const match = html.match(/\/_next\/static\/[^"']+\.(?:js|css)/);
    test.skip(!match, "no hashed asset reference found in shell");
    const asset = await request.get(`${PROD_APP_URL}${match![0]}`);
    expect(asset.headers()["cache-control"] ?? "").toMatch(/immutable/);
  });

  test("API health endpoint returns ok", async ({ request }) => {
    const response = await request.get(`${PROD_API_URL}/api/health`);
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body.status).toBe("ok");
    expect(body.checks).toBeDefined();
    expect(body.checks.auth.enabled).toBe(true);
    expect(body.components).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Regional health — verify each API region is reachable and identifies itself
// ---------------------------------------------------------------------------

test.describe("Regional Health", () => {
  const regions = [
    { name: "EU", url: PROD_API_EU_URL, expectedRegion: "eu-west" },
    { name: "APAC", url: PROD_API_APAC_URL, expectedRegion: "apac-southeast" },
  ];

  for (const { name, url, expectedRegion } of regions) {
    test(`${name} region health endpoint returns ok with region`, async ({ request }) => {
      const response = await request.get(`${url}/api/health`).catch(() => null);
      if (!response || response.status() >= 500) {
        test.skip(true, `${name} region unreachable — skipping`);
        return;
      }
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body.status).toBe("ok");
      expect(body.region).toBe(expectedRegion);
      expect(body.checks).toBeDefined();
      expect(body.checks.auth.enabled).toBe(true);
      expect(body.components).toBeDefined();
    });
  }

  test("all regions have consistent health response structure", async ({ request }) => {
    const urls = [PROD_API_URL, PROD_API_EU_URL, PROD_API_APAC_URL];
    const responses = await Promise.all(
      urls.map(async (url) => {
        const res = await request.get(`${url}/api/health`).catch(() => null);
        if (!res || res.status() >= 500) return null;
        return res.json();
      }),
    );

    const reachable = responses.filter((r): r is Record<string, unknown> => r !== null);
    if (reachable.length < 2) {
      test.skip(true, "Fewer than 2 regions reachable — skipping consistency check");
      return;
    }

    // All reachable regions should share the same top-level keys
    // (excluding per-instance fields: region, misroutedRequests, warnings, brandColor)
    const keySet = reachable.map((r) => Object.keys(r).filter((k) => k !== "region" && k !== "misroutedRequests" && k !== "warnings" && k !== "brandColor").sort().join(","));
    const first = keySet[0];
    for (const keys of keySet.slice(1)) {
      expect(keys).toBe(first);
    }
  });
});
