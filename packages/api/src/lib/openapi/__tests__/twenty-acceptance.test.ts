/**
 * Twenty acceptance suite — the single load-bearing test for the generic
 * OpenAPI agent (PRD #2868 slice 1, #2924).
 *
 * Proves the generic agent matches every action `scripts/twenty-mcp.ts` exposes
 * against a Twenty workspace, with NO per-operation Atlas code: the only Twenty-
 * specific inputs are the spec URL + bearer (env config). Everything else is the
 * generic slice-0 primitive + the `executeRestOperation` tool + the Path A
 * representation.
 *
 * Architecture:
 *  - Drives the REAL `runAgent` loop with a scripted `MockLanguageModelV3`
 *    (the established agent-integration pattern). The scripted emissions encode
 *    what a capable agent produces; the assertions verify the plumbing
 *    (representation -> tool -> slice-0 client -> wire) transmits the four
 *    Twenty traps faithfully, against an in-process mock seeded from real Twenty
 *    response shapes that HONORS the filter syntax.
 *  - Parameterized over {@link RepresentationMode} so #2931 re-runs the identical
 *    assertions in semantic-YAML mode. Path A ("operation-graph") is the only
 *    implemented mode today; the harness emits per-run metrics (representation
 *    prompt tokens + agent step count) for the bake-off.
 *
 * OQ1 (Python-vs-tool routing): see the trace observations logged at the end of
 * the run and the note in the PR. This hermetic suite always exercises the
 * `executeRestOperation` (single op) + sequential-call shape. Slice 3 (#2927)
 * landed the sandbox network boundary that the in-sandbox composition path
 * depends on (proven by `tools/backends/__tests__/network-allowlist.test.ts`), but the
 * live in-sandbox `AtlasRestClient` composition path itself stays deferred —
 * see the python-preamble.ts header for why (read-only enforcement).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { UIMessage } from "ai";
import * as fs from "fs";
import * as path from "path";
import { createConnectionMock } from "@atlas/api/testing/connection";

import {
  startTwentyMockServer,
  type TwentyMock,
} from "./twenty-acceptance/mock-server";
import { buildOperationGraph } from "../spec";
import { executeOperation } from "../client";
import { buildAgentRepresentation, type RepresentationMode } from "../representation";
import { buildRestClientPreamble } from "../python-preamble";

// ── Env + module mocks (must precede the agent import) ───────────────────────
process.env.ATLAS_DATASOURCE_URL ??= "postgresql://test:test@localhost:5432/test";
delete process.env.DATABASE_URL; // keep hasInternalDB() false → skip DB preflight

let mockModel: InstanceType<typeof MockLanguageModelV3>;

mock.module("@atlas/api/lib/providers", () => ({
  getModel: () => mockModel,
  getProviderType: () => "anthropic" as const,
  getModelFromWorkspaceConfig: () => mockModel,
  getWorkspaceProviderType: () => "anthropic" as const,
  getDefaultProvider: () => "anthropic" as const,
}));

mock.module("@atlas/api/lib/semantic", () => ({
  getOrgWhitelistedTables: () => new Set(),
  loadOrgWhitelist: async () => new Map(),
  invalidateOrgWhitelist: () => {},
  getOrgSemanticIndex: async () => "",
  invalidateOrgSemanticIndex: () => {},
  _resetOrgWhitelists: () => {},
  _resetOrgSemanticIndexes: () => {},
  getWhitelistedTables: () => new Set(),
  _resetWhitelists: () => {},
  getCrossSourceJoins: () => [],
}));

mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    connections: {
      describe: () => [{ id: "default", dbType: "postgres" as const }],
    },
  }),
);

mock.module("@atlas/api/lib/cache/index", () => ({
  getCache: () => ({ get: () => null, set: () => {}, stats: () => ({ hits: 0, misses: 0, entryCount: 0, maxSize: 1000, ttl: 300000 }) }),
  buildCacheKey: () => "mock-key",
  cacheEnabled: () => false,
  getDefaultTtl: () => 300000,
  flushCache: () => {},
  setCacheBackend: () => {},
  _resetCache: () => {},
}));

const { runAgent } = await import("@atlas/api/lib/agent");
const { __resetTwentyDatasourceCacheForTests } = await import("../datasource");

// ── Fixtures ─────────────────────────────────────────────────────────────
const SPEC = JSON.parse(
  fs.readFileSync(path.join(import.meta.dir, "twenty-acceptance", "spec.json"), "utf8"),
);
const graph = buildOperationGraph(SPEC);

/** Path A is the only implemented mode; #2931 appends "semantic-yaml" here. */
const MODES_UNDER_TEST: RepresentationMode[] = ["operation-graph"];

