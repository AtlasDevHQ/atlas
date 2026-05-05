-- 0048 — per-user trust grants for "skip 2FA on this browser".
--
-- Mirrors Better Auth's `verification` row 1:1 by `identifier` (the cookie
-- payload Better Auth sets after a successful TOTP verify with
-- `trustDevice: true`). We keep the metadata Better Auth doesn't track —
-- user-agent, IP, derived label — so the security page can render
-- "Mac · Safari · expires May 30" instead of just an opaque identifier.
--
-- Per-user data, NOT subject to the content-mode system. Trust grants are
-- private to the granting user (the cookie lives on their browser, the row
-- maps to that cookie); they are never workspace-shared draft content. Same
-- carve-out rationale as `user_favorite_prompts` in 0029.
--
-- Plaintext UA / IP: these are log-equivalent metadata, not credentials.
-- Better Auth itself stores `value = userId` in the adjacent `verification`
-- table without encryption. If a future region needs encryption-at-rest for
-- these columns, follow the `_encrypted` pattern from 0036/0037 — but doing
-- so now would make the admin list expensive (decrypt on every fetch) for
-- a privacy gain that doesn't match Better Auth's own posture.

CREATE TABLE IF NOT EXISTS trusted_device (
  identifier    TEXT        PRIMARY KEY,                   -- matches verification.identifier
  user_id       TEXT        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  user_agent    TEXT,
  ip_address    TEXT,
  device_label  TEXT,                                       -- "Mac · Safari" — recomputable from user_agent
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Resolver path: list all trust grants for a given user, newest first.
CREATE INDEX IF NOT EXISTS idx_trusted_device_user_id_created_at
  ON trusted_device(user_id, created_at DESC);
