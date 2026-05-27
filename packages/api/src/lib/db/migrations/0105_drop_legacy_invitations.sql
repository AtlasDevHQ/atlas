-- Legacy `invitations` (plural) table — half-wired (writes only, no
-- readers). Org invitations now live in Better Auth's `invitation`
-- (singular) table. CASCADE drops the attached indexes; no FKs reference
-- this table.

DROP TABLE IF EXISTS invitations CASCADE;
