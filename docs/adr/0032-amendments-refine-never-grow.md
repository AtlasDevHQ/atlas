# Amendments refine the semantic layer; they never grow the queryable surface

Status: accepted (2026-07-10, semantic-improve elevation grill)

The semantic-improve surface lets an LLM propose changes (Amendments) that an admin approves into the published semantic layer — including via auto-approve and the autonomous scheduler, where no human reads the diff before it applies. We decided that **no Amendment type may add an entity or touch `table:`**: amendments refine coverage that exists (descriptions, dimensions, measures, sample values, query patterns, glossary terms); they never expand the whitelisted table set. A column or table with no semantic coverage is shown honestly as *uncovered* and routes to the enrich/wizard flow — a human-initiated act with whitelist consequences — never to an `add_entity` amendment type.

The rejected alternative was making the improve page a one-stop shop (the column-anchored coverage view makes "just add the table from here" very tempting, and someone will suggest it). We rejected it because the containment is what makes auto-approve and the scheduler safe to contemplate at all: with it, the blast radius of any LLM-authored change is bounded to *how well existing tables are described*; without it, whitelist expansion — the security boundary SQL validation enforces — sits one approval click (or one auto-approve rule) away from an LLM proposal. The structural enforcement predates this ADR (`packages/api/src/lib/semantic/expert/apply.ts`, `whitelist.ts` — amendment types simply have no vocabulary for tables); this ADR records that the gap in the column-anchored flow is deliberate, so nobody "fixes" it.

See also: CONTEXT.md § Semantic improvement ("Amendments refine; enrich grows").
