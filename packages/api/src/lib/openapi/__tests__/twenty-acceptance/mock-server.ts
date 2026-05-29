/**
 * In-process Twenty REST mock for the slice-1 acceptance suite (#2924).
 *
 * Serves the same OpenAPI spec (`/rest/open-api/core`) and data endpoints
 * (`/rest/people`, `/rest/notes`, `/rest/noteTargets`, `/rest/companies`, …)
 * as a real Twenty workspace, with response SHAPES captured from real Twenty
 * responses during the PR #2867 Twenty-MCP work (`{ data: { people: [...] } }`,
 * `{ data: { person: {...} } }`, custom fields INLINE on Person, note bodies
 * under `bodyV2.markdown`). The server actually HONORS the `field[op]:value`
 * filter syntax, so the four traps the suite locks in are *executed*: a wrong
 * filter shape returns the unfiltered list / no match, and the downstream
 * answer assertion fails — exactly as it would against real Twenty.
 *
 * Every request is captured for assertions. The mock is read+write capable
 * (writes are exercised at the primitive level even though the live tool is
 * read-only in slice 1).
 */
import * as fs from "fs";
import * as http from "http";
import { type AddressInfo } from "net";
import * as path from "path";

const SPEC_TEXT = fs.readFileSync(path.join(import.meta.dir, "spec.json"), "utf8");

export interface CapturedRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string>;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: unknown;
}

// ── Seed data (real Twenty record shapes — custom fields inline on Person) ──

interface SeedPerson {
  id: string;
  name: { firstName: string; lastName: string };
  emails: { primaryEmail: string; additionalEmails: string[] };
  atlasFirstSource: string;
  atlasLastSource: string;
}
interface SeedNote {
  id: string;
  title: string;
  bodyV2: { markdown: string };
  createdAt: string;
}
interface SeedNoteTarget {
  id: string;
  noteId: string;
  targetPersonId: string;
}
interface SeedCompany {
  id: string;
  name: string;
  domainName: { primaryLinkUrl: string };
  employees: number;
}

function seed(): {
  people: SeedPerson[];
  notes: SeedNote[];
  noteTargets: SeedNoteTarget[];
  companies: SeedCompany[];
} {
  return {
    people: [
      {
        id: "p-matt",
        name: { firstName: "Matt", lastName: "Rivers" },
        emails: { primaryEmail: "matt@example.com", additionalEmails: [] },
        atlasFirstSource: "DEMO",
        atlasLastSource: "SIGNUP",
      },
      {
        id: "p-dana",
        name: { firstName: "Dana", lastName: "Cole" },
        emails: { primaryEmail: "dana@acme.com", additionalEmails: [] },
        atlasFirstSource: "SALES_FORM",
        atlasLastSource: "SALES_FORM",
      },
    ],
    notes: [
      { id: "n-kickoff", title: "Kickoff call", bodyV2: { markdown: "Discussed onboarding." }, createdAt: "2026-05-01T10:00:00Z" },
      { id: "n-renewal", title: "Renewal planning", bodyV2: { markdown: "Renews in Q3." }, createdAt: "2026-05-10T10:00:00Z" },
      { id: "n-other", title: "Unrelated note", bodyV2: { markdown: "Not Matt's." }, createdAt: "2026-05-12T10:00:00Z" },
    ],
    noteTargets: [
      { id: "nt-1", noteId: "n-kickoff", targetPersonId: "p-matt" },
      { id: "nt-2", noteId: "n-renewal", targetPersonId: "p-matt" },
      { id: "nt-3", noteId: "n-other", targetPersonId: "p-dana" },
    ],
    companies: [
      { id: "c-acme", name: "Acme Corp", domainName: { primaryLinkUrl: "acme.com" }, employees: 200 },
      { id: "c-globex", name: "Globex", domainName: { primaryLinkUrl: "globex.com" }, employees: 50 },
    ],
  };
}

/** Parse one `field[op]:value` filter clause. Returns null when the shape is wrong. */
function parseFilterClause(filter: string | undefined): { field: string; op: string; value: string } | null {
  if (!filter) return null;
  // field[op]:value — brackets + colon literal (Twenty's documented form).
  const m = /^([a-zA-Z0-9_.]+)\[([a-zA-Z]+)\]:(.*)$/.exec(filter);
  if (!m) return null;
  return { field: m[1], op: m[2], value: m[3] };
}

export interface TwentyMock {
  readonly baseUrl: string;
  /** Operations base (`{baseUrl}/rest`). */
  readonly restBaseUrl: string;
  readonly requests: CapturedRequest[];
  reset(): void;
  close(): Promise<void>;
  /** All captured requests whose path ends with `suffix`. */
  matching(suffix: string): CapturedRequest[];
}

