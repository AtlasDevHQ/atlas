import { test, expect, spyOn } from "bun:test";
import {
  absolutizeLlmsUrls,
  renderLlmsFullText,
  twinPageSlug,
  twinStaticParams,
  MDX_TWIN_INDEX_SUFFIX,
} from "@/lib/llms-surface";
import type { SectionPage } from "@/lib/source";

/**
 * Section-aware machine surfaces (PRD #4257, slice #4266).
 *
 * The driving invariant: the SaaS-scoped `llms-full.txt` carries ONLY saas +
 * shared content, never self-hosted — so an agent answering a SaaS question is
 * never fed on-prem instructions. `renderLlmsFullText` enforces that on two
 * axes, both asserted here without the bundler:
 *   1. Page selection — it renders exactly the pages it is handed (the SaaS
 *      route hands it `source.getPages()`, which the source-partition test
 *      already proves is self-hosted-free).
 *   2. Within a SHARED page, it resolves `<WhenSelfHosted>` to nothing on the
 *      saas surface — so even a dual-mounted page cannot smuggle its on-prem
 *      branch into the SaaS output.
 *
 * Self-contained: fake `SectionPage`s expose only the `{ url, data.title,
 * data.getText }` slice the surface reads, so no `.source/server` (bundler-only)
 * and no filesystem/network.
 */

// Only the fields renderLlmsFullText / getLLMText read; the cast stands in for
// the rich compiled-MDX page a real section source yields.
function fakePage(url: string, title: string, processed: string): SectionPage {
  return {
    url,
    data: { title, getText: async (_mode: string) => processed },
  } as unknown as SectionPage;
}

const SAAS_TOKEN = "SAAS_ONLY_BRANCH_TOKEN";
const SH_TOKEN = "SELF_HOSTED_ONLY_BRANCH_TOKEN";

// A shared page that mounts into BOTH sections from one file, carrying an
// audience-conditional block per audience — the exact shape that would leak if
// the surface weren't audience-resolved.
const SHARED_PROCESSED = [
  "Shared concept intro.",
  "",
  "<WhenSaaS>",
  `  Cloud note: ${SAAS_TOKEN}.`,
  "</WhenSaaS>",
  "",
  "<WhenSelfHosted>",
  `  On-prem note: ${SH_TOKEN}.`,
  "</WhenSelfHosted>",
  "",
  "Shared outro.",
].join("\n");

test("SaaS surface keeps the saas branch and strips the self-hosted branch of a shared page", async () => {
  const pages = [
    fakePage("/billing", "Billing", "SaaS billing body."),
    fakePage("/reference/config", "Config", SHARED_PROCESSED),
  ];
  const out = await renderLlmsFullText(pages, "saas", "test");

  expect(out).toContain(SAAS_TOKEN);
  // The core guarantee: the self-hosted branch is ABSENT, not hidden.
  expect(out).not.toContain(SH_TOKEN);
  // Non-conditional prose on both sides of the block survives.
  expect(out).toContain("Shared concept intro.");
  expect(out).toContain("Shared outro.");
});

test("self-hosted surface keeps the self-hosted branch and strips the saas branch", async () => {
  const pages = [
    fakePage("/self-hosted/docker", "Docker", `Docker body ${SH_TOKEN}.`),
    fakePage("/self-hosted/reference/config", "Config", SHARED_PROCESSED),
  ];
  const out = await renderLlmsFullText(pages, "self-hosted", "test");

  expect(out).toContain(SH_TOKEN);
  expect(out).not.toContain(SAAS_TOKEN);
});

test("renderLlmsFullText renders EXACTLY the pages it is handed (page-selection fidelity)", async () => {
  // The SaaS route hands it a self-hosted-free page set; prove the renderer adds
  // nothing and drops nothing, so 'only saas+shared in, only saas+shared out'.
  const pages = [
    fakePage("/", "Introduction", "Root body."),
    fakePage("/guides/enterprise-sso", "Enterprise SSO", "SSO body."),
    fakePage("/reference/config", "Config", SHARED_PROCESSED),
  ];
  const out = await renderLlmsFullText(pages, "saas", "test");

  for (const p of pages) expect(out).toContain(`(${p.url})`);
  // No self-hosted URL was synthesized into the SaaS surface.
  expect(out).not.toContain("(/self-hosted");
  // One `---` fence between each of the 3 page bodies.
  expect(out.split("\n\n---\n\n")).toHaveLength(pages.length);
  // Input order is preserved — a coherent llms-full.txt needs the intro before
  // the deeper pages (guards against a race/settle-order concat refactor).
  const iRoot = out.indexOf("(/)");
  const iSso = out.indexOf("(/guides/enterprise-sso)");
  const iCfg = out.indexOf("(/reference/config)");
  expect(iRoot).toBeGreaterThanOrEqual(0);
  expect(iRoot).toBeLessThan(iSso);
  expect(iSso).toBeLessThan(iCfg);
});

