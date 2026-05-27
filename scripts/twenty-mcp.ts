#!/usr/bin/env bun
/**
 * Internal-tools Twenty CRM MCP server. Exposes the in-repo
 * TwentyClient over stdio for local Claude Code sessions.
 *
 * Setup:
 *   claude mcp add --scope user twenty-crm \
 *     --env TWENTY_API_KEY="$TWENTY_API_KEY" \
 *     --env TWENTY_BASE_URL=https://crm.useatlas.dev \
 *     -- bun /path/to/atlas/scripts/twenty-mcp.ts
 *
 * Logging contract: stdout is reserved for JSON-RPC. All diagnostic
 * messages go to stderr so they don't corrupt the protocol stream.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  upsertPerson,
  createNote,
  listPeople,
  getPerson,
  searchPeople,
  listNotes,
  listCompanies,
  searchCompanies,
  deletePerson,
  deleteNote,
  deleteCompany,
  wipeWorkspace,
  getPersonRestSchema,
  TwentyClientError,
  type TwentyClientConfig,
} from "../plugins/twenty/src/client.js";
import type { AtlasEventSource } from "../plugins/twenty/src/lead-normalizer.js";

const SERVER_NAME = "atlas-twenty-mcp";
const SERVER_VERSION = "0.1.0";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim().length === 0) {
    process.stderr.write(
      `[atlas-twenty-mcp] Missing required env: ${name}. Aborting.\n`,
    );
    process.exit(1);
  }
  return v;
}

const config: TwentyClientConfig = {
  apiKey: requireEnv("TWENTY_API_KEY"),
  baseUrl: requireEnv("TWENTY_BASE_URL"),
};

function ok(payload: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function err(message: string, extras?: Record<string, unknown>): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: message, ...extras }, null, 2),
      },
    ],
    isError: true,
  };
}

async function run<T>(
  toolName: string,
  fn: () => Promise<T>,
): Promise<CallToolResult> {
  try {
    const result = await fn();
    return ok(result === undefined ? { ok: true } : result);
  } catch (e) {
    if (e instanceof TwentyClientError) {
      return err(`${toolName}: ${e.message}`, {
        status: e.status,
        operation: e.operation,
        upstreamCode: e.upstreamCode,
        retryAfterMs: e.retryAfterMs,
        // Preserve orphanedNoteId on createNote partial failures so the
        // operator can clean up the unlinked note manually.
        ...(e.orphanedNoteId !== undefined && { orphanedNoteId: e.orphanedNoteId }),
      });
    }
    return err(`${toolName}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const eventSourceSchema = z.enum([
  "DEMO",
  "SIGNUP",
  "SALES_FORM",
  "CONVERSION",
  "OTHER",
]);
// Fail the build if the Zod enum drifts from the TS union exported by
// lead-normalizer — the two are parallel definitions and would otherwise
// silently disagree.
type _EventSourceDriftCheck = z.infer<typeof eventSourceSchema> extends AtlasEventSource
  ? AtlasEventSource extends z.infer<typeof eventSourceSchema>
    ? true
    : never
  : never;
const _eventSourceDriftCheck: _EventSourceDriftCheck = true;
void _eventSourceDriftCheck;

const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

server.registerTool(
  "listPeople",
  {
    description:
      "List Twenty People records. Returns the full upstream record shape including Atlas custom fields (atlasFirstSource, atlasLastSource, atlasIp, atlasStripeCustomerId). Optional pagination via limit + starting_after cursor (use the last record's id from a previous page).",
    inputSchema: {
      limit: z.number().int().positive().optional(),
      startingAfter: z.string().optional(),
      endingBefore: z.string().optional(),
    },
  },
  async (args) => run("listPeople", () => listPeople(config, args)),
);

server.registerTool(
  "getPerson",
  {
    description:
      "Fetch a single Twenty Person by id. Returns the full record (including Atlas custom fields). Returns null when the id doesn't exist.",
    inputSchema: { id: z.string().min(1) },
  },
  async ({ id }) =>
    run("getPerson", async () => (await getPerson(config, id)) ?? null),
);

server.registerTool(
  "searchPeople",
  {
    description:
      "Search Twenty People by email (exact match) and/or nameLike (substring on firstName OR lastName). Uses Twenty's documented filter syntax field[op]:value. At least one of email or nameLike is required.",
    inputSchema: {
      email: z.string().optional(),
      nameLike: z.string().optional(),
      limit: z.number().int().positive().optional(),
    },
  },
  async (args) => run("searchPeople", () => searchPeople(config, args)),
);

server.registerTool(
  "listCompanies",
  {
    description:
      "List Twenty Company records with optional pagination. Returns full upstream shape (name, domainName, employees, annualRecurringRevenue, etc.).",
    inputSchema: {
      limit: z.number().int().positive().optional(),
      startingAfter: z.string().optional(),
      endingBefore: z.string().optional(),
    },
  },
  async (args) => run("listCompanies", () => listCompanies(config, args)),
);

server.registerTool(
  "searchCompanies",
  {
    description:
      "Search Twenty Companies by nameLike and/or domainLike (substring match). Uses Twenty's field[op]:value filter syntax.",
    inputSchema: {
      nameLike: z.string().optional(),
      domainLike: z.string().optional(),
      limit: z.number().int().positive().optional(),
    },
  },
  async (args) => run("searchCompanies", () => searchCompanies(config, args)),
);

server.registerTool(
  "listNotes",
  {
    description:
      "List Twenty Note records with optional pagination. Notes are linked to People via noteTargets (targetPersonId).",
    inputSchema: {
      limit: z.number().int().positive().optional(),
      startingAfter: z.string().optional(),
      endingBefore: z.string().optional(),
    },
  },
  async (args) => run("listNotes", () => listNotes(config, args)),
);

server.registerTool(
  "getPersonRestSchema",
  {
    description:
      "Fetch the Twenty workspace's Person schema by parsing /rest/open-api/core. Returns the full property name set — the authoritative answer to 'which Atlas custom fields exist on this workspace'. Use when debugging field-missing errors.",
    inputSchema: {},
  },
  async () =>
    run("getPersonRestSchema", async () => {
      const { fields } = await getPersonRestSchema(config);
      return { fields: Array.from(fields).sort() };
    }),
);

server.registerTool(
  "upsertPerson",
  {
    description:
      "Upsert a Twenty Person by email. Preserves atlasFirstSource (sticky after first set) and updates atlasLastSource on every call. Matches the production SaaS CRM pipeline behavior (ee/src/saas-crm/) exactly — uses the same TwentyClient.",
    inputSchema: {
      email: z.string().email(),
      eventSource: eventSourceSchema,
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      atlasIp: z.string().optional(),
      atlasStripeCustomerId: z.string().optional(),
    },
  },
  async ({ email, eventSource, firstName, lastName, atlasIp, atlasStripeCustomerId }) =>
    run("upsertPerson", () =>
      upsertPerson(config, {
        email,
        eventSource,
        ...(firstName || lastName ? { name: { firstName, lastName } } : {}),
        customFields: {
          ...(atlasIp && { atlasIp }),
          ...(atlasStripeCustomerId && { atlasStripeCustomerId }),
        },
      }),
    ),
);

server.registerTool(
  "createNote",
  {
    description:
      "Create a Note in Twenty and link it to a Person via NoteTarget (two-step: POST /rest/notes then POST /rest/noteTargets). Body is stored as markdown under bodyV2.markdown.",
    inputSchema: {
      personId: z.string().min(1),
      title: z.string().min(1),
      body: z.string(),
    },
  },
  async (args) => run("createNote", () => createNote(config, args)),
);

// HARD DELETE by default — soft-deleted records still trip Twenty's
// server-side duplicate detection on upsertPerson, so cleanup paths need
// hard delete to actually free the email for re-creation.

server.registerTool(
  "deletePerson",
  {
    description:
      "Hard-delete a Twenty Person by id (?soft_delete=false). 404 is treated as idempotent. Pass softDelete:true to soft-delete instead — but note that soft-deleted records still block upsertPerson duplicate detection.",
    inputSchema: {
      id: z.string().min(1),
      softDelete: z.boolean().optional(),
    },
  },
  async ({ id, softDelete }) =>
    run("deletePerson", () =>
      deletePerson(config, id, softDelete !== undefined ? { softDelete } : undefined),
    ),
);

server.registerTool(
  "deleteNote",
  {
    description:
      "Hard-delete a Twenty Note by id (?soft_delete=false). 404 is treated as idempotent.",
    inputSchema: {
      id: z.string().min(1),
      softDelete: z.boolean().optional(),
    },
  },
  async ({ id, softDelete }) =>
    run("deleteNote", () =>
      deleteNote(config, id, softDelete !== undefined ? { softDelete } : undefined),
    ),
);

server.registerTool(
  "deleteCompany",
  {
    description:
      "Hard-delete a Twenty Company by id (?soft_delete=false). 404 is treated as idempotent.",
    inputSchema: {
      id: z.string().min(1),
      softDelete: z.boolean().optional(),
    },
  },
  async ({ id, softDelete }) =>
    run("deleteCompany", () =>
      deleteCompany(config, id, softDelete !== undefined ? { softDelete } : undefined),
    ),
);

server.registerTool(
  "wipeWorkspace",
  {
    description:
      "DESTRUCTIVE — hard-delete every Note, Person, and Company in the Twenty workspace. Defaults to dryRun:true (one sampled page per object type, no deletes). Pass dryRun:false to actually delete. Capped per-object-type at maxRecords (default 10000) — `truncated.{notes,people,companies}` flags which drains hit the cap; live runs surface per-record delete failures in `errors`.",
    inputSchema: {
      dryRun: z.boolean().optional(),
      pageLimit: z.number().int().positive().optional(),
      maxRecords: z.number().int().positive().optional(),
    },
  },
  async ({ dryRun, pageLimit, maxRecords }) =>
    run("wipeWorkspace", () =>
      wipeWorkspace(config, {
        ...(dryRun !== undefined && { dryRun }),
        ...(pageLimit !== undefined && { pageLimit }),
        ...(maxRecords !== undefined && { maxRecords }),
      }),
    ),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await server.close();
    } catch (e) {
      process.stderr.write(
        `[atlas-twenty-mcp] Error closing server: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  process.stderr.write(
    `[atlas-twenty-mcp] ${SERVER_NAME}@${SERVER_VERSION} running on stdio (base=${config.baseUrl})\n`,
  );
}

main().catch((e) => {
  process.stderr.write(
    `[atlas-twenty-mcp] Fatal: ${e instanceof Error ? e.message : String(e)}\n`,
  );
  if (e instanceof Error && e.stack) {
    process.stderr.write(`${e.stack}\n`);
  }
  process.exit(1);
});
