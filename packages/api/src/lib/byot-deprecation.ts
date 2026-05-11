/**
 * Suggest a closest-match replacement when a BYOT-saved model is gone
 * from the upstream catalog (#2275).
 *
 * Edit-distance alone is too noisy for real deprecation patterns —
 * `claude-3-opus-20240229` and `claude-opus-4-6` look very different
 * to Levenshtein but are clearly the same family. We use a
 * family-prefix-then-edit-distance approach instead:
 *
 *   1. Extract the "family stem" — the leading alphabetic run
 *      ('claude', 'gpt', 'gemini', 'anthropic.claude', etc.).
 *   2. Filter candidates to ones whose stem matches the saved model's
 *      stem AND whose provider matches `savedProvider`.
 *   3. If any candidates pass, pick the closest by edit distance.
 *   4. If no stem matches, fall back to cross-provider edit-distance
 *      with a tighter threshold.
 *
 * Conservative on purpose: returns `null` rather than a low-confidence
 * match. The admin UI shows "Apply suggestion" only when we're
 * reasonably sure; otherwise it surfaces a generic warning + the full
 * picker.
 */

interface SuggestionCandidate {
  id: string;
  provider: string;
}

/** Lowercase + alphanumeric-only — drops dashes, dots, colons, version markers. */
function normalize(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * The "family stem" is the longest leading alphabetic run that's still
 * meaningfully a family name. We segment on non-letters and take the
 * first segment. For bedrock-style `anthropic.claude-opus-4-v1:0`, we
 * also concatenate the first two segments if the second one is
 * a recognized provider family ('claude', 'gpt', 'gemini', etc.) — so
 * the bedrock + non-bedrock anthropic worlds compare apples-to-apples.
 */
const FAMILY_SECONDARY_WORDS: ReadonlySet<string> = new Set([
  "claude",
  "gpt",
  "o",
  "gemini",
  "titan",
  "mistral",
  "llama",
  "command",
]);

function familyStem(id: string): string {
  const lower = id.toLowerCase();
  const segments = lower.split(/[^a-z]+/).filter((s) => s.length > 0);
  if (segments.length === 0) return "";
  // Bedrock-style "anthropic.claude…" — anchor on the inner family word.
  if (
    segments.length >= 2 &&
    (segments[0] === "anthropic" || segments[0] === "amazon" || segments[0] === "cohere") &&
    FAMILY_SECONDARY_WORDS.has(segments[1])
  ) {
    return `${segments[0]}.${segments[1]}`;
  }
  return segments[0];
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1, // insertion
        prev[j] + 1, // deletion
        prev[j - 1] + cost, // substitution
      );
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j];
  }
  return prev[b.length];
}

function pickClosest(
  savedNormalized: string,
  pool: SuggestionCandidate[],
): { id: string; distance: number; longerLen: number } | null {
  let best: { id: string; distance: number; longerLen: number } | null = null;
  for (const candidate of pool) {
    const candidateNormalized = normalize(candidate.id);
    if (candidateNormalized.length === 0) continue;
    const distance = levenshtein(savedNormalized, candidateNormalized);
    if (best === null || distance < best.distance) {
      best = {
        id: candidate.id,
        distance,
        longerLen: Math.max(savedNormalized.length, candidateNormalized.length),
      };
    }
  }
  return best;
}

/**
 * Pick the closest match for `savedModelId` from `candidates`, biased
 * toward the same family stem + provider. Returns null when no
 * candidate is close enough to recommend confidently.
 */
export function suggestModelReplacement(
  savedModelId: string,
  savedProvider: string,
  candidates: SuggestionCandidate[],
): string | null {
  if (candidates.length === 0) return null;
  const savedNormalized = normalize(savedModelId);
  if (savedNormalized.length === 0) return null;
  const savedStem = familyStem(savedModelId);

  // Tier 1: same provider + same family stem. Accept the closest match
  // outright — this is the high-confidence path (e.g.
  // `claude-3-opus-20240229` → `claude-opus-4-6`).
  if (savedStem.length > 0) {
    const tier1 = candidates.filter(
      (c) => c.provider === savedProvider && familyStem(c.id) === savedStem,
    );
    const pick = pickClosest(savedNormalized, tier1);
    if (pick) return pick.id;
  }

  // Tier 2: same provider, any stem. Accept only if the normalized
  // edit distance is below 30% — without the family-stem signal we
  // need stronger evidence.
  const tier2 = candidates.filter((c) => c.provider === savedProvider);
  const pick2 = pickClosest(savedNormalized, tier2);
  if (pick2) {
    const ratio = pick2.distance / Math.max(pick2.longerLen, 1);
    if (ratio <= 0.3) return pick2.id;
  }

  // Tier 3: cross-provider fallback. Same 30% threshold. This catches
  // bedrock-vs-direct-anthropic patterns when the workspace switched
  // providers without resaving.
  const pick3 = pickClosest(savedNormalized, candidates);
  if (pick3) {
    const ratio = pick3.distance / Math.max(pick3.longerLen, 1);
    if (ratio <= 0.3) return pick3.id;
  }

  return null;
}
