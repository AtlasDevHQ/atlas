/**
 * TwentyAdmin — narrow interface the smoke-crm CLI uses to read / wipe a
 * Twenty workspace. Delegates to `@useatlas/twenty/client` for everything
 * the client surface exposes; Note → Person attribution is implemented
 * inline against Twenty's `/rest/noteTargets` endpoint (see the block
 * comment above `listAllNoteTargetsRaw` below).
 *
 * Why this layer exists at all:
 *  - Lets the CLI handler hold a single `TwentyAdmin` value and remain
 *    unit-testable with a fake.
 *  - Adapts the client's pagination + Person-attribution semantics to the
 *    `ObservedPerson` / `ObservedNote` shapes the diff reporter consumes,
 *    so the diff code never sees raw Twenty types.
 */
import {
  deleteNote,
  deletePerson,
  listNotes,
  listPeople,
  wipeWorkspace,
  type TwentyClientConfig,
  type TwentyNoteFull,
  type TwentyPerson,
  type WipeWorkspaceResult,
} from "@useatlas/twenty/client";

import type { ObservedNote, ObservedPerson } from "./diff";

/**
 * Soft cap on records VISITED per object type during enumeration. Bounds
 * both `out.length` and the page iteration count (`pages * PAGE_LIMIT`)
 * so that a workspace with many rows we filter out (e.g. emailless
 * Persons skipped by `listAllPeoplePaged`) still hits the cap before
 * ddosing Twenty. Smoke runs operate on workspaces with at most a few
 * hundred records (the default fixture is 10 personas); the cap exists
 * to bound the blast radius of a runaway pagination bug.
 */
export const SMOKE_MAX_RECORDS_PER_TYPE = 1_000;
const PAGE_LIMIT = 60;
const MAX_PAGES = Math.ceil(SMOKE_MAX_RECORDS_PER_TYPE / PAGE_LIMIT) + 1;

export interface TwentyAdmin {
  /**
   * List every Person in the workspace. Paginates via Twenty's
   * `starting_after` cursor; bounded by `SMOKE_MAX_RECORDS_PER_TYPE`.
   */
  listAllPeople(): Promise<ObservedPerson[]>;

  /**
   * List every Note in the workspace, joined to its target Person's
   * email via the NoteTarget link table. Notes whose target Person isn't
   * in the workspace (orphans) appear with `personEmail = null`.
   */
  listAllNotes(): Promise<ObservedNote[]>;

  /** Hard-delete a Person by id. */
  deletePerson(id: string): Promise<void>;

  /** Hard-delete a Note by id. */
  deleteNote(id: string): Promise<void>;

  /**
   * Drain every Person, Note, and Company in the workspace via the
   * client's `wipeWorkspace`. Returns the result struct so the caller
   * can log per-object-type deletion counts.
   */
  wipeWorkspace(opts?: { readonly dryRun?: boolean }): Promise<WipeWorkspaceResult>;
}

/**
 * Build a live `TwentyAdmin` against the supplied Twenty workspace config.
 * The returned object holds no state — each call is a fresh REST round
 * trip.
 */
export function createTwentyAdmin(config: TwentyClientConfig): TwentyAdmin {
  return {
    listAllPeople: () => listAllPeoplePaged(config),
    listAllNotes: () => listAllNotesWithPersonEmail(config),
    deletePerson: (id) => deletePerson(config, id),
    deleteNote: (id) => deleteNote(config, id),
    wipeWorkspace: (opts) =>
      wipeWorkspace(config, {
        dryRun: opts?.dryRun ?? false,
        pageLimit: PAGE_LIMIT,
        maxRecords: SMOKE_MAX_RECORDS_PER_TYPE * 3,
      }),
  };
}

// ─────────────────────────────────────────────────────────────────────
//  Pagination — Person + Note
// ─────────────────────────────────────────────────────────────────────

