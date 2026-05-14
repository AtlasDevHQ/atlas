# Architecture Wins

## 2026-05-14 — Connection group cleanup landed

- Dropped the legacy content-scope `connection_id` columns from semantic entities, dashboard cards, scheduled tasks, approval queue, and PII classifications.
- Kept `conversations.connection_id` as the execution target, with `connection_group_id` continuing to represent content scope.
- Tightened `connections.group_id` to `NOT NULL` after repairing any remaining ungrouped rows into their 1:1 backfill groups.
- Simplified group-scope SQL helpers so `connection_group_id` is the default source of truth.
