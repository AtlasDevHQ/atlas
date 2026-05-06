/**
 * Canonical-question eval through the MCP path (#2074, Phase 1).
 *
 * The existing deterministic canonical eval (`packages/cli/bin/canonical-eval.ts`)
 * proves the **semantic-layer** answers each question correctly — it calls
 * `findMetricById` and executes the resolved SQL directly. That harness
 * cannot catch a regression in the MCP layer itself: a bad tool
 * description, a malformed `AtlasMcpToolError` envelope, a `prompts/list`
 * shape change, or a session-cap break would all ship green.
 *
 * This file closes that gap. Every canonical question is dispatched
 * through the real `createHostedMcpRouter()` mounted on `Bun.serve`,
 * exercising the full MCP transport stack:
 *
 *   bun runtime → @modelcontextprotocol/sdk Client
 *               → StreamableHTTPClientTransport
 *               → Hono route /mcp/{workspace}/sse
 *               → verifyAccessToken (mocked — see Phase 2 below)
 *               → tools/list, tools/call, prompts/list
 *               → semantic-layer reads (REAL — `findMetricById`,
 *                  `searchGlossary`, `getEntityByName`)
 *               → executeSQL (MOCKED — SQL correctness is owned by the
 *                  existing deterministic eval; here we validate the MCP
 *                  envelope wrapping)
 *
 * ── Phase split ─────────────────────────────────────────────────────
 *
 * Phase 1 (this file):
 *   - Mocks `verifyAccessToken` so we don't need a real OAuth server.
 *   - Mocks `executeSQL.execute` so we don't need a real Postgres pool +
 *     migrated internal DB. Real SQL execution is covered by the
 *     existing deterministic eval.
 *   - Real semantic-layer reads.
 *   - Asserts on protocol shape, tool dispatch, envelope codes, prompts
 *     list shape, and concurrent-session behavior.
 *
 * Phase 2 (#2119):
 *   - Real DCR + PKCE flow against an in-process Better Auth instance —
 *     covers the JWT signature path the verifier mock currently hides.
 *   - `--mcp-llm` mode where an LLM picks tools through MCP — validates
 *     tool-selection accuracy and recovery contract under prose drift.
 *
 * ── Stress mode ─────────────────────────────────────────────────────
 *
 * Beyond the per-question coverage, the file ends with a concurrent-
 * session stress test that opens N parallel sessions and asserts the
 * route honours `ATLAS_MCP_MAX_SESSIONS` without a TOCTOU race. This is
 * the protocol-layer half of the load-test work tracked in #2070; the
 * full k6 profile lands separately.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  mock,
  type Mock,
} from "bun:test";
import * as fs from "fs";
import * as path from "path";
import type { AdminActionEntry } from "@atlas/api/lib/audit";
import { ATLAS_OAUTH_WORKSPACE_CLAIM as WORKSPACE_CLAIM } from "@atlas/api/lib/auth/oauth-claims";
// Pure runner core lives in @atlas/cli — relative path because the cli
// package doesn't ship an `exports` map. The functions we need
// (`loadQuestions`, `DEFAULT_QUESTIONS_PATH`) are pure and DB-free.
import {
  loadQuestions,
  DEFAULT_QUESTIONS_PATH,
  type Question,
} from "../../../cli/bin/canonical-eval";
import { EvalMcpClient, extractToolJson } from "./canonical-mcp-client";
import {
  formatArtifactBundle,
  type FailureCategory,
  type McpFailureArtifact,
} from "./canonical-mcp-failure-artifact";

// ── Module mocks ───────────────────────────────────────────────────
//
// Shapes mirror `packages/mcp/src/__tests__/hosted.test.ts`. Every
// named export is stubbed (CLAUDE.md rule — partial mocks leak).

interface FakeJwtPayload {
  sub: string;
  jti?: string;
  azp?: string;
  scope?: string;
  aud?: string | string[];
  iss?: string;
  exp?: number;
  iat?: number;
  [WORKSPACE_CLAIM]?: string;
}

const mockVerifyAccessToken: Mock<
  (token: string, opts: unknown) => Promise<FakeJwtPayload>
> = mock(async () => {
  throw new Error("verifyAccessToken called without a stub");
});

mock.module("better-auth/oauth2", () => ({
  verifyAccessToken: (token: string, opts: unknown) =>
    mockVerifyAccessToken(token, opts),
  authorizationCodeRequest: () => {
    throw new Error("authorizationCodeRequest called from mcp-eval");
  },
  clientCredentialsToken: () => {
    throw new Error("clientCredentialsToken called from mcp-eval");
  },
  clientCredentialsTokenRequest: () => {
    throw new Error("clientCredentialsTokenRequest called from mcp-eval");
  },
  createAuthorizationCodeRequest: () => {
    throw new Error("createAuthorizationCodeRequest called from mcp-eval");
  },
  createAuthorizationURL: () => {
    throw new Error("createAuthorizationURL called from mcp-eval");
  },
  createClientCredentialsTokenRequest: () => {
    throw new Error("createClientCredentialsTokenRequest called from mcp-eval");
  },
  createRefreshAccessTokenRequest: () => {
    throw new Error("createRefreshAccessTokenRequest called from mcp-eval");
  },
  decryptOAuthToken: () => {
    throw new Error("decryptOAuthToken called from mcp-eval");
  },
  generateCodeChallenge: () => {
    throw new Error("generateCodeChallenge called from mcp-eval");
  },
  generateState: () => {
    throw new Error("generateState called from mcp-eval");
  },
  getJwks: () => {
    throw new Error("getJwks called from mcp-eval");
  },
  getOAuth2Tokens: () => {
    throw new Error("getOAuth2Tokens called from mcp-eval");
  },
  handleOAuthUserInfo: () => {
    throw new Error("handleOAuthUserInfo called from mcp-eval");
  },
  parseState: () => {
    throw new Error("parseState called from mcp-eval");
  },
  refreshAccessToken: () => {
    throw new Error("refreshAccessToken called from mcp-eval");
  },
  refreshAccessTokenRequest: () => {
    throw new Error("refreshAccessTokenRequest called from mcp-eval");
  },
  setTokenUtil: () => {
    throw new Error("setTokenUtil called from mcp-eval");
  },
  validateAuthorizationCode: () => {
    throw new Error("validateAuthorizationCode called from mcp-eval");
  },
  validateToken: () => {
    throw new Error("validateToken called from mcp-eval");
  },
  verifyJwsAccessToken: () => {
    throw new Error("verifyJwsAccessToken called from mcp-eval");
  },
}));

// `db/internal` is touched by the route (residency check) and by audit.
mock.module("@atlas/api/lib/db/internal", () => {
  const notUsed = (name: string) => () => {
    throw new Error(`db/internal.${name} called from mcp-eval — add a mock`);
  };
  return {
    getWorkspaceRegion: async () => null,
    hasInternalDB: () => false,
    internalQuery: notUsed("internalQuery"),
    internalExecute: notUsed("internalExecute"),
    getInternalDB: notUsed("getInternalDB"),
    assignWorkspaceRegion: notUsed("assignWorkspaceRegion"),
    isWorkspaceMigrating: async () => false,
    closeInternalDB: async () => undefined,
  };
});

// Audit emission is observability-only for the eval. Drop to in-memory.
const auditEntries: AdminActionEntry[] = [];
mock.module("@atlas/api/lib/audit", () => ({
  ADMIN_ACTIONS: {
    mcp_session: { start: "mcp_session.start" },
    oauth_token: {
      issue: "oauth_token.issue",
      refresh: "oauth_token.refresh",
      revoke: "oauth_token.revoke",
    },
  },
  logAdminAction: (entry: AdminActionEntry) => auditEntries.push(entry),
  logAdminActionAwait: async (entry: AdminActionEntry) =>
    void auditEntries.push(entry),
  errorMessage: (err: unknown) =>
    err instanceof Error ? err.message : String(err),
  causeToError: (err: unknown) =>
    err instanceof Error ? err : new Error(String(err)),
}));

// `executeSQL` is the SQL execution boundary inside `runMetric` and the
// MCP `executeSQL` tool. We stub it to return a static success envelope
// so the eval validates the MCP wrapping (envelope shape, success path,
// truncation flag) without standing up a Postgres pool. SQL correctness
// is the existing deterministic eval's job; this eval owns the MCP path.
mock.module("@atlas/api/lib/tools/sql", () => ({
  executeSQL: {
    description:
      "Execute a SELECT query against the configured analytics database. Returns columns + rows.",
    execute: async (
      args: { sql: string; explanation?: string; connectionId?: string },
    ) => ({
      success: true,
      explanation: args.explanation ?? "mcp-eval",
      columns: ["count"],
      rows: [{ count: 42 }],
      row_count: 1,
      truncated: false,
    }),
  },
}));

// Avoid pulling the full sandbox stack — `explore` isn't exercised by
// canonical questions but the MCP server still registers it.
mock.module("@atlas/api/lib/tools/explore", () => ({
  explore: {
    description: "Explore the semantic layer (read-only).",
    execute: async () => "catalog.yml\nentities/\nmetrics/\nglossary.yml",
  },
}));

// Config: minimal. The MCP server reads `tools` to know which tools to
// register; tag the eval-relevant ones explicitly.
interface MockedConfig {
  datasources: Record<string, unknown>;
  tools: string[];
  auth: string;
  semanticLayer: string;
  source: string;
}
const mockedConfig: MockedConfig = {
  datasources: {},
  tools: ["explore", "executeSQL"],
  auth: "auto",
  semanticLayer: "./semantic",
  source: "env",
};
mock.module("@atlas/api/lib/config", () => ({
  initializeConfig: async () => mockedConfig,
  getConfig: () => mockedConfig,
  loadConfig: async () => mockedConfig,
  configFromEnv: () => mockedConfig,
  validateAndResolve: () => mockedConfig,
  defineConfig: (c: unknown) => c,
  applyDatasources: async () => undefined,
  validateToolConfig: async () => undefined,
  formatZodErrors: () => "",
  _resetConfig: () => undefined,
  _setConfigForTest: () => undefined,
  _warnPoolDefaultsInSaaS: () => undefined,
}));

// ── Test fixtures ─────────────────────────────────────────────────

// Anchor every fs path at the test file location so the harness behaves
// the same whether `bun test` is invoked from the repo root or from
// `packages/mcp/`. The existing canonical-eval CLI runs from the repo
// root and relies on `process.cwd()`; mirroring that here would break
// the per-package `bun run test` workflow.
const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..");
const SEMANTIC_DIR = path.join(REPO_ROOT, "semantic");
const SEED_SEMANTIC_DIR = path.join(
  REPO_ROOT,
  "packages",
  "cli",
  "data",
  "seeds",
  "ecommerce",
  "semantic",
);
const SEMANTIC_BACKUP_DIR = path.join(REPO_ROOT, ".semantic-backup-mcp-eval");

const ORG_ID = "org_canonical_eval";
const SUB_ID = "user_canonical_eval";
const CLIENT_ID = "atlas-canonical-mcp-eval";
const TOKEN = "fake.canonical.eval.token";

interface ServerHandle {
  url: string;
  close: () => void;
}

let server: ServerHandle | undefined;

beforeAll(async () => {
  // Stage the demo semantic layer — same dance the deterministic eval
  // uses. Restoration runs in `afterAll`; failure to restore is loud
  // because a partial restore would silently change the user's working
  // tree.
  if (fs.existsSync(SEMANTIC_BACKUP_DIR)) {
    fs.rmSync(SEMANTIC_BACKUP_DIR, { recursive: true });
  }
  if (fs.existsSync(SEMANTIC_DIR)) {
    fs.cpSync(SEMANTIC_DIR, SEMANTIC_BACKUP_DIR, { recursive: true });
    fs.rmSync(SEMANTIC_DIR, { recursive: true });
  }
  if (!fs.existsSync(SEED_SEMANTIC_DIR)) {
    throw new Error(
      `Demo seed semantic layer not found at ${SEED_SEMANTIC_DIR}. ` +
        `Cannot run MCP eval without it.`,
    );
  }
  fs.cpSync(SEED_SEMANTIC_DIR, SEMANTIC_DIR, { recursive: true });

  // Reset semantic-layer caches so the freshly installed YAMLs are
  // re-resolved by the in-process MCP server. If the reset itself
  // throws, `semantic/` is already swapped — point the contributor at
  // the recovery commands rather than letting bun:test surface a
  // generic error with no working-tree context.
  try {
    const { _resetWhitelists } = await import("@atlas/api/lib/semantic");
    _resetWhitelists();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `\nMCP eval beforeAll failed after staging semantic/. Working tree is now seeded with the demo layer; backup at ${SEMANTIC_BACKUP_DIR}.\n` +
        `Recover manually:\n` +
        `  rm -rf ${SEMANTIC_DIR}\n` +
        `  ${fs.existsSync(SEMANTIC_BACKUP_DIR) ? `mv ${SEMANTIC_BACKUP_DIR} ${SEMANTIC_DIR}` : "# no backup — semantic/ was empty before"}\n` +
        `Underlying error: ${message}\n`,
    );
    throw err;
  }

  // Bind the test bearer to a workspace-scoped JWT payload.
  mockVerifyAccessToken.mockImplementation(async (token: string) => {
    if (token === TOKEN) {
      return {
        sub: SUB_ID,
        jti: "jti_canonical",
        azp: CLIENT_ID,
        scope: "openid mcp:read",
        [WORKSPACE_CLAIM]: ORG_ID,
      } satisfies FakeJwtPayload;
    }
    throw new Error(`Unknown token in mcp-eval: ${token}`);
  });

  // Boot the real router on a random port. We do this once and share
  // the address across every `it` so the prompts/list, tools/list, and
  // per-question dispatches all hit the same in-process server.
  const { Hono } = await import("hono");
  const { createHostedMcpRouter } = await import("@atlas/mcp/hosted");
  const app = new Hono();
  app.route("/mcp", createHostedMcpRouter());
  const handle = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch: app.fetch,
  });
  if (typeof handle.port !== "number") {
    handle.stop(true);
    throw new Error("Bun.serve did not bind a TCP port for the MCP eval");
  }
  server = {
    url: `http://localhost:${handle.port}`,
    close: () => handle.stop(true),
  };
});

afterAll(async () => {
  server?.close();
  server = undefined;
  const { _resetHostedSessions } = await import("@atlas/mcp/hosted");
  await _resetHostedSessions();

  // Restore semantic layer no matter what. A failed restore would
  // silently corrupt the contributor's working tree (eval-seeded
  // entities staying in `semantic/`); print the recovery commands and
  // re-throw so the test run fails loudly instead of "all green".
  try {
    if (fs.existsSync(SEMANTIC_BACKUP_DIR)) {
      if (fs.existsSync(SEMANTIC_DIR)) {
        fs.rmSync(SEMANTIC_DIR, { recursive: true });
      }
      fs.cpSync(SEMANTIC_BACKUP_DIR, SEMANTIC_DIR, { recursive: true });
      fs.rmSync(SEMANTIC_BACKUP_DIR, { recursive: true });
    } else if (fs.existsSync(SEMANTIC_DIR)) {
      // No backup means there was nothing in semantic/ before — clean up.
      fs.rmSync(SEMANTIC_DIR, { recursive: true });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `\nCRITICAL: failed to restore semantic layer after MCP eval: ${message}\n` +
        `Recover manually:\n` +
        `  rm -rf ${SEMANTIC_DIR}\n` +
        `  ${fs.existsSync(SEMANTIC_BACKUP_DIR) ? `mv ${SEMANTIC_BACKUP_DIR} ${SEMANTIC_DIR}` : "# no backup exists — semantic/ is now empty (this is fine if it started empty)"}\n`,
    );
    throw err;
  }

  mock.restore();
});

afterEach(async () => {
  const { _resetHostedSessions } = await import("@atlas/mcp/hosted");
  await _resetHostedSessions();
});

function newClient(): EvalMcpClient {
  if (!server) throw new Error("MCP eval server not started");
  return new EvalMcpClient({
    baseUrl: server.url,
    workspaceId: ORG_ID,
    bearer: TOKEN,
  });
}

// ── Per-question dispatch ─────────────────────────────────────────

/**
 * Discriminated by `status`: a `fail` outcome always carries an
 * artifact, a `pass` outcome never does. Modeling this as a union
 * (rather than an optional artifact field) lets the summary code at
 * the bottom narrow without a guard each time it touches `outcome.artifact`.
 */
