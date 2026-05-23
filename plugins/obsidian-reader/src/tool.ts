/**
 * Obsidian vault reader tool — read-only queries against the Obsidian
 * Local REST API plugin (https://github.com/coddingtonbear/obsidian-
 * local-rest-api).
 *
 * The agent calls `readObsidianVault({ query })`. The tool runs a
 * simple-search via `POST /search/simple/`, returning the matched
 * notes' paths and excerpts. Read-only by construction — no write
 * endpoints are wired.
 *
 * Authentication: the REST API plugin uses a per-vault Bearer token.
 * The admin installs the integration with the API key on the
 * /admin/integrations page; the lazy plugin loader passes the
 * decrypted key into this config.
 */

import { tool } from "ai";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config type — index.ts validates this shape via Zod at factory time.
// ---------------------------------------------------------------------------

export interface ObsidianReaderPluginConfig {
  /** Base URL of the Obsidian Local REST API. Defaults to `http://127.0.0.1:27123`. */
  readonly api_url?: string;
  /** Bearer API key issued by the REST API plugin's settings tab. */
  readonly api_key: string;
}

const DEFAULT_API_URL = "http://127.0.0.1:27123";

/**
 * Non-regex trailing-slash strip — avoids the polynomial-regex
 * pattern CodeQL flags on user-derived URL input (`/\/+$/`). Linear
 * in input length, no backtracking, no surprise.
 */
export function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47 /* "/" */) end--;
  return end === url.length ? url : url.slice(0, end);
}

// ---------------------------------------------------------------------------
// Raw search call (config-driven)
// ---------------------------------------------------------------------------

export interface ObsidianSearchParams {
  /** Free-text search query — matched against note bodies and titles. */
  query: string;
}

export interface ObsidianSearchHit {
  /** Vault-relative path of the matching note. */
  readonly filename: string;
  /** Excerpt(s) around the match, joined with newlines. */
  readonly excerpt: string;
  /** REST API match score — higher is more relevant. */
  readonly score: number;
}

export interface ObsidianSearchResult {
  readonly hits: ReadonlyArray<ObsidianSearchHit>;
}

/**
 * Raw shape of `/search/simple/` items. The plugin returns an array of
 * `{ filename, matches[], score }`; we flatten `matches[]` into a
 * single excerpt string per hit so the model doesn't have to parse the
 * per-match window structure.
 */
interface SimpleSearchItem {
  filename: string;
  score: number;
  matches?: ReadonlyArray<{ context?: string; match?: { start: number; end: number } }>;
}

export async function executeObsidianSearch(
  config: ObsidianReaderPluginConfig,
  params: ObsidianSearchParams,
): Promise<ObsidianSearchResult> {
  const base = stripTrailingSlashes(config.api_url ?? DEFAULT_API_URL);
  // contextLength of 100 chars covers the typical match window without
  // pulling whole files into the agent context.
  const url = `${base}/search/simple/?query=${encodeURIComponent(params.query)}&contextLength=100`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.api_key}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    let detail: string;
    try {
      const errorBody = (await response.json()) as { message?: string; errorCode?: number };
      detail = errorBody.message ?? `HTTP ${response.status}`;
    } catch {
      let rawText = "";
      try {
        rawText = await response.text();
      } catch (textErr) {
        rawText = `[body unreadable: ${textErr instanceof Error ? textErr.message : String(textErr)}]`;
      }
      detail = rawText
        ? `HTTP ${response.status}: ${rawText.slice(0, 200)}`
        : `HTTP ${response.status}`;
    }
    throw new Error(`Obsidian REST API error: ${detail}`);
  }

  let items: SimpleSearchItem[];
  try {
    items = (await response.json()) as SimpleSearchItem[];
  } catch (err) {
    throw new Error("Obsidian REST API returned unparseable response", { cause: err });
  }

  if (!Array.isArray(items)) {
    throw new Error(
      `Obsidian REST API returned non-array search result (got ${items === null ? "null" : typeof items})`,
    );
  }

  return {
    hits: items.map((item) => ({
      filename: item.filename,
      score: item.score,
      excerpt: (item.matches ?? [])
        .map((m) => m.context ?? "")
        .filter((s) => s.length > 0)
        .join("\n---\n"),
    })),
  };
}

// ---------------------------------------------------------------------------
// AI SDK tool factory
// ---------------------------------------------------------------------------

const TOOL_DESCRIPTION = `Read notes from the connected Obsidian vault.
Use this to look up reference material, definitions, or prior analysis
that the user has captured in Obsidian. Read-only.`;

export function createObsidianTool(config: ObsidianReaderPluginConfig) {
  return tool({
    description: TOOL_DESCRIPTION,
    inputSchema: z.object({
      query: z.string().min(1).describe("Free-text search query to run against the vault."),
    }),
    execute: async ({ query }) => executeObsidianSearch(config, { query }),
  });
}
