/**
 * Semantic expert analysis engine — barrel export.
 */

export { analyzeSemanticLayer } from "./analyzer";
export {
  findCoverageGaps,
  findDescriptionIssues,
  findTypeInaccuracies,
  findMissingMeasures,
  findMissingJoins,
  findGlossaryGaps,
  findStaleSampleValues,
  findQueryPatternGaps,
  findVirtualDimensionOpportunities,
} from "./categories";
export { createAnalysisResult, computeScore, tableFrequencyImpact, coverageImpact } from "./scoring";
export type {
  AnalysisContext,
  AnalysisResult,
  AnalysisCategory,
  ParsedEntity,
  GlossaryTerm,
  AuditPattern,
} from "./types";
export { ANALYSIS_CATEGORIES } from "./types";
export {
  createSession,
  nextProposal,
  recordDecision,
  addMessage,
  getSessionSummary,
  buildSessionContext,
} from "./session";
export type {
  SessionState,
  ReviewedProposal,
  ConversationMessage,
} from "./session";
