/**
 * WebVTT → episode body (#4965).
 *
 * Zoom publishes a meeting transcript as a `.vtt` file: a `WEBVTT` header, then
 * cues of `[index] / [start --> end] / [payload]`. Zoom puts the speaker in the
 * payload as `Speaker Name: what they said`.
 *
 * ## What this keeps, and why the choice is load-bearing
 *
 * It keeps the SPEAKER LABELS and drops the TIMESTAMPS.
 *
 * Dropping timestamps is easy to justify: an episode already carries
 * `occurredAt`, and per-cue offsets would triple the body for a signal nothing
 * downstream reads.
 *
 * Keeping speaker labels is the one that matters, and it is what makes this
 * connector's half of ADR-0036 §T6's block-vs-flag asymmetry STRUCTURAL rather
 * than merely intended. The connector resolves exactly one thing — the meeting
 * AUDIENCE — and blocks when it cannot. It resolves NO entities: "who is Sam"
 * is left inside the body text for the extraction stage (#4771) to attribute,
 * where a failure flags the fact `provisional` and a reviewer clears it later
 * via `correct_fact`.
 *
 * So the connector CANNOT block on entity resolution, because it never performs
 * any. That is a stronger guarantee than a rule saying it must not: if this
 * function resolved speakers to Atlas users, every unrecognised name would
 * become a decision at ingest, and the natural place to put an unresolvable
 * speaker is the block arm — silently converting a quality failure into a
 * safety one, which is precisely the inversion the asymmetry forbids.
 *
 * ## Merging consecutive cues from one speaker
 *
 * Zoom emits a cue every few seconds, so one sentence is routinely split across
 * three. Merging consecutive same-speaker cues into a paragraph is not
 * cosmetic: an extractor reading `Alice: We decided to` / `Alice: move the
 * launch to Q3` as two records can produce a claim from either half alone.
 */

/** One speaker turn — the unit this module produces. */
export interface TranscriptTurn {
  /** The speaker label exactly as Zoom wrote it, or null for an unlabelled cue. */
  readonly speaker: string | null;
  readonly text: string;
}

/**
 * A cue payload's `Speaker: text` split — the CANDIDATE match. Whether the
 * label is really a name is decided by {@link looksLikeSpeakerLabel}.
 *
 * The colon must be followed by a space or tab, which alone rules out `12:30`
 * and `https://…`.
 */
const SPEAKER_LINE = /^([^:\n]{1,60}):[ \t](.*)$/s;

/** Most words a speaker label may have. "External Guest (Acme Corp)" is four. */
const MAX_SPEAKER_WORDS = 5;

/**
 * Is this candidate label a NAME rather than the first clause of a sentence?
 *
 * The length bound alone is not enough, and that is worth stating because it
 * was the first thing tried: `So we tested the whole pipeline end to end and:
 * it worked` has a 46-character prefix, well inside any reasonable character
 * limit, and it parses as a speaker named after half a sentence. The label then
 * flows into the merged body as an ATTRIBUTION and the extractor attributes the
 * claim to a person who does not exist — a false fact with a plausible author,
 * which is worse than an unattributed one.
 *
 * So the test is WORD COUNT plus sentence punctuation. A name is a few words
 * and carries no `.`/`?`/`!`/`,`.
 *
 * It errs toward "no speaker" on purpose, and the cost is real and accepted: a
 * label like `Smith, Alice` (comma) or a long org-qualified display name falls
 * back to unlabelled. An unlabelled turn is a QUALITY loss that #4771 can still
 * extract from; a mis-attributed one is a false fact. The asymmetry decides it.
 */
function looksLikeSpeakerLabel(label: string): boolean {
  if (/[.?!,]/.test(label)) return false;
  return label.split(/\s+/).filter((word) => word !== "").length <= MAX_SPEAKER_WORDS;
}

/** Cue payloads Zoom emits that carry no speech. */
const NON_SPEECH_PAYLOADS = new Set(["", "[silence]", "[inaudible]", "[blank_audio]"]);

/**
 * Split a VTT document into speaker turns.
 *
 * Tolerant by design — a malformed cue is SKIPPED, never fatal. A transcript is
 * evidence, and refusing the whole file because one cue lacked a timing line
 * would discard a meeting over a vendor formatting quirk. What it will not do
 * is invent structure: a cue whose payload has no recognisable speaker keeps
 * `speaker: null` rather than inheriting the previous one, because inheriting
 * is how a long pause becomes words in someone else's mouth.
 */
export function parseVtt(raw: string): readonly TranscriptTurn[] {
  // Normalise line endings first: Zoom serves CRLF, and a `\r` left on the end
  // of a payload survives into the body and then into every quoted fact.
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const turns: TranscriptTurn[] = [];

  let payload: string[] = [];
  let sawTiming = false;

  const flush = (): void => {
    if (sawTiming && payload.length > 0) {
      const joined = payload.join(" ").trim();
      if (!NON_SPEECH_PAYLOADS.has(joined.toLowerCase())) {
        const match = SPEAKER_LINE.exec(joined);
        const label = match === null ? null : match[1].trim();
        const text = match === null ? "" : match[2].trim();
        if (match === null || label === null || !looksLikeSpeakerLabel(label) || text === "") {
          // No label, a label that reads as prose, or a label with an empty
          // body (a stray colon) — keep the payload WHOLE and unattributed
          // rather than splitting it on a colon that meant something else.
          turns.push({ speaker: null, text: joined });
        } else {
          turns.push({ speaker: label, text });
        }
      }
    }
    payload = [];
    sawTiming = false;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") {
      flush();
      continue;
    }
    if (trimmed === "WEBVTT" || trimmed.startsWith("WEBVTT ")) continue;
    // `NOTE` blocks and cue settings are metadata, never speech.
    if (trimmed.startsWith("NOTE")) continue;
    if (trimmed.includes("-->")) {
      // A second timing line inside one block means the blank-line separator
      // was missing. Treat it as a boundary rather than concatenating two
      // people's cues into one turn.
      if (sawTiming) flush();
      sawTiming = true;
      continue;
    }
    // A bare cue INDEX before the timing line is not payload. Only skipped
    // while no timing has been seen — a payload line that happens to be the
    // single digit "5" is real speech and must survive.
    if (!sawTiming && /^\d+$/.test(trimmed)) continue;
    if (sawTiming) payload.push(trimmed);
  }
  flush();

  return turns;
}

/**
 * Turns → the stored episode body, merging consecutive same-speaker turns.
 *
 * Unlabelled turns merge only with other unlabelled turns — `null` is a
 * distinct speaker here, not a wildcard, so an unattributed cue between two of
 * Alice's never silently becomes Alice's.
 */
export function turnsToBody(turns: readonly TranscriptTurn[]): string {
  const merged: { speaker: string | null; parts: string[] }[] = [];
  for (const turn of turns) {
    const last = merged.at(-1);
    if (last !== undefined && last.speaker === turn.speaker) {
      last.parts.push(turn.text);
      continue;
    }
    merged.push({ speaker: turn.speaker, parts: [turn.text] });
  }
  return merged
    .map((block) => {
      const text = block.parts.join(" ");
      return block.speaker === null ? text : `${block.speaker}: ${text}`;
    })
    .join("\n");
}

/** The whole pipeline: a Zoom VTT document → the episode body text. */
export function vttToBody(raw: string): string {
  return turnsToBody(parseVtt(raw));
}