test("getLLMText requests the compiled 'processed' text, not the raw JSX-bearing MDX", async () => {
  // "processed" (compiled markdown) is what stripInactiveAudienceBlocks can
  // resolve; a swap to "raw" would ship un-stripped <WhenSaaS> JSX and leak the
  // opposite branch — pin the mode so that regression fails here.
  let seenMode: string | undefined;
  const page = {
    url: "/x",
    data: {
      title: "X",
      getText: async (mode: string) => {
        seenMode = mode;
        return "body";
      },
    },
  } as unknown as SectionPage;
  await renderLlmsFullText([page], "saas", "test");
  expect(seenMode).toBe("processed");
});

test("a page whose getText throws fails soft to a placeholder — siblings still render", async () => {
  const boom = {
    url: "/broken",
    data: {
      title: "Broken",
      getText: async (_mode: string) => {
        throw new Error("kaboom");
      },
    },
  } as unknown as SectionPage;
  const pages = [fakePage("/ok", "OK", "fine body"), boom];
  const errorSpy = spyOn(console, "error").mockImplementation(() => {});
  const out = await renderLlmsFullText(pages, "saas", "test");

  expect(out).toContain("fine body");
  expect(out).toContain("Could not load this page.");
  expect(out).toContain("# Broken (/broken)");
  // The OTHER half of the fail-soft contract (CLAUDE.md: never SILENTLY swallow)
  // — the error must be logged with surface label + page url + message, so a
  // future refactor that drops the log turns THIS red, not a silent shipping of
  // placeholders.
  expect(errorSpy).toHaveBeenCalledTimes(1);
  expect(errorSpy.mock.calls[0][0]).toBe("[test] /broken: kaboom");
  errorSpy.mockRestore();
});

test("absolutizeLlmsUrls rewrites root-relative links to absolute, including /self-hosted", () => {
  const md = "See [Config](/reference/config) and [Docker](/self-hosted/docker).";
  const out = absolutizeLlmsUrls(md);
  expect(out).toContain("(https://docs.useatlas.dev/reference/config)");
  expect(out).toContain("(https://docs.useatlas.dev/self-hosted/docker)");
  // Non-link text is untouched.
  expect(out).toContain("See [Config]");
  // Idempotent on already-absolute links — it keys on `](/`, so `](https://…`
  // is left alone (no double-rewrite). Guards against a broadened `]\(` regex.
  const already = "[Docs](https://docs.useatlas.dev/x)";
  expect(absolutizeLlmsUrls(already)).toBe(already);
  expect(absolutizeLlmsUrls(out)).toBe(out);
});

test("twinPageSlug accepts a well-formed twin slug and strips the index.md suffix", () => {
  expect(twinPageSlug(["docker", MDX_TWIN_INDEX_SUFFIX])).toEqual(["docker"]);
  expect(
    twinPageSlug(["guides", "slack", MDX_TWIN_INDEX_SUFFIX]),
  ).toEqual(["guides", "slack"]);
  // The section landing twin is just the suffix -> empty page slug.
  expect(twinPageSlug([MDX_TWIN_INDEX_SUFFIX])).toEqual([]);
});

test("twinPageSlug rejects a slug not ending in index.md (caller then 404s)", () => {
  expect(twinPageSlug(undefined)).toBeNull();
  expect(twinPageSlug([])).toBeNull();
  expect(twinPageSlug(["docker"])).toBeNull();
  expect(twinPageSlug(["docker", "index.html"])).toBeNull();
});

test("twinStaticParams appends the index.md suffix to every section param", () => {
  const params = twinStaticParams([
    { slug: ["docker"] },
    { slug: [] },
    {}, // a landing page params entry with no slug
  ]);
  expect(params).toEqual([
    { slug: ["docker", MDX_TWIN_INDEX_SUFFIX] },
    { slug: [MDX_TWIN_INDEX_SUFFIX] },
    { slug: [MDX_TWIN_INDEX_SUFFIX] },
  ]);
});
