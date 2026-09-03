-- 0215 — `demo_anonymous_sessions`: the anonymous demo principal's ledger (#5604).
--
-- The MCP front door answers before it asks for an email. Every demo path used
-- to be email-gated (the email keyed the demo token, the per-identity rate
-- limit and the lead capture), and an MCP client has no form to put an email
-- in. The anonymous principal is minted per client instead, and THIS ROW is
-- the identity: its `id` rides inside the signed token, the MCP edge re-loads
-- the row on every request, and the per-identity rate limit keys on it.
--
-- ## What the launch-cycle gate reads
--
-- The launch-cycle PRD (drafted under issue 5602) counts anonymous sessions as
-- `SELECT count(*) FROM demo_anonymous_sessions WHERE created_at >= <date>`.
-- `id` and `created_at` are therefore load-bearing names (the PRD reads `created_at >= '<post ts>' AND created_at < '<read ts>'`); the rest of the row
-- is the demo door's own bookkeeping.
--
-- ## No raw IP at rest
--
-- `ip_hash` is an HMAC-SHA256 of the client IP under a key derived from
-- `BETTER_AUTH_SECRET` (`deriveDemoKey("demo-ip")`). It is enough to count
-- distinct sources and to see one source minting in bulk; it identifies
-- nobody. `demo_leads.ip_address` (the email demo) keeps its raw value — that
-- table is unchanged by this migration and is the visitor's explicit hand-off.
--
-- ## `answer_count` is a gate, not a metric
--
-- Email capture is OPTIONAL and happens AFTER the first answer, never before:
-- `captureAnonymousDemoEmail` refuses while `answer_count = 0`. The email
-- itself goes to `demo_leads`; `email_captured_at` records only that the act
-- happened.
--
-- ## `workspace_id` pins the scope the token was minted for
--
-- The demo workspace is resolved by slug from the settings registry at every
-- request. A session minted for one workspace whose slug later resolves to
-- another is refused at the edge (fail closed) — the stored id is what makes
-- that comparison possible.
--
-- ## Deploy-overlap note (expand only)
--
-- A new table nothing on N-1 reads or writes. Nothing is dropped or renamed.

CREATE TABLE IF NOT EXISTS demo_anonymous_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ip_hash text,
  client_label text,
  answer_count integer NOT NULL DEFAULT 0,
  email_captured_at timestamptz
);

-- The one query anyone has committed to write: the launch-cycle count over a
-- `created_at` window.
CREATE INDEX IF NOT EXISTS idx_demo_anonymous_sessions_created
  ON demo_anonymous_sessions (created_at);

COMMENT ON TABLE demo_anonymous_sessions IS 'One row per minted anonymous demo identity (#5604). id = the principal; created_at = what the launch-cycle gate counts. ip_hash is an HMAC, never a raw IP. answer_count gates the optional, after-first-answer email hand-off (the email itself lives in demo_leads).';
