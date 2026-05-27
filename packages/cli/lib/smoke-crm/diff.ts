/**
 * Expected/observed state model + diff for the CRM smoke-test.
 *
 * The shape mirrors the manual repro in PR #2865's comment thread:
 *   - N distinct personas (collapsed by email) → N distinct Twenty Persons
 *   - First persona's eventSource → `atlasFirstSource` (sticky)
 *   - Last persona's eventSource → `atlasLastSource`
 *   - Each sales-form persona → one Note on the matching Person
 *
 * The diff is pure — input/output only — so the tests can exercise every
 * branch without touching the network. The CLI's exit code is derived from
 * `isClean(diff)`.
 */

import {
  normalizeLead,
  type AtlasEventSource,
  type AtlasLeadEvent,
  type NormalizedNote,
} from "@useatlas/twenty/lead-normalizer";

/** Expected end-state of a single Twenty Person after all dispatches. */
export interface ExpectedPerson {
  /** Lowercased email — Twenty matches on this. */
  readonly email: string;
  readonly atlasFirstSource: AtlasEventSource;
  readonly atlasLastSource: AtlasEventSource;
  /** Optional standard fields the dispatcher may have written. */
  readonly name?: { firstName?: string; lastName?: string };
  readonly atlasIp?: string;
  readonly atlasStripeCustomerId?: string;
}

/** Expected Note attached to a Person. */
export interface ExpectedNote {
  readonly personEmail: string;
  readonly title: string;
  readonly body: string;
}

export interface ExpectedState {
  readonly persons: ReadonlyArray<ExpectedPerson>;
  readonly notes: ReadonlyArray<ExpectedNote>;
}

/** What we read back from Twenty. Shape is the subset we need to match against. */
export interface ObservedPerson {
  readonly id: string;
  readonly email: string;
  readonly atlasFirstSource?: string;
  readonly atlasLastSource?: string;
  readonly atlasIp?: string;
  readonly atlasStripeCustomerId?: string;
  readonly name?: { firstName?: string; lastName?: string };
}

export interface ObservedNote {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  /** Email of the Person this Note is linked to (resolved via NoteTarget). */
  readonly personEmail: string | null;
}

export interface ObservedState {
  readonly persons: ReadonlyArray<ObservedPerson>;
  readonly notes: ReadonlyArray<ObservedNote>;
}

// ─────────────────────────────────────────────────────────────────────
//  Build expected state from a fixture
// ─────────────────────────────────────────────────────────────────────

/**
 * Collapse a list of lead events into the expected Twenty end-state.
 *
 * Rules (mirror `TwentyClient.upsertPerson`):
 *  - One Person per distinct email (lowercased + trimmed).
 *  - `atlasFirstSource` = first event's source (sticky — never overwritten).
 *  - `atlasLastSource` = last event's source.
 *  - `name` / `atlasIp` / `atlasStripeCustomerId` are merged from any event
 *    that carries them; later events win (matches the dispatcher's PATCH-
 *    every-write behaviour).
 *  - Notes: one per `sales-form` event. Same email with two sales-form
 *    events produces two Notes — each event lands in its own `crm_outbox`
 *    row and each row produces one note. (#2729's idempotency contract
 *    prevents double-create on retry *within* a row, not across rows.)
 */
export function buildExpectedState(events: ReadonlyArray<AtlasLeadEvent>): ExpectedState {
  const persons = new Map<string, ExpectedPerson>();
  const notes: ExpectedNote[] = [];

  for (const event of events) {
    const normalized = normalizeLead(event);
    const email = normalized.person.email;
    const eventSource = normalized.eventSource;

    const existing = persons.get(email);
    if (!existing) {
      const next: ExpectedPerson = {
        email,
        atlasFirstSource: eventSource,
        atlasLastSource: eventSource,
        ...(normalized.person.name ? { name: normalized.person.name } : {}),
        ...(normalized.person.customFields?.atlasIp
          ? { atlasIp: normalized.person.customFields.atlasIp }
          : {}),
        ...(normalized.person.customFields?.atlasStripeCustomerId
          ? {
              atlasStripeCustomerId:
                normalized.person.customFields.atlasStripeCustomerId,
            }
          : {}),
      };
      persons.set(email, next);
    } else {
      // Merge — atlasFirstSource stays sticky; everything else is last-write-wins.
      const merged: ExpectedPerson = {
        email: existing.email,
        atlasFirstSource: existing.atlasFirstSource,
        atlasLastSource: eventSource,
        name: normalized.person.name ?? existing.name,
        atlasIp:
          normalized.person.customFields?.atlasIp ?? existing.atlasIp,
        atlasStripeCustomerId:
          normalized.person.customFields?.atlasStripeCustomerId ??
          existing.atlasStripeCustomerId,
      };
      persons.set(email, merged);
    }

    if (normalized.note) {
      notes.push(buildExpectedNote(email, normalized.note));
    }
  }

  return {
    persons: [...persons.values()],
    notes,
  };
}

function buildExpectedNote(email: string, note: NormalizedNote): ExpectedNote {
  return {
    personEmail: email,
    title: note.title,
    body: note.body,
  };
}