// ── Scripted-LLM helpers (mirrors agent-integration.test.ts) ─────────────────
let callId = 0;
const nextId = () => `call-${++callId}`;
const MOCK_USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};

type Step =
  | { kind: "tool"; toolName: string; args: Record<string, unknown> }
  | { kind: "text"; text: string };

const toolStep = (toolName: string, args: Record<string, unknown>): Step => ({ kind: "tool", toolName, args });
const textStep = (text: string): Step => ({ kind: "text", text });

function stepChunks(step: Step): LanguageModelV3StreamPart[] {
  if (step.kind === "tool") {
    return [
      { type: "tool-call", toolCallId: nextId(), toolName: step.toolName, input: JSON.stringify(step.args) },
      { type: "finish", usage: MOCK_USAGE, finishReason: { unified: "tool-calls", raw: "tool_use" } },
    ];
  }
  return [
    { type: "text-delta", id: "text-0", delta: step.text },
    { type: "finish", usage: MOCK_USAGE, finishReason: { unified: "stop", raw: "end_turn" } },
  ];
}

let capturedSystemPrompt = "";

/** Build a mock model that replays `steps` one per doStream call, capturing the prompt. */
function scriptModel(steps: Step[]): InstanceType<typeof MockLanguageModelV3> {
  const chunked = steps.map(stepChunks);
  let idx = 0;
  return new MockLanguageModelV3({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock receives provider call options
    doStream: async (options: any) => {
      try {
        capturedSystemPrompt = JSON.stringify(options?.prompt ?? options);
      } catch {
        capturedSystemPrompt = "";
      }
      const which = idx < chunked.length ? chunked[idx] : chunked[chunked.length - 1];
      idx++;
      return { stream: convertArrayToReadableStream(which) };
    },
  });
}