type QuestionOutcome =
  | { readonly questionId: string; readonly status: "pass"; readonly latencyMs: number }
  | { readonly questionId: string; readonly status: "fail"; readonly latencyMs: number; readonly artifact: McpFailureArtifact };

async function runOneQuestion(
  client: EvalMcpClient,
  q: Question,
): Promise<QuestionOutcome> {
  const start = Date.now();
  const fail = (
    category: FailureCategory,
    summary: string,
    detail: { tool: string | null; args: Record<string, unknown>; response: unknown; expected: unknown },
  ): QuestionOutcome => {
    const latencyMs = Date.now() - start;
    return {
      questionId: q.id,
      status: "fail",
      latencyMs,
      artifact: {
        questionId: q.id,
        category,
        latencyMs,
        ...detail,
        summary,
      },
    };
  };

  try {
    switch (q.mode) {
      case "metric": {
        const tool = "runMetric";
        const args = { id: q.metric_id };
        const result = await client.callTool(tool, args);
        const parsed = extractToolJson(result);
        if (parsed.kind === "unparseable") {
          return fail("protocol", `runMetric returned non-JSON content`, {
            tool,
            args,
            response: parsed.raw,
            expected: "JSON envelope or success object",
          });
        }
        if (parsed.kind === "error") {
          return fail("recovery", `runMetric returned error envelope for known metric`, {
            tool,
            args,
            response: parsed.envelope,
            expected: { id: q.metric_id, success: true },
          });
        }
        const data = parsed.data as {
          id?: unknown;
          sql?: unknown;
          columns?: unknown;
          rows?: unknown;
          truncated?: unknown;
        };
        if (data.id !== q.metric_id) {
          return fail("protocol", `runMetric envelope id mismatch`, {
            tool,
            args,
            response: data,
            expected: { id: q.metric_id },
          });
        }
        if (typeof data.sql !== "string" || data.sql.length === 0) {
          return fail("protocol", `runMetric envelope missing sql`, {
            tool,
            args,
            response: data,
            expected: "non-empty sql string",
          });
        }
        // Wire-shape pin: a regression that flips `truncated` to a string
        // or drops `columns`/`rows` ships invisible to the agent until a
        // downstream tool (a notebook, a chat-platform formatter)
        // crashes on the unexpected type. Catch it at the eval boundary.
        if (!Array.isArray(data.columns)) {
          return fail("protocol", `runMetric envelope columns must be an array`, {
            tool,
            args,
            response: data,
            expected: { columns: "string[]" },
          });
        }
        if (!Array.isArray(data.rows)) {
          return fail("protocol", `runMetric envelope rows must be an array`, {
            tool,
            args,
            response: data,
            expected: { rows: "Record<string, unknown>[]" },
          });
        }
        if (typeof data.truncated !== "boolean") {
          return fail("protocol", `runMetric envelope truncated must be a boolean`, {
            tool,
            args,
            response: data,
            expected: { truncated: "boolean" },
          });
        }
        return { questionId: q.id, status: "pass", latencyMs: Date.now() - start };
      }
      case "glossary": {
        const tool = "searchGlossary";
        const args = { term: q.term };
        const result = await client.callTool(tool, args);
        const parsed = extractToolJson(result);
        if (parsed.kind === "unparseable") {
          return fail("protocol", `searchGlossary returned non-JSON content`, {
            tool,
            args,
            response: parsed.raw,
            expected: "JSON envelope or matches[]",
          });
        }
        const expectedStatus = q.expect.status ?? null;
        if (expectedStatus === "ambiguous") {
          if (parsed.kind !== "error") {
            return fail("recovery", `searchGlossary did not return ambiguous_term envelope`, {
              tool,
              args,
              response: parsed.data,
              expected: { code: "ambiguous_term" },
            });
          }
          const env = parsed.envelope as { code?: unknown; hint?: unknown };
          if (env.code !== "ambiguous_term") {
            return fail("recovery", `searchGlossary envelope code is ${String(env.code)}, expected ambiguous_term`, {
              tool,
              args,
              response: env,
              expected: { code: "ambiguous_term" },
            });
          }
          if (typeof env.hint !== "string" || env.hint.length === 0) {
            return fail("recovery", `ambiguous_term envelope missing hint`, {
              tool,
              args,
              response: env,
              expected: { code: "ambiguous_term", hint: "<non-empty>" },
            });
          }
          return { questionId: q.id, status: "pass", latencyMs: Date.now() - start };
        }
        // Defined / no-status path — success envelope expected with a
        // `matches[]` array. A regression that returns `{}` or
        // stringifies the matches must trip here, not silently pass.
        if (parsed.kind === "error") {
          return fail("recovery", `searchGlossary returned error envelope on a defined term`, {
            tool,
            args,
            response: parsed.envelope,
            expected: "success matches[]",
          });
        }
        const glossaryData = parsed.data as { matches?: unknown };
        if (!Array.isArray(glossaryData.matches)) {
          return fail("protocol", `searchGlossary success envelope must carry matches[]`, {
            tool,
            args,
            response: glossaryData,
            expected: { matches: "Array<{term, status, possible_mappings}>" },
          });
        }
        return { questionId: q.id, status: "pass", latencyMs: Date.now() - start };
      }
      case "pattern": {
        // `describeEntity` is the round-trip under test — the MCP
        // semantic toolset surfaces `query_patterns[*]` through the
        // entity envelope. Asserting the named pattern is present in
        // the response catches a regression in the entity loader's
        // shape without coupling the eval to executeSQL semantics.
        const tool = "describeEntity";
        const args = { name: q.entity };
        const result = await client.callTool(tool, args);
        const parsed = extractToolJson(result);
        if (parsed.kind === "unparseable") {
          return fail("protocol", `describeEntity returned non-JSON content`, {
            tool,
            args,
            response: parsed.raw,
            expected: "JSON entity envelope",
          });
        }
        if (parsed.kind === "error") {
          return fail("recovery", `describeEntity returned error envelope for a known entity`, {
            tool,
            args,
            response: parsed.envelope,
            expected: { found: true },
          });
        }
        const entity = (parsed.data as { entity?: { query_patterns?: Array<{ name?: string }> } }).entity;
        const patterns = entity?.query_patterns ?? [];
        if (!patterns.some((p) => p.name === q.pattern)) {
          return fail("assertion", `describeEntity result missing query_pattern "${q.pattern}"`, {
            tool,
            args,
            response: { patterns: patterns.map((p) => p.name) },
            expected: { has_pattern: q.pattern },
          });
        }
        return { questionId: q.id, status: "pass", latencyMs: Date.now() - start };
      }
      case "virtual": {
        // Virtual dimensions exercise raw SQL through the MCP `executeSQL`
        // tool. With executeSQL mocked the wire-shape is what we assert.
        const tool = "executeSQL";
        const args = {
          sql: q.sql,
          explanation: `mcp-eval ${q.id}`,
        };
        const result = await client.callTool(tool, args);
        const parsed = extractToolJson(result);
        if (parsed.kind === "unparseable") {
          return fail("protocol", `executeSQL returned non-JSON content`, {
            tool,
            args,
            response: parsed.raw,
            expected: "JSON tool result",
          });
        }
        if (parsed.kind === "error") {
          return fail("recovery", `executeSQL returned error envelope for valid virtual SQL`, {
            tool,
            args,
            response: parsed.envelope,
            expected: "success",
          });
        }
        return { questionId: q.id, status: "pass", latencyMs: Date.now() - start };
      }
      default: {
        const _exhaustive: never = q;
        throw new Error(`unreachable mode: ${String(_exhaustive)}`);
      }
    }
  } catch (err) {
    return fail("protocol", `dispatch threw: ${err instanceof Error ? err.message : String(err)}`, {
      tool: null,
      args: {},
      response: { error: err instanceof Error ? err.message : String(err) },
      expected: "successful round-trip",
    });
  }
}

