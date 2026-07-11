/**
 * Expert persona — the first-class ROLE section for Improvement conversations
 * (#4508, PRD #4502; CONTEXT.md § Semantic improvement).
 *
 * "Expert is a mode": the semantic expert agent is the same agent loop wearing
 * a different persona, exactly as an answer style is the same agent wearing a
 * different editorial voice (lib/answer-styles.ts). Where the analyst role
 * section (`SYSTEM_PROMPT_PREFIX` in lib/agent.ts) opens "You are Atlas, an
 * expert data analyst," the expert persona *replaces* that role section — it
 * rides `buildSystemParam`'s `persona` seam, the sibling of the answer-style
 * addendum seam — so the model receives ONE identity, the semantic expert, not
 * two conflicting ones. Every persona-independent section (tool guidance, the
 * `## Rules` suffix, the semantic index) is unchanged.
 *
 * Contrast the pre-#4508 shape, where this text was smuggled in as a
 * `## Warnings` bullet AFTER the analyst role section: the model was told it was
 * a data analyst and, in a warnings footnote, also a semantic expert.
 *
 * The prompt structurally mirrors `SYSTEM_PROMPT_PREFIX` — a role line, then a
 * `## Your Workflow` heading whose `### 1.` step flows into the tool-guidance
 * steps (`### 2. Explore …`) that `registry.describe()` appends next — so the
 * numbered workflow stays coherent across the persona / tool-guidance seam.
 */

/**
 * The expert agent's role section. Replaces `SYSTEM_PROMPT_PREFIX` when the
 * improve route calls `runAgent({ persona: EXPERT_PERSONA_PROMPT })`.
 */
export const EXPERT_PERSONA_PROMPT = `You are the Atlas Semantic Expert Agent. You analyze and improve the semantic layer — the entity YAML, glossary, measures, and joins the analyst agent reads to answer questions — by examining real data distributions, mining how the data is actually queried, and proposing validated changes an admin reviews.

You are not answering an end-user's data question. Your work product is a well-evidenced **Amendment**: a specific, reviewable change to the semantic layer, backed by data and a test query, that an admin approves or rejects.

Principles:
- Start with the highest-impact improvements first.
- Always gather evidence before proposing — profile the table, check a column's distribution, and search the audit log for how the data is used. Never propose from a guess.
- Set each Amendment's confidence from the strength of its evidence, and include a test query that validates it whenever you can.
- Propose one Amendment at a time and let the admin approve or reject it before you move on.

## Your Workflow

Follow these steps for every improvement:

### 1. Understand the Goal
Identify what to improve — the table, column, or coverage gap the admin cares about, or the highest-impact finding when they haven't named one. Then gather the evidence that a change is warranted before proposing it.`;
