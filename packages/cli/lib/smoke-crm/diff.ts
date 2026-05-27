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
   * Emails present in Twenty but not in the fixture. Default behaviour:
   * informational (workspace had pre-existing rows when --wipe-twenty
   * wasn't used). When `requireCleanWorkspace` is set (the smoke ran with
   * `--wipe-twenty`), these flip to dirty — a wiped workspace shouldn't
   * have leftover rows, and treating them as informational would mask
   * partial / truncated wipes. See `isClean`.
   */
  readonly unexpectedPersons: ReadonlyArray<string>;
  /**
   * Emails seen MORE THAN ONCE on the observed side — Twenty workspace
   * has duplicate Person records for the same email. Always dirty: a
   * dedupe regression in `findPersonByEmail` (the #2865 family) is
   * exactly what produces this shape.
   */
  readonly duplicateObservedEmails: ReadonlyArray<string>;
  /** Per-Person field mismatches. The load-bearing slice — these mean the dispatcher wrote the wrong value. */
  readonly mismatchedPersons: ReadonlyArray<PersonMismatch>;
  /** Notes the fixture says should exist but weren't observed (matched by title + body + personEmail, multiplicity-aware). */
  readonly missingNotes: ReadonlyArray<ExpectedNote>;
  /** Per-Person Note count mismatches (e.g. expected 1 note, observed 2). */
  readonly noteCountMismatches: ReadonlyArray<NoteCountMismatch>;
  /**
   * Set when the caller asked for a strict workspace (post-wipe). Flips
   * `unexpectedPersons` from informational to dirty. Stored on the diff
   * so the renderer can format the appropriate severity label.
   */
  readonly strictWorkspace: boolean;
}

export interface ComputeDiffOptions {
  /**
   * When true (the CLI sets this whenever `--wipe-twenty` was passed),
   * `unexpectedPersons` and `duplicateObservedEmails` both mark the diff
   * dirty. The post-wipe workspace should be deterministic — residual
   * rows mean the wipe was partial or truncated.
   */
  readonly requireCleanWorkspace?: boolean;
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
  options: ComputeDiffOptions = {},
): SmokeDiff {
  const observedByEmail = new Map<string, ObservedPerson>();
  const duplicateObservedEmails: string[] = [];
  for (const o of observed.persons) {
    const key = o.email.toLowerCase().trim();
    if (observedByEmail.has(key)) {
      // Duplicate observed Person — a dedupe regression in upsertPerson
      // (`findPersonByEmail` returning null when it shouldn't) creates this
      // shape. Record once per email, then keep the first row as the
      // representative for the field-comparison loop below — the duplicate
      // is already surfaced via `duplicateObservedEmails`.
      if (!duplicateObservedEmails.includes(key)) {
        duplicateObservedEmails.push(key);
      }
      continue;
    }
    observedByEmail.set(key, o);
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
    duplicateObservedEmails,
    mismatchedPersons,
    missingNotes,
    noteCountMismatches,
    strictWorkspace: options.requireCleanWorkspace === true,
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
  // Key notes by `personEmail‖title‖body` so multiplicity AND body content
  // both participate in the diff. Two same-titled-but-different-body notes
  // on the same email are distinct keys; a body corruption regression (right
  // title, wrong body) surfaces as both `missingNotes` (expected key absent)
  // AND an inflated `noteCountMismatches` total for that email.
  const expectedKeys = new Map<string, { count: number; sample: ExpectedNote }>();
  for (const e of expected) {
    const k = noteKey(e.personEmail, e.title, e.body);
    const prior = expectedKeys.get(k);
    expectedKeys.set(k, { count: (prior?.count ?? 0) + 1, sample: e });
  }

  const observedKeys = new Map<string, number>();
  for (const o of observed) {
    if (o.personEmail == null) continue;
    const k = noteKey(o.personEmail, o.title, o.body);
    observedKeys.set(k, (observedKeys.get(k) ?? 0) + 1);
  }

  // Multiplicity-aware missing check: if expected says "alice@x.com has 2
  // notes with title T and body B", and observed has only 1, the missing
  // count is 1. Codex P2-B/D.
  const missingNotes: ExpectedNote[] = [];
  for (const [k, { count: expectedCount, sample }] of expectedKeys) {
    const observedCount = observedKeys.get(k) ?? 0;
    for (let i = 0; i < expectedCount - observedCount; i++) {
      missingNotes.push(sample);
    }
  }

  // Per-email TOTAL count check — surfaces "right titles but wrong count"
  // and (with the body keying above) "right title but wrong body, leaving
  // the total clean". Scoped to fixture emails — Notes attached to
  // unexpected workspace Persons are informational, like `unexpectedPersons`.
  const noteCountMismatches: NoteCountMismatch[] = [];
  const expectedTotalByEmail = new Map<string, number>();
  for (const e of expected) {
    expectedTotalByEmail.set(
      e.personEmail,
      (expectedTotalByEmail.get(e.personEmail) ?? 0) + 1,
    );
  }
  const observedTotalByEmail = new Map<string, number>();
  for (const o of observed) {
    if (o.personEmail == null) continue;
    observedTotalByEmail.set(
      o.personEmail,
      (observedTotalByEmail.get(o.personEmail) ?? 0) + 1,
    );
  }
  for (const email of expectedTotalByEmail.keys()) {
    const expectedTotal = expectedTotalByEmail.get(email) ?? 0;
    const observedTotal = observedTotalByEmail.get(email) ?? 0;
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

/**
 * Stable composite key for note identity. Newlines in title or body are
 * escaped so the key is unambiguous (a body containing `‖` won't collide
 * with the email/title separator); a literal U+2016 byte is unlikely in
 * sales-form copy but cheap to guard against.
 */
function noteKey(email: string, title: string, body: string): string {
  return [email, title, body].map((s) => s.replace(/‖/g, "‖‖")).join("‖");
}

/**
 * True when no load-bearing mismatch was found.
 *
 * `unexpectedPersons` is informational by default — workspaces have
 * pre-existing data that the smoke shouldn't fail on. The exception is
 * `strictWorkspace` mode (set by the CLI when `--wipe-twenty` was
 * passed): after a wipe, residual rows mean the wipe was partial /
 * truncated, so unexpected Persons flip to dirty.
 *
 * `duplicateObservedEmails` is always dirty — a dedupe regression in
 * `findPersonByEmail` is exactly the #2865 failure shape.
 */
export function isClean(diff: SmokeDiff): boolean {
  if (
    diff.missingPersons.length > 0 ||
    diff.mismatchedPersons.length > 0 ||
    diff.missingNotes.length > 0 ||
    diff.noteCountMismatches.length > 0 ||
    diff.duplicateObservedEmails.length > 0
  ) {
    return false;
  }
  if (diff.strictWorkspace && diff.unexpectedPersons.length > 0) return false;
  return true;
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
    if (diff.strictWorkspace) {
      lines.push(
        `✗ Unexpected Persons in workspace (${diff.unexpectedPersons.length}) — wipe did not fully drain:`,
      );
    } else {
      lines.push(
        `ℹ Unexpected Persons in workspace (${diff.unexpectedPersons.length}) — not in fixture, ignored:`,
      );
    }
    for (const email of diff.unexpectedPersons) lines.push(`  - ${email}`);
  }

  if (diff.duplicateObservedEmails.length > 0) {
    lines.push(
      `✗ Duplicate observed Persons (${diff.duplicateObservedEmails.length}) — same email appears more than once in Twenty:`,
    );
    for (const email of diff.duplicateObservedEmails) lines.push(`  - ${email}`);
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