async function listAllPeoplePaged(config: TwentyClientConfig): Promise<ObservedPerson[]> {
  const out: ObservedPerson[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < MAX_PAGES && out.length < SMOKE_MAX_RECORDS_PER_TYPE; pages++) {
    const page: TwentyPerson[] = await listPeople(config, {
      limit: PAGE_LIMIT,
      startingAfter: cursor,
    });
    for (const p of page) {
      if (!p.id) continue;
      const email = p.emails?.primaryEmail;
      if (!email) continue;
      out.push({
        id: p.id,
        email,
        atlasFirstSource: p.atlasFirstSource,
        atlasLastSource: p.atlasLastSource,
        atlasIp: p.atlasIp,
        atlasStripeCustomerId: p.atlasStripeCustomerId,
        ...(p.name ? { name: p.name } : {}),
      });
    }
    if (page.length < PAGE_LIMIT) break;
    const last = page[page.length - 1];
    if (!last?.id) break;
    cursor = last.id;
  }
  return out;
}

async function listAllNotesPaged(config: TwentyClientConfig): Promise<TwentyNoteFull[]> {
  const out: TwentyNoteFull[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < MAX_PAGES && out.length < SMOKE_MAX_RECORDS_PER_TYPE; pages++) {
    const page: TwentyNoteFull[] = await listNotes(config, {
      limit: PAGE_LIMIT,
      startingAfter: cursor,
    });
    out.push(...page);
    if (page.length < PAGE_LIMIT) break;
    const last = page[page.length - 1];
    if (!last?.id) break;
    cursor = last.id;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
//  Note → Person attribution via inline /rest/noteTargets fetch
//
//  #2867 ships listPeople / listNotes but not a noteTargets list verb.
//  We need the Note → Person join for the diff to catch #2865-shaped
//  regressions (all Notes piling onto one Person). This is a thin direct
//  fetch against Twenty's documented `/rest/noteTargets` endpoint —
//  replace with a client export when one lands.
// ─────────────────────────────────────────────────────────────────────

interface TwentyNoteTarget {
  readonly id?: string;
  readonly noteId?: string;
  readonly targetPersonId?: string;
}

async function listAllNoteTargetsRaw(
  config: TwentyClientConfig,
): Promise<TwentyNoteTarget[]> {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const out: TwentyNoteTarget[] = [];
  let cursor: string | undefined;
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  for (let pages = 0; pages < MAX_PAGES && out.length < SMOKE_MAX_RECORDS_PER_TYPE; pages++) {
    const qs = new URLSearchParams({ limit: String(PAGE_LIMIT) });
    if (cursor) qs.set("starting_after", cursor);
    const url = `${baseUrl}/rest/noteTargets?${qs.toString()}`;
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(config.timeoutMs ?? 10_000),
    });
    if (!response.ok) {
      throw new Error(
        `[smoke-crm] listAllNoteTargets failed: HTTP ${response.status} from ${url}`,
      );
    }
    const body = (await response.json()) as {
      data?: { noteTargets?: TwentyNoteTarget[] };
    };
    const page = body.data?.noteTargets ?? [];
    out.push(...page);
    if (page.length < PAGE_LIMIT) break;
    const last = page[page.length - 1];
    if (!last?.id) break;
    cursor = last.id;
  }
  return out;
}

async function listAllNotesWithPersonEmail(
  config: TwentyClientConfig,
): Promise<ObservedNote[]> {
  // Fetch all three in parallel — they're independent reads.
  const [notes, targets, people] = await Promise.all([
    listAllNotesPaged(config),
    listAllNoteTargetsRaw(config),
    listAllPeoplePaged(config),
  ]);
  const emailByPersonId = new Map<string, string>();
  for (const p of people) emailByPersonId.set(p.id, p.email);
  // Build noteId → personEmail (first link wins — Notes typically have one target).
  const emailByNoteId = new Map<string, string>();
  for (const t of targets) {
    if (!t.noteId || !t.targetPersonId) continue;
    if (emailByNoteId.has(t.noteId)) continue;
    const email = emailByPersonId.get(t.targetPersonId);
    if (email) emailByNoteId.set(t.noteId, email);
  }
  const out: ObservedNote[] = [];
  for (const n of notes) {
    if (!n.id) continue;
    out.push({
      id: n.id,
      title: n.title ?? "",
      body: n.bodyV2?.markdown ?? "",
      personEmail: emailByNoteId.get(n.id) ?? null,
    });
  }
  return out;
}
