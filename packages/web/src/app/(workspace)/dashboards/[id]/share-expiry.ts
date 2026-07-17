/**
 * Reconstruct the share-expiry dropdown key from a live share's absolute
 * `expiresAt` (#4536).
 *
 * The share dialog's "Link expires" `Select` is keyed by a coarse bucket
 * (`1h`/`24h`/`7d`/`30d`/`never`), but the API only round-trips the concrete
 * `expiresAt` timestamp. When the dialog opens on an EXISTING share the control
 * has no bucket to show, so it used to sit on its `"7d"` mount default —
 * contradicting the summary line (which renders the real `expiresAt`) and, worse,
 * silently re-POSTing `expiresIn: "7d"` on a visibility-only edit, quietly
 * shrinking a "Never"/"30 days" link down to 7 days.
 *
 * This maps the timestamp back to a bucket so the control agrees with the
 * summary and a visibility-only "Update settings" preserves the original
 * lifetime instead of resetting it:
 *   - `null`            → `"never"` (no-expiry links stay no-expiry)
 *   - a future instant  → the SMALLEST predefined bucket that still covers the
 *                         remaining time. Because the remaining time is always
 *                         ≤ the bucket a share was minted with, this recovers the
 *                         original creation bucket for any share younger than one
 *                         bucket-step, and never rounds DOWN into a shorter
 *                         lifetime than the link actually has.
 *   - an already-past / clock-skewed instant → the smallest timed bucket, so the
 *                         control still shows a concrete value.
 *
 * Framework-free + `now`-injectable so the mapping is unit-testable without
 * mounting the dialog.
 */
import type { ShareExpiryKey } from "@/ui/lib/types";
import { SHARE_EXPIRY_OPTIONS } from "@/ui/lib/types";

/** The timed buckets — every `ShareExpiryKey` except the null-duration `never`. */
type TimedExpiryKey = Exclude<ShareExpiryKey, "never">;

// Timed buckets (excluding `never`), ascending by duration. Derived from the
// SSOT const so a new bucket flows through without a second list to drift.
const TIMED_KEYS_ASC: TimedExpiryKey[] = (Object.keys(SHARE_EXPIRY_OPTIONS) as ShareExpiryKey[])
  .filter((k): k is TimedExpiryKey => SHARE_EXPIRY_OPTIONS[k] !== null)
  .sort((a, b) => (SHARE_EXPIRY_OPTIONS[a] ?? 0) - (SHARE_EXPIRY_OPTIONS[b] ?? 0));

// Totality of `deriveExpiryKey` rests on there being ≥1 timed bucket; if the
// SSOT const ever lost them, the index reads below would return `undefined`
// typed as a valid key — an unsound lie. Fail loudly at import instead.
if (TIMED_KEYS_ASC.length === 0) {
  throw new Error("SHARE_EXPIRY_OPTIONS has no timed buckets — deriveExpiryKey cannot be total");
}

const LARGEST_TIMED_KEY: TimedExpiryKey = TIMED_KEYS_ASC[TIMED_KEYS_ASC.length - 1];
const SMALLEST_TIMED_KEY: TimedExpiryKey = TIMED_KEYS_ASC[0];

/**
 * Derive the expiry dropdown key that best represents an existing share's
 * `expiresAt`. See module doc for the rounding rationale.
 */
export function deriveExpiryKey(
  expiresAt: string | null,
  now: number = Date.now(),
): ShareExpiryKey {
  if (expiresAt === null) return "never";

  const expiresMs = new Date(expiresAt).getTime();
  if (Number.isNaN(expiresMs)) {
    // A malformed `expiresAt` means the share API drifted its serialization —
    // surface it rather than swallow it. `"never"` is the non-shrinking fallback
    // (it can't collapse the link to 7d, the #4536 harm); its only downside is a
    // later visibility-only re-POST could extend a truly-expiring link, which is
    // strictly safer than silently shortening one.
    console.debug("deriveExpiryKey: unparseable share expiresAt, defaulting to 'never'", { expiresAt });
    return "never";
  }

  const remainingSeconds = (expiresMs - now) / 1000;
  // Already expired / clock skew — show the smallest concrete bucket.
  if (remainingSeconds <= 0) return SMALLEST_TIMED_KEY;

  // Smallest bucket that still covers the remaining lifetime (never rounds down).
  for (const key of TIMED_KEYS_ASC) {
    const seconds = SHARE_EXPIRY_OPTIONS[key];
    if (seconds !== null && seconds >= remainingSeconds) return key;
  }
  // Remaining exceeds every timed bucket (future-dated beyond 30d): cap at largest.
  return LARGEST_TIMED_KEY;
}
