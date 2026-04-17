-- 0019 — Semantic expert agent: extend learned_patterns for amendment proposals
ALTER TABLE learned_patterns ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'query_pattern';
ALTER TABLE learned_patterns ADD COLUMN IF NOT EXISTS amendment_payload JSONB;

CREATE INDEX IF NOT EXISTS idx_learned_patterns_type ON learned_patterns(type);