// ─────────────────────────────────────────────────────────────────────
//  Diff
// ─────────────────────────────────────────────────────────────────────

export interface PersonMismatch {
  readonly email: string;
  readonly field:
    | "atlasFirstSource"
    | "atlasLastSource"
    | "atlasIp"
    | "atlasStripeCustomerId"
    | "name.firstName"
    | "name.lastName";
  readonly expected: string;
  readonly observed: string;
}

export interface NoteCountMismatch {
  readonly personEmail: string;
  readonly expected: number;
  readonly observed: number;
}

export interface SmokeDiff {
  /** Expected emails not present in Twenty. */
  readonly missingPersons: ReadonlyArray<string>;
  /**
   * Emails present in Twenty but not in the fixture. Often noise (workspace
   * had pre-existing rows when --wipe-twenty wasn't used) — surfaced so the
   * operator can decide whether it matters, but does NOT mark the diff as
   * "dirty" by itself (see `isClean`).
   */
  readonly unexpectedPersons: ReadonlyArray<string>;
  /** Per-Person field mismatches. The load-bearing slice — these mean the dispatcher wrote the wrong value. */
  readonly mismatchedPersons: ReadonlyArray<PersonMismatch>;
  /** Notes the fixture says should exist but weren't observed (matched by title + personEmail). */
  readonly missingNotes: ReadonlyArray<ExpectedNote>;
  /** Per-Person Note count mismatches (e.g. expected 1 note, observed 2). */
  readonly noteCountMismatches: ReadonlyArray<NoteCountMismatch>;
}

/**
 * Diff the expected state against what we observed in Twenty.
 *
 * Symmetry decisions:
 *  - `missingPersons` AND `mismatchedPersons` mark a diff dirty (see `isClean`).
 *  - `missingNotes` AND `noteCountMismatches` mark a diff dirty.
 *  - `unexpectedPersons` is informational only — a workspace with pre-existing
 *    Twenty data shouldn't fail the smoke unless the operator opted into
 *    `--wipe-twenty`. The CLI surfaces them in the report regardless so the
 *    operator notices, but the exit code stays clean.
 */
export function computeDiff(
  expected: ExpectedState,
  observed: ObservedState,
): SmokeDiff {
  const observedByEmail = new Map<string, ObservedPerson>();
  for (const o of observed.persons) {
    observedByEmail.set(o.email.toLowerCase().trim(), o);
  }
  const expectedEmails = new Set(expected.persons.map((p) => p.email));

  const missingPersons: string[] = [];
  const mismatchedPersons: PersonMismatch[] = [];

  for (const e of expected.persons) {
    const o = observedByEmail.get(e.email);
    if (!o) {
      missingPersons.push(e.email);
      continue;
    }
    pushFieldMismatch(mismatchedPersons, e.email, "atlasFirstSource", e.atlasFirstSource, o.atlasFirstSource);
    pushFieldMismatch(mismatchedPersons, e.email, "atlasLastSource", e.atlasLastSource, o.atlasLastSource);
    // Compare atlasIp / atlasStripeCustomerId ONLY when the fixture set them.
    // The dispatcher writes through whatever the lead event carries; expected-
    // side absence means "we didn't dispatch one, so don't care what Twenty has".
    // The presence-only check catches the load-bearing case (#2737 — Stripe
    // stamp lands on the wrong Twenty Person) without false-positiving on
    // sales-form personas that don't supply an IP.
    if (e.atlasIp) {
      pushFieldMismatch(mismatchedPersons, e.email, "atlasIp", e.atlasIp, o.atlasIp);
    }
    if (e.atlasStripeCustomerId) {
      pushFieldMismatch(
        mismatchedPersons,
        e.email,
        "atlasStripeCustomerId",
        e.atlasStripeCustomerId,
        o.atlasStripeCustomerId,
      );
    }
    if (e.name?.firstName) {
      pushFieldMismatch(
        mismatchedPersons,
        e.email,
        "name.firstName",
        e.name.firstName,
        o.name?.firstName,
      );
    }
    if (e.name?.lastName) {
      pushFieldMismatch(
        mismatchedPersons,
        e.email,
        "name.lastName",
        e.name.lastName,
        o.name?.lastName,
      );
    }
  }

  const unexpectedPersons: string[] = [];
  for (const o of observed.persons) {
    const normEmail = o.email.toLowerCase().trim();
    if (!expectedEmails.has(normEmail)) {
      unexpectedPersons.push(o.email);
    }
  }

  const { missingNotes, noteCountMismatches } = diffNotes(expected.notes, observed.notes);

  return {
    missingPersons,
    unexpectedPersons,
    mismatchedPersons,
    missingNotes,
    noteCountMismatches,
  };
}

function pushFieldMismatch(
  out: PersonMismatch[],
  email: string,
  field: PersonMismatch["field"],
  expected: string | undefined,
  observed: string | undefined,
): void {
  // `undefined` becomes the literal `"(unset)"` so the diff renderer doesn't
  // print "expected DEMO, got undefined" — explicit "(unset)" reads better
  // when the cause is a missing custom field rather than a wrong value.
  if (expected === observed) return;
  out.push({
    email,
    field,
    expected: expected ?? "(unset)",
    observed: observed ?? "(unset)",
  });
}