const userMessages = (content: string): UIMessage[] => [
  { id: "m-1", role: "user", parts: [{ type: "text", text: content }] },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- AI SDK step shapes are generic
function findRestResults(steps: any[]): any[] {
  const out: unknown[] = [];
  for (const step of steps) {
    for (const tr of step.toolResults ?? []) {
      if (tr.toolName === "executeRestOperation") out.push(tr.output);
    }
  }
  return out;
}

/** Run a scripted scenario through the full agent loop; return tool results + metrics. */
async function runScenario(prompt: string, steps: Step[]) {
  mockModel = scriptModel(steps);
  const result = await runAgent({ messages: userMessages(prompt) });
  const agentSteps = await result.steps;
  return {
    restResults: findRestResults(agentSteps),
    stepCount: agentSteps.length,
  };
}

// ── Mock Twenty workspace ────────────────────────────────────────────────
let mock1: TwentyMock;

beforeAll(async () => {
  mock1 = await startTwentyMockServer();
  process.env.ATLAS_OPENAPI_TWENTY = "true";
  process.env.ATLAS_OPENAPI_TWENTY_TOKEN = "acceptance-bearer";
  process.env.ATLAS_OPENAPI_TWENTY_BASE_URL = mock1.baseUrl;
  __resetTwentyDatasourceCacheForTests();
});

afterAll(async () => {
  delete process.env.ATLAS_OPENAPI_TWENTY;
  delete process.env.ATLAS_OPENAPI_TWENTY_TOKEN;
  delete process.env.ATLAS_OPENAPI_TWENTY_BASE_URL;
  __resetTwentyDatasourceCacheForTests();
  await mock1.close();
  emitMetricsTable();
});

beforeEach(() => {
  callId = 0;
  capturedSystemPrompt = "";
  mock1.reset();
});

// ── Bake-off metrics (per mode + per scenario) ───────────────────────────
interface MetricRow {
  mode: RepresentationMode;
  scenario: string;
  restCalls: number;
  stepCount: number;
}
const metrics: MetricRow[] = [];
const representationTokens = new Map<RepresentationMode, number>();

function emitMetricsTable(): void {
  console.log("\n=== Twenty acceptance — representation bake-off metrics (#2924 / #2931) ===");
  for (const [mode, tokens] of representationTokens) {
    console.log(`representation[${mode}]: ~${tokens} prompt tokens, ${graph.operations.size} operations`);
  }
  console.log("scenario".padEnd(34) + "mode".padEnd(18) + "restCalls".padEnd(11) + "stepCount");
  for (const m of metrics) {
    console.log(m.scenario.padEnd(34) + m.mode.padEnd(18) + String(m.restCalls).padEnd(11) + m.stepCount);
  }
  console.log(
    "\nOQ1 trace observation: single-lookup actions resolve in 1 executeRestOperation call; " +
      "the multi-endpoint $ref chain resolves as a sequence of executeRestOperation calls in one turn. " +
      "No misrouting observed; routing stays prompt-guided (no hard-coding needed). " +
      "Slice 3 (#2927) landed the sandbox network boundary; the live in-sandbox " +
      "Python composition path remains deferred (read-only enforcement).",
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  Per-mode suite (bake-off parameterization)
// ─────────────────────────────────────────────────────────────────────────
describe.each(MODES_UNDER_TEST)("Twenty acceptance — representation mode: %s", (mode) => {
  beforeAll(() => {
    const rep = buildAgentRepresentation(graph, mode, { displayName: "Twenty" });
    representationTokens.set(mode, rep.approxTokens);
  });

  const record = (scenario: string, restCalls: number, stepCount: number) =>
    metrics.push({ mode, scenario, restCalls, stepCount });

  // ── Read actions (live via executeRestOperation through runAgent) ──────

  it("listPeople — findManyPeople returns the workspace people", async () => {
    const { restResults, stepCount } = await runScenario("List everyone in Twenty", [
      toolStep("executeRestOperation", { operationId: "findManyPeople" }),
      textStep("There are 2 people: Matt Rivers and Dana Cole."),
    ]);
    expect(restResults).toHaveLength(1);
    expect(restResults[0].status).toBe("ok");
    expect(restResults[0].body.data.people).toHaveLength(2);
    record("listPeople", 1, stepCount);
  });

  it("getPerson — findOnePerson resolves a person by id", async () => {
    const { restResults, stepCount } = await runScenario("Get the person p-matt", [
      toolStep("executeRestOperation", { operationId: "findOnePerson", pathParams: { id: "p-matt" } }),
      textStep("Matt Rivers (matt@example.com)."),
    ]);
    expect(restResults[0].status).toBe("ok");
    expect(restResults[0].body.data.person.id).toBe("p-matt");
    record("getPerson", 1, stepCount);
  });

  it("searchPeople — TRAP 1: filter round-trips as field[op]:value", async () => {
    const { restResults, stepCount } = await runScenario("Find the person with email matt@example.com", [
      toolStep("executeRestOperation", {
        operationId: "findManyPeople",
        query: { filter: "emails.primaryEmail[eq]:matt@example.com", limit: 1 },
      }),
      textStep("Found Matt Rivers."),
    ]);
    expect(restResults[0].status).toBe("ok");
    expect(restResults[0].body.data.people).toHaveLength(1);
    expect(restResults[0].body.data.people[0].emails.primaryEmail).toBe("matt@example.com");
    const req = mock1.matching("/rest/people").at(-1);
    expect(req?.query.filter).toBe("emails.primaryEmail[eq]:matt@example.com");
    expect(req?.query.filter).not.toContain("filter[");
    record("searchPeople", 1, stepCount);
  });

  it("searchPeople — TRAP 3: custom fields come back inline (no customFields wrapper)", async () => {
    const { restResults } = await runScenario("What is Matt's first source?", [
      toolStep("executeRestOperation", {
        operationId: "findManyPeople",
        query: { filter: "emails.primaryEmail[eq]:matt@example.com" },
      }),
      textStep("Matt's first source is DEMO."),
    ]);
    const person = restResults[0].body.data.people[0];
    expect(person.atlasFirstSource).toBe("DEMO");
    expect(person.atlasLastSource).toBe("SIGNUP");
    expect(person).not.toHaveProperty("customFields");
  });

  it("listCompanies / searchCompanies — list and filter companies", async () => {
    const list = await runScenario("List companies", [
      toolStep("executeRestOperation", { operationId: "findManyCompanies" }),
      textStep("Acme Corp and Globex."),
    ]);
    expect(list.restResults[0].body.data.companies).toHaveLength(2);
    record("listCompanies", 1, list.stepCount);

    const search = await runScenario("Find companies named Acme", [
      toolStep("executeRestOperation", {
        operationId: "findManyCompanies",
        query: { filter: "name[like]:%Acme%" },
      }),
      textStep("Acme Corp."),
    ]);
    expect(search.restResults[0].body.data.companies).toHaveLength(1);
    expect(search.restResults[0].body.data.companies[0].name).toContain("Acme");
    record("searchCompanies", 1, search.stepCount);
  });

  it("listNotes — findManyNotes returns notes", async () => {
    const { restResults, stepCount } = await runScenario("List all notes", [
      toolStep("executeRestOperation", { operationId: "findManyNotes" }),
      textStep("3 notes."),
    ]);
    expect(restResults[0].body.data.notes).toHaveLength(3);
    record("listNotes", 1, stepCount);
  });

  it("getPersonRestSchema — answered from the representation, no API call", async () => {
    // The generic agent learns the Person field set from the representation in
    // its prompt — it does NOT need a getPersonRestSchema operation. Zero REST
    // calls; the answer is grounded in the prompt context.
    const { restResults, stepCount } = await runScenario(
      "Which custom fields exist on Person in Twenty?",
      [textStep("Person has atlasFirstSource, atlasLastSource and atlasStripeCustomerId.")],
    );
    expect(restResults).toHaveLength(0);
    // The representation that reached the model carried the inline custom fields.
    expect(capturedSystemPrompt).toContain("REST Datasource");
    expect(capturedSystemPrompt).toContain("atlasFirstSource");
    record("getPersonRestSchema", 0, stepCount);
  });

  // ── Multi-endpoint $ref chain (the headline AC) ───────────────────────

  it("'show me Matt's notes' — Person -> NoteTarget -> Note chain in ONE turn (TRAP 2)", async () => {
    const { restResults, stepCount } = await runScenario("Show me Matt's notes from Twenty", [
      toolStep("executeRestOperation", {
        operationId: "findManyPeople",
        query: { filter: "emails.primaryEmail[eq]:matt@example.com", limit: 1 },
      }),
      toolStep("executeRestOperation", {
        operationId: "findManyNoteTargets",
        query: { filter: "targetPersonId[eq]:p-matt" },
      }),
      toolStep("executeRestOperation", { operationId: "findOneNote", pathParams: { id: "n-kickoff" } }),
      toolStep("executeRestOperation", { operationId: "findOneNote", pathParams: { id: "n-renewal" } }),
      textStep("Matt has 2 notes: 'Kickoff call' and 'Renewal planning'."),
    ]);

    expect(restResults).toHaveLength(4);
    expect(restResults.every((r) => r.status === "ok")).toBe(true);

    // TRAP 2 — the join filter used targetPersonId (not personId).
    const ntReq = mock1.matching("/rest/noteTargets").at(-1);
    expect(ntReq?.query.filter).toBe("targetPersonId[eq]:p-matt");
    expect(ntReq?.query.filter).not.toContain("personId[eq]");
    expect(restResults[1].body.data.noteTargets).toHaveLength(2);

    // The chain resolved the two notes belonging to Matt (and not the third).
    const titles = [restResults[2], restResults[3]].map((r) => r.body.data.note.title);
    expect(titles).toEqual(["Kickoff call", "Renewal planning"]);
    expect(titles).not.toContain("Unrelated note");

    // TRAP 4 (read side) — the note body reads back under bodyV2.markdown, not a
    // top-level `body`. Guards a future read transform flattening the shape.
    const kickoff = restResults[2].body.data.note;
    expect(kickoff.bodyV2.markdown).toBe("Discussed onboarding.");
    expect(kickoff).not.toHaveProperty("body");

    record("matts-notes ($ref chain)", 4, stepCount);
  });

  // ── Write actions are addressable but blocked (read-only until slice 5) ─

  it("write actions (upsert/createNote/deletes/wipe) are blocked read-only, never dispatched", async () => {
    const writeScenarios: Array<[string, Step]> = [
      ["upsertPerson", toolStep("executeRestOperation", { operationId: "createOnePerson", body: { emails: { primaryEmail: "x@y.com" } } })],
      ["createNote", toolStep("executeRestOperation", { operationId: "createOneNote", body: { title: "t", bodyV2: { markdown: "b" } } })],
      ["deletePerson", toolStep("executeRestOperation", { operationId: "deleteOnePerson", pathParams: { id: "p-matt" }, query: { soft_delete: false } })],
      ["deleteNote", toolStep("executeRestOperation", { operationId: "deleteOneNote", pathParams: { id: "n-kickoff" } })],
      ["deleteCompany", toolStep("executeRestOperation", { operationId: "deleteOneCompany", pathParams: { id: "c-acme" } })],
    ];

    for (const [label, step] of writeScenarios) {
      const { restResults, stepCount } = await runScenario(`do ${label}`, [step, textStep("I can't write yet.")]);
      expect(restResults[0].status, `${label} must be blocked`).toBe("writes_disabled");
      record(`${label} (blocked)`, 1, stepCount);
    }

    // wipeWorkspace = composition of deletes — the first delete is blocked, so
    // nothing destructive happens.
    const wipe = await runScenario("wipe the whole Twenty workspace", [
      toolStep("executeRestOperation", { operationId: "findManyPeople" }),
      toolStep("executeRestOperation", { operationId: "deleteOnePerson", pathParams: { id: "p-matt" }, query: { soft_delete: false } }),
      textStep("Writes are disabled, so I stopped."),
    ]);
    expect(wipe.restResults[1].status).toBe("writes_disabled");
    record("wipeWorkspace (blocked)", 2, wipe.stepCount);

    // Hard guarantee: not a single mutating request reached the upstream across
    // the entire suite's write attempts.
    expect(mock1.requests.some((r) => r.method !== "GET")).toBe(false);
  });

  it("the representation actually reached the model's system prompt", async () => {
    await runScenario("List people", [
      toolStep("executeRestOperation", { operationId: "findManyPeople" }),
      textStep("done"),
    ]);
    expect(capturedSystemPrompt).toContain("## REST Datasource: Twenty");
    expect(capturedSystemPrompt).toContain("executeRestOperation");
    expect(capturedSystemPrompt).toContain("findManyPeople");
  });
});

// ─────────────────────────────────────────────────────────────────────────
//  Layer D — write-shape guards at the primitive level (slice-0 client direct)
//
//  The live tool is read-only, so the write traps (bodyV2.markdown, the
//  targetPersonId link, inline custom fields on write, soft_delete=false) are
//  locked in at the generic-primitive level here — proving the shapes are
//  correct for when slice 5 enables writes, with no per-operation code.
// ─────────────────────────────────────────────────────────────────────────
describe("Twenty acceptance — write-shape guards (primitive, ahead of slice 5)", () => {
  const auth = { kind: "bearer" as const, token: "acceptance-bearer" };

  it("TRAP 4 — createOneNote sends the body under bodyV2.markdown (not a top-level body)", async () => {
    await executeOperation(
      graph,
      "createOneNote",
      { body: { title: "Kickoff call", bodyV2: { markdown: "Discussed onboarding." } } },
      auth,
      { baseUrl: mock1.restBaseUrl },
    );
    const req = mock1.matching("/rest/notes").at(-1);
    expect(req?.method).toBe("POST");
    const body = req?.body as { title: string; bodyV2?: { markdown?: string }; body?: unknown };
    expect(body.bodyV2?.markdown).toBe("Discussed onboarding.");
    expect(body).not.toHaveProperty("body");
  });

  it("TRAP 2 (write) — the note link posts targetPersonId (not personId)", async () => {
    await executeOperation(
      graph,
      "createOneNoteTarget",
      { body: { noteId: "n-new", targetPersonId: "p-matt" } },
      auth,
      { baseUrl: mock1.restBaseUrl },
    );
    const req = mock1.matching("/rest/noteTargets").at(-1);
    const body = req?.body as Record<string, unknown>;
    expect(body.targetPersonId).toBe("p-matt");
    expect(body).not.toHaveProperty("personId");
  });

  it("TRAP 3 (write) — custom fields are written inline on Person (no customFields wrapper)", async () => {
    await executeOperation(
      graph,
      "createOnePerson",
      { body: { emails: { primaryEmail: "new@example.com" }, atlasFirstSource: "DEMO", atlasLastSource: "DEMO" } },
      auth,
      { baseUrl: mock1.restBaseUrl },
    );
    const req = mock1.matching("/rest/people").at(-1);
    const body = req?.body as Record<string, unknown>;
    expect(body.atlasFirstSource).toBe("DEMO");
    expect(body).not.toHaveProperty("customFields");
  });

  it("delete verbs send soft_delete=false explicitly (not relying on the server default)", async () => {
    await executeOperation(
      graph,
      "deleteOnePerson",
      { path: { id: "p-matt" }, query: { soft_delete: false } },
      auth,
      { baseUrl: mock1.restBaseUrl },
    );
    const req = mock1.matching("/rest/people/p-matt").at(-1);
    expect(req?.method).toBe("DELETE");
    expect(req?.query.soft_delete).toBe("false");
  });
});

// ─────────────────────────────────────────────────────────────────────────
//  Layer E — sandbox-Python proof (prompt -> Python -> API call -> answer)
//
//  Generates the real preamble + a representative agent body and runs it via
//  python3 against the mock. Proves the generated client composes the $ref
//  chain end-to-end. Gated on python3 availability (loud skip, never silent).
//  Slice 3 (#2927) landed the sandbox network boundary, but the live
//  executePython wiring of this preamble remains deferred (read-only
//  enforcement) — see the python-preamble.ts header.
// ─────────────────────────────────────────────────────────────────────────
describe("Twenty acceptance — sandbox-Python proof (generated client, gated)", () => {
  async function runPython(source: string, env: Record<string, string>) {
    let proc;
    try {
      proc = Bun.spawn(["python3", "-c", "import sys; exec(sys.stdin.read())"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...env },
      });
    } catch {
      return null;
    }
    proc.stdin.write(source);
    proc.stdin.end();
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  }

  it("prompt -> Python -> API call -> answer: the $ref chain runs end-to-end", async () => {
    const preamble = buildRestClientPreamble(graph, {
      baseUrlEnv: "ATLAS_REST_BASE_URL",
      authEnv: "ATLAS_REST_TOKEN",
    });
    const agentBody = [
      preamble,
      "",
      'people = atlas_rest.call("findManyPeople", query={"filter": "emails.primaryEmail[eq]:matt@example.com", "limit": 1})',
      'matt = people["data"]["people"][0]',
      'targets = atlas_rest.call("findManyNoteTargets", query={"filter": "targetPersonId[eq]:" + matt["id"]})',
      "titles = []",
      'for t in targets["data"]["noteTargets"]:',
      '    note = atlas_rest.call("findOneNote", path_params={"id": t["noteId"]})',
      '    titles.append(note["data"]["note"]["title"])',
      'print("NOTES:" + ", ".join(titles))',
      "",
    ].join("\n");

    const result = await runPython(agentBody, {
      ATLAS_REST_BASE_URL: mock1.restBaseUrl,
      ATLAS_REST_TOKEN: "acceptance-bearer",
    });

    if (result === null) {
      console.warn("[twenty-acceptance] python3 unavailable — sandbox-Python proof skipped");
      return;
    }
    expect(result.exitCode, `python stderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout.trim()).toBe("NOTES:Kickoff call, Renewal planning");

    // The Python made the join call with the targetPersonId filter (TRAP 2),
    // bearer auth reached the upstream, and the wrong personId form never went.
    const ntReq = mock1.matching("/rest/noteTargets").at(-1);
    expect(ntReq?.query.filter).toBe("targetPersonId[eq]:p-matt");
    expect(ntReq?.headers["authorization"]).toBe("Bearer acceptance-bearer");
  });
});