export async function startTwentyMockServer(): Promise<TwentyMock> {
  const requests: CapturedRequest[] = [];
  const data = seed();

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const parsed = new URL(req.url ?? "", "http://mock");
      const query: Record<string, string> = {};
      parsed.searchParams.forEach((v, k) => {
        query[k] = v;
      });
      let body: unknown = null;
      if (rawBody.length > 0) {
        try {
          body = JSON.parse(rawBody);
        } catch {
          body = rawBody;
        }
      }
      requests.push({
        method: req.method ?? "",
        path: parsed.pathname,
        query,
        headers: req.headers,
        body,
      });
      route(req.method ?? "GET", parsed.pathname, query, body, res, data);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
    restBaseUrl: `${baseUrl}/rest`,
    requests,
    reset: () => {
      requests.length = 0;
    },
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
    matching: (suffix: string) => requests.filter((r) => r.path.endsWith(suffix)),
  };
}

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function route(
  method: string,
  pathname: string,
  query: Record<string, string>,
  body: unknown,
  res: http.ServerResponse,
  data: ReturnType<typeof seed>,
): void {
  // Spec probe.
  if (pathname === "/rest/open-api/core") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(SPEC_TEXT);
    return;
  }

  // ── People ────────────────────────────────────────────────────────
  if (pathname === "/rest/people" && method === "GET") {
    const clause = parseFilterClause(query.filter);
    if (clause && clause.field === "emails.primaryEmail" && clause.op === "eq") {
      const match = data.people.filter((p) => p.emails.primaryEmail === clause.value);
      return json(res, 200, { data: { people: match } });
    }
    // No (recognized) filter → unfiltered list, exactly like Twenty when the
    // wrong filter form is sent.
    return json(res, 200, { data: { people: data.people } });
  }
  if (pathname === "/rest/people" && method === "POST") {
    const created = { id: "p-new", ...(body as object) };
    return json(res, 201, { data: { createPerson: created } });
  }
  const personId = matchPath(pathname, "/rest/people/");
  if (personId) {
    if (method === "GET") {
      const person = data.people.find((p) => p.id === personId);
      return person ? json(res, 200, { data: { person } }) : json(res, 404, { error: "not found" });
    }
    if (method === "PATCH") {
      const existing = data.people.find((p) => p.id === personId) ?? { id: personId };
      return json(res, 200, { data: { updatePerson: { ...existing, ...(body as object) } } });
    }
    if (method === "DELETE") {
      return json(res, 200, { data: { deletePerson: { id: personId } } });
    }
  }

  // ── Notes ─────────────────────────────────────────────────────────
  if (pathname === "/rest/notes" && method === "GET") {
    return json(res, 200, { data: { notes: data.notes } });
  }
  if (pathname === "/rest/notes" && method === "POST") {
    return json(res, 201, { data: { createNote: { id: "n-new" } } });
  }
  const noteId = matchPath(pathname, "/rest/notes/");
  if (noteId) {
    if (method === "GET") {
      const note = data.notes.find((n) => n.id === noteId);
      return note ? json(res, 200, { data: { note } }) : json(res, 404, { error: "not found" });
    }
    if (method === "DELETE") {
      return json(res, 200, { data: { deleteNote: { id: noteId } } });
    }
  }

  // ── NoteTargets ───────────────────────────────────────────────────
  if (pathname === "/rest/noteTargets" && method === "GET") {
    const clause = parseFilterClause(query.filter);
    if (clause && clause.field === "targetPersonId" && clause.op === "eq") {
      const match = data.noteTargets.filter((t) => t.targetPersonId === clause.value);
      return json(res, 200, { data: { noteTargets: match } });
    }
    return json(res, 200, { data: { noteTargets: data.noteTargets } });
  }
  if (pathname === "/rest/noteTargets" && method === "POST") {
    return json(res, 201, { data: { createNoteTarget: { id: "nt-new" } } });
  }

  // ── Companies ─────────────────────────────────────────────────────
  if (pathname === "/rest/companies" && method === "GET") {
    const clause = parseFilterClause(query.filter);
    if (clause && clause.field === "name" && clause.op === "like") {
      const needle = clause.value.replace(/%/g, "").toLowerCase();
      const match = data.companies.filter((c) => c.name.toLowerCase().includes(needle));
      return json(res, 200, { data: { companies: match } });
    }
    return json(res, 200, { data: { companies: data.companies } });
  }
  const companyId = matchPath(pathname, "/rest/companies/");
  if (companyId && method === "DELETE") {
    return json(res, 200, { data: { deleteCompany: { id: companyId } } });
  }

  json(res, 404, { error: `unhandled ${method} ${pathname}` });
}

/** Return the trailing id segment when `pathname` is `prefix{id}` (single segment). */
function matchPath(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  if (rest.length === 0 || rest.includes("/")) return null;
  return decodeURIComponent(rest);
}