// ── Tests ─────────────────────────────────────────────────────────

describe("MCP path canonical eval (#2074)", () => {
  it("registers the expected tool surface", async () => {
    const client = newClient();
    try {
      await client.connect();
      const tools = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      // Expected toolset — adding a tool here means an explicit decision
      // in the eval. A change at the `registerTools` / `registerSemanticTools`
      // call sites should land in lockstep with this assertion.
      expect(names).toEqual([
        "describeEntity",
        "executeSQL",
        "explore",
        "listEntities",
        "runMetric",
        "searchGlossary",
      ]);
      // Description-quality floor — agent tool-selection accuracy is
      // gated by description quality (full audit owned by #2075). Pin
      // the cheap things now: descriptions exist, are long enough to
      // carry intent + one usage hint, and the tools that surface a
      // typed error envelope mention their error catalog so the agent
      // can branch on `code`. A tool that drops to "Run a metric." or
      // forgets to surface its error contract slips through #2075's
      // backlog window otherwise.
      const MIN_DESC_LEN = 40;
      for (const t of tools) {
        const desc = t.description ?? "";
        expect(desc.length, `tool ${t.name} description too short (${desc.length} < ${MIN_DESC_LEN}): ${JSON.stringify(desc)}`)
          .toBeGreaterThanOrEqual(MIN_DESC_LEN);
      }
      // Every tool description should mention the error-envelope
      // contract — `withErrorContract` (semantic-tools.ts) appends
      // "Error contract:" to each description. A regression that drops
      // the wrapper would degrade agent recovery silently.
      for (const t of tools) {
        const desc = t.description ?? "";
        expect(desc, `tool ${t.name} missing 'Error contract:' line`).toContain("Error contract:");
      }
      // Tools that emit envelopes for `unknown_*` or `ambiguous_term`
      // must mention those codes by name — pinning the recovery surface
      // the agent reads.
      const expectMentions: ReadonlyArray<readonly [string, readonly string[]]> = [
        ["runMetric", ["unknown_metric", "validation_failed"]],
        ["describeEntity", ["unknown_entity"]],
        ["searchGlossary", ["ambiguous_term"]],
      ];
      for (const [name, codes] of expectMentions) {
        const t = tools.find((x) => x.name === name);
        expect(t, `tool ${name} missing from listTools()`).toBeTruthy();
        for (const code of codes) {
          expect(t!.description ?? "", `tool ${name} description does not mention error code "${code}"`)
            .toContain(`\`${code}\``);
        }
      }
    } finally {
      await client.close();
    }
  });

  it("exposes prompts/list without crashing", async () => {
    const client = newClient();
    try {
      await client.connect();
      // The semantic-layer prompts library may or may not be populated
      // in this fixture (the demo seed registers query_patterns as
      // prompts via registerPrompts). We assert the call does not
      // throw and returns an array — the shape contract.
      const prompts = await client.listPrompts();
      expect(Array.isArray(prompts)).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("returns unknown_metric envelope for an unrecognized metric id", async () => {
    const client = newClient();
    try {
      await client.connect();
      const result = await client.callTool("runMetric", { id: "this_metric_does_not_exist_xyz" });
      const parsed = extractToolJson(result);
      expect(parsed.kind).toBe("error");
      if (parsed.kind === "error") {
        const env = parsed.envelope as { code?: unknown; hint?: unknown };
        expect(env.code).toBe("unknown_metric");
        // Recovery contract: every `unknown_*` envelope must carry a
        // non-empty `hint` so an agent can self-correct (e.g. "call
        // listEntities to discover available metrics"). A regression
        // that drops the hint would silently degrade agent recovery.
        expect(env.hint).toBeTruthy();
      }
    } finally {
      await client.close();
    }
  });

  it("returns unknown_entity envelope for an unrecognized entity name", async () => {
    const client = newClient();
    try {
      await client.connect();
      const result = await client.callTool("describeEntity", { name: "ZZZNotARealEntityZZZ" });
      const parsed = extractToolJson(result);
      expect(parsed.kind).toBe("error");
      if (parsed.kind === "error") {
        const env = parsed.envelope as { code?: unknown; hint?: unknown };
        expect(env.code).toBe("unknown_entity");
        expect(env.hint).toBeTruthy();
      }
    } finally {
      await client.close();
    }
  });

  it("dispatches every canonical question through MCP and reports per-question outcome", async () => {
    const questions = loadQuestions(DEFAULT_QUESTIONS_PATH);
    expect(questions.length).toBeGreaterThanOrEqual(20);

    const client = newClient();
    const outcomes: QuestionOutcome[] = [];
    try {
      await client.connect();
      for (const q of questions) {
        outcomes.push(await runOneQuestion(client, q));
      }
    } finally {
      await client.close();
    }

    const passing = outcomes.filter((o) => o.status === "pass").length;
    const failures = outcomes.filter(
      (o): o is Extract<QuestionOutcome, { status: "fail" }> =>
        o.status === "fail",
    );
    const artifactBundle = formatArtifactBundle(failures.map((f) => f.artifact));

    process.stdout.write(
      `\nMCP canonical eval: ${passing}/${outcomes.length} passing\n`,
    );
    if (failures.length > 0) {
      process.stdout.write(artifactBundle);
    }

    // Acceptance criterion (Phase 1 deterministic): every canonical
    // question round-trips through MCP without protocol / recovery /
    // assertion failure. If this drops below 20/20 something on the
    // MCP path regressed and the artifacts above explain what.
    expect(failures, artifactBundle).toEqual([]);
  });
});

describe("MCP path stress (#2074, partial #2070)", () => {
  it("opens N concurrent sessions through the route without contention", async () => {
    const N = 5;
    const clients = Array.from({ length: N }, () => newClient());
    try {
      await Promise.all(clients.map((c) => c.connect()));
      // Every session can dispatch independently — no shared mutable
      // state should leak between them. We hit `tools/list` per client
      // (cheapest dispatch) and assert the surface is identical, which
      // catches a session-binding regression where one client's
      // registration pollutes another's view.
      const surfaces = await Promise.all(clients.map((c) => c.listTools()));
      const reference = [...surfaces[0]].map((t) => t.name).sort().join(",");
      for (const s of surfaces) {
        expect([...s].map((t) => t.name).sort().join(",")).toEqual(reference);
      }
    } finally {
      await Promise.all(clients.map((c) => c.close()));
    }
  });

  it("enforces ATLAS_MCP_MAX_SESSIONS without TOCTOU drift under contention", async () => {
    // The reservation counter at hosted.ts (`pendingReservations`) closes
    // a TOCTOU window between the cap check and `createAtlasMcpServer`'s
    // async resolution. Driving the cap with N=DEFAULT_MAX_SESSIONS+ would
    // be slow; instead we lower the cap and saturate it, which exercises
    // the exact same code path with concrete contention.
    const CAP = 3;
    const previous = process.env.ATLAS_MCP_MAX_SESSIONS;
    process.env.ATLAS_MCP_MAX_SESSIONS = String(CAP);
    const { _resetHostedSessions } = await import("@atlas/mcp/hosted");
    await _resetHostedSessions();

    // Open CAP+2 concurrent connect attempts. The first CAP must
    // succeed; the remainder must reject with the route's 429-style
    // session-cap error rather than slip through a race.
    const N = CAP + 2;
    const clients = Array.from({ length: N }, () => newClient());
    const results = await Promise.allSettled(
      clients.map((c) => c.connect()),
    );
    try {
      const fulfilled = results.filter((r) => r.status === "fulfilled").length;
      const rejected = results.length - fulfilled;
      expect(fulfilled).toBeLessThanOrEqual(CAP);
      expect(rejected).toBeGreaterThanOrEqual(N - CAP);
    } finally {
      // Best-effort close — only fulfilled connects need teardown; the
      // rejected ones never registered a session.
      await Promise.all(
        clients.map((c, i) =>
          results[i].status === "fulfilled" ? c.close() : Promise.resolve(),
        ),
      );
      if (previous === undefined) delete process.env.ATLAS_MCP_MAX_SESSIONS;
      else process.env.ATLAS_MCP_MAX_SESSIONS = previous;
      await _resetHostedSessions();
    }
  });
});
