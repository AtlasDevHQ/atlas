-- 0104_crm_outbox_email_key.sql
--
-- Add `email_key` for per-email serialization at claim time (#2870).
--
-- Without this column, two `crm_outbox` rows for the same email can be
-- claimed in the same flusher tick (or by different pods) and dispatch
-- to Twenty in arbitrary order. That flips `atlasFirstSource` /
-- `atlasLastSource` (the C10 stickiness contract) and leaks last-write-
-- wins fields like `atlasIp` to whichever dispatch happens to finish
-- last. CLAIM_SQL post-migration dedupes by `email_key` AND gates each
-- claim on `NOT EXISTS (in_flight row for same email_key)` so:
--
--   1. Within a single tick batch, only the EARLIEST pending row per
--      email is claimed. Siblings wait for the next tick after the
--      claimed row reaches a terminal state.
--   2. Across ticks / pods, a row for an email already in_flight is
--      excluded from the candidate set (the partial index makes this
--      check cheap as the table grows).
--
-- `email_key` is application-populated by `enqueue` rather than a
-- `GENERATED ALWAYS AS` column so legacy payloads with a missing or
-- malformed `email` field stay claimable. NULL rows skip the
-- NOT EXISTS gate (`o2.email_key IS NOT NULL` short-circuits) and are
-- their own dedup group in CLAIM_SQL via `COALESCE(email_key, id::text)`,
-- so they dispatch independently — matching today's behaviour for any
-- future event types that aren't email-keyed. Lowercased + trimmed to
-- match the runtime `extractEmailKey` helper (`.trim().toLowerCase()`)
-- and the lead-normalizer's email handling, so casing/whitespace
-- differences in the payload don't accidentally bypass serialization.

ALTER TABLE crm_outbox ADD COLUMN IF NOT EXISTS email_key TEXT;

-- Backfill existing rows from their payload. The flusher might already
-- be running against pre-migration rows when the deploy lands — without
-- this UPDATE those rows would have NULL email_key and dispatch
-- concurrently (same as the pre-fix behaviour, which is the bug). The
-- backfill is idempotent (`WHERE email_key IS NULL`) so running this
-- migration twice is a no-op.
--
-- Mirror the runtime `extractEmailKey` helper exactly:
--   `NULLIF(LOWER(REGEXP_REPLACE(value, '^\s+|\s+$', '', 'g')), '')`
-- A whitespace-only payload (`"   "`, `"\t\n"`, etc.) collapses to ''
-- after the trim and we MUST land NULL — a non-NULL empty-string
-- email_key would collide with every other whitespace-only row in
-- CLAIM_SQL's NOT EXISTS gate, causing all such rows to mutually
-- block each other and drain at one-per-tick globally. The regex
-- form matches JavaScript `String.prototype.trim()` for ASCII
-- whitespace (space, tab, newline, CR, FF, VT); plain `TRIM()` in
-- Postgres only strips spaces by default and would leak rows whose
-- payload uses tabs/newlines, asymmetric with what `extractEmailKey`
-- writes at runtime. `jsonb_typeof` guards against `"email": null`
-- and non-string types up front.
UPDATE crm_outbox
SET email_key = NULLIF(LOWER(REGEXP_REPLACE(payload->>'email', '^\s+|\s+$', '', 'g')), '')
WHERE email_key IS NULL
  AND jsonb_typeof(payload->'email') = 'string'
  AND NULLIF(LOWER(REGEXP_REPLACE(payload->>'email', '^\s+|\s+$', '', 'g')), '') IS NOT NULL;

-- Partial index supports both the DISTINCT-ON dedupe inside CLAIM_SQL
-- and the NOT EXISTS gate. Filtering on the active statuses keeps the
-- index small as done/dead rows accumulate.
CREATE INDEX IF NOT EXISTS idx_crm_outbox_email_key_active
  ON crm_outbox (email_key, status, created_at)
  WHERE status IN ('pending', 'in_flight');

COMMENT ON COLUMN crm_outbox.email_key IS
  'Lowercased+trimmed primary email extracted from payload at enqueue time. CLAIM_SQL serializes per-email: only one row per email_key can be in_flight at a time, and only the earliest pending row per email is claimed each tick. Without this, demo→signup pairs and demo→demo repeats for the same email could be dispatched concurrently and apply to Twenty in arbitrary order — flipping atlasFirstSource and leaking atlasIp to whichever dispatch finished last (#2870).';
