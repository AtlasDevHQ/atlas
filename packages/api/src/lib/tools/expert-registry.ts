/**
 * Expert agent tool registry — superset of standard tools plus 5 semantic expert tools.
 *
 * Used by the semantic expert agent for autonomous and interactive analysis.
 */

import { ToolRegistry, EXPLORE_DESCRIPTION, EXECUTE_SQL_DESCRIPTION } from "./registry";
import { explore } from "./explore";
import { executeSQL } from "./sql";
import { profileTable } from "./profile-table";
import { checkDataDistribution } from "./check-distribution";
import { searchAuditLog } from "./search-audit-log";
import { proposeAmendment } from "./propose-amendment";
import { validateProposal } from "./validate-proposal";

// ── Workflow descriptions for expert tools ──

const PROFILE_TABLE_DESCRIPTION = `### 5. Profile a Table
Use the profileTable tool to examine table structure, cardinality, null rates, and sample values:
- Profile a table before proposing changes to understand the actual data
- Use column-level stats (nullRate, distinctCount, topValues) to validate type accuracy
- Check if sample_values in entity YAML match actual data`;

const CHECK_DISTRIBUTION_DESCRIPTION = `### 6. Check Data Distribution
Use the checkDataDistribution tool to analyze a specific column's value distribution:
- Run this before proposing new dimensions or measures to understand the data shape
- Identify enum-like columns (low cardinality) vs continuous columns
- Check for null prevalence to decide if a column should be nullable`;

const SEARCH_AUDIT_LOG_DESCRIPTION = `### 7. Search the Audit Log
Use the searchAuditLog tool to find query patterns from actual usage:
- Search for queries involving specific tables to identify popular joins and aggregations
- Find columns that appear frequently in queries but are missing from entity schemas
- Check if proposed query patterns are already captured`;

const PROPOSE_AMENDMENT_DESCRIPTION = `### 8. Propose a Semantic Layer Amendment
Use the proposeAmendment tool to propose a structured YAML change:
- Always include a testQuery to validate the amendment when possible
- Set confidence based on evidence: high (0.8+) for changes backed by audit log data, medium (0.5-0.8) for profiler-based suggestions, low (<0.5) for speculative improvements
- Include a clear rationale explaining why this change improves the semantic layer`;

const VALIDATE_PROPOSAL_DESCRIPTION = `### 9. Validate a Proposal
Use the validateProposal tool to dry-run validate a previously proposed amendment:
- Checks YAML syntax, table whitelist compliance, and test query execution
- Run this after proposeAmendment to catch issues before admin review`;

/**
 * Build the expert agent ToolRegistry with all 7 tools.
 */
export function buildExpertRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  // Standard tools
  registry.register({
    name: "explore",
    description: EXPLORE_DESCRIPTION,
    tool: explore,
  });
  registry.register({
    name: "executeSQL",
    description: EXECUTE_SQL_DESCRIPTION,
    tool: executeSQL,
  });

  // Expert tools
  registry.register({
    name: "profileTable",
    description: PROFILE_TABLE_DESCRIPTION,
    tool: profileTable,
  });
  registry.register({
    name: "checkDataDistribution",
    description: CHECK_DISTRIBUTION_DESCRIPTION,
    tool: checkDataDistribution,
  });
  registry.register({
    name: "searchAuditLog",
    description: SEARCH_AUDIT_LOG_DESCRIPTION,
    tool: searchAuditLog,
  });
  registry.register({
    name: "proposeAmendment",
    description: PROPOSE_AMENDMENT_DESCRIPTION,
    tool: proposeAmendment,
  });
  registry.register({
    name: "validateProposal",
    description: VALIDATE_PROPOSAL_DESCRIPTION,
    tool: validateProposal,
  });

  registry.freeze();
  return registry;
}