interface NoteDiff {
  missingNotes: ExpectedNote[];
  noteCountMismatches: NoteCountMismatch[];
}

function diffNotes(
  expected: ReadonlyArray<ExpectedNote>,
  observed: ReadonlyArray<ObservedNote>,
): NoteDiff {
  // Group expected notes by personEmail, then by title.
  const expectedCounts = new Map<string, Map<string, number>>();
  for (const e of expected) {
    const byTitle = expectedCounts.get(e.personEmail) ?? new Map<string, number>();
    byTitle.set(e.title, (byTitle.get(e.title) ?? 0) + 1);
    expectedCounts.set(e.personEmail, byTitle);
  }

  const observedCounts = new Map<string, Map<string, number>>();
  for (const o of observed) {
    if (o.personEmail == null) continue;
    const byTitle = observedCounts.get(o.personEmail) ?? new Map<string, number>();
    byTitle.set(o.title, (byTitle.get(o.title) ?? 0) + 1);
    observedCounts.set(o.personEmail, byTitle);
  }

  const missingNotes: ExpectedNote[] = [];
  const noteCountMismatches: NoteCountMismatch[] = [];

  for (const e of expected) {
    const observedForEmail = observedCounts.get(e.personEmail);
    const observedForTitle = observedForEmail?.get(e.title) ?? 0;
    if (observedForTitle === 0) {
      missingNotes.push(e);
    }
  }

  // Total count check per email — surfaces the cases where the same email
  // has the right titles but a different count (e.g. dispatcher created two
  // notes when the fixture only declared one, or vice versa). Scoped to
  // emails the fixture declared — Notes attached to unexpected workspace
  // Persons are informational only, like `unexpectedPersons`. The
  // `missingNotes` check above is the load-bearing assertion for the
  // #2865-shaped misattribution case (a Note created against the wrong
  // Person surfaces there as a missing-on-the-right-Person finding).
  const allEmails = new Set(expectedCounts.keys());
  for (const email of allEmails) {
    const expectedTotal = sumCounts(expectedCounts.get(email));
    const observedTotal = sumCounts(observedCounts.get(email));
    if (expectedTotal !== observedTotal) {
      noteCountMismatches.push({
        personEmail: email,
        expected: expectedTotal,
        observed: observedTotal,
      });
    }
  }

  return { missingNotes, noteCountMismatches };
}

function sumCounts(byTitle: Map<string, number> | undefined): number {
  if (!byTitle) return 0;
  let n = 0;
  for (const c of byTitle.values()) n += c;
  return n;
}

/** True when no load-bearing mismatch was found (`unexpectedPersons` is ignored). */
export function isClean(diff: SmokeDiff): boolean {
  return (
    diff.missingPersons.length === 0 &&
    diff.mismatchedPersons.length === 0 &&
    diff.missingNotes.length === 0 &&
    diff.noteCountMismatches.length === 0
  );
}

/** Human-readable diff report — output suitable for the CLI's stderr. */
export function formatDiff(diff: SmokeDiff, options?: { totals?: { expectedPersons: number; observedPersons: number; expectedNotes: number; observedNotes: number } }): string {
  const lines: string[] = [];
  if (options?.totals) {
    const t = options.totals;
    lines.push(
      `Totals: persons expected=${t.expectedPersons} observed=${t.observedPersons}, ` +
        `notes expected=${t.expectedNotes} observed=${t.observedNotes}`,
    );
  }

  if (diff.missingPersons.length > 0) {
    lines.push(`✗ Missing Persons (${diff.missingPersons.length}):`);
    for (const email of diff.missingPersons) lines.push(`  - ${email}`);
  }

  if (diff.unexpectedPersons.length > 0) {
    lines.push(
      `ℹ Unexpected Persons in workspace (${diff.unexpectedPersons.length}) — not in fixture, ignored:`,
    );
    for (const email of diff.unexpectedPersons) lines.push(`  - ${email}`);
  }

  if (diff.mismatchedPersons.length > 0) {
    lines.push(`✗ Field mismatches (${diff.mismatchedPersons.length}):`);
    for (const m of diff.mismatchedPersons) {
      lines.push(`  - ${m.email} :: ${m.field}: expected="${m.expected}", observed="${m.observed}"`);
    }
  }

  if (diff.missingNotes.length > 0) {
    lines.push(`✗ Missing Notes (${diff.missingNotes.length}):`);
    for (const n of diff.missingNotes) {
      lines.push(`  - ${n.personEmail} :: "${n.title}"`);
    }
  }

  if (diff.noteCountMismatches.length > 0) {
    lines.push(`✗ Note count mismatches (${diff.noteCountMismatches.length}):`);
    for (const m of diff.noteCountMismatches) {
      lines.push(`  - ${m.personEmail}: expected ${m.expected}, observed ${m.observed}`);
    }
  }

  if (isClean(diff)) {
    lines.push(`✓ Diff is clean — all expected Persons + Notes match.`);
  }

  return lines.join("\n");
}
