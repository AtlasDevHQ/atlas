/**
 * SOQL validation — regex + structural checks.
 *
 * SOQL is simpler than SQL, so no AST parser is needed. Validation layers:
 * 0. Empty check
 * 1. Regex mutation guard (INSERT, UPDATE, DELETE, UPSERT, MERGE, UNDELETE)
 * 2. Must start with SELECT, no semicolons
 * 3. Object whitelist — FROM object must be in the allowed set
 */

export const SOQL_FORBIDDEN_PATTERNS: RegExp[] = [
  /\b(INSERT)\b/i,
  /\b(UPDATE)\b/i,
  /\b(DELETE)\b/i,
  /\b(UPSERT)\b/i,
  /\b(MERGE)\b/i,
  /\b(UNDELETE)\b/i,
];

/**
 * Sensitive error patterns — used to scrub error messages before returning
 * them to the agent/user. Prevents leaking credentials, hostnames, and
 * internal details. Mirrors @atlas/api/lib/security.ts SENSITIVE_PATTERNS.
 */
export const SENSITIVE_PATTERNS =
  /password|secret|credential|connection.?string|SSL|certificate|INVALID_SESSION_ID|LOGIN_MUST_USE_SECURITY_TOKEN|INVALID_LOGIN|INVALID_CLIENT_ID|Authentication failed/i;

/**
 * Strip single-quoted string literals from SOQL so regex guards don't match
 * keywords embedded in user values (e.g. `WHERE Name = 'delete this'`).
 */
function stripStringLiterals(soql: string): string {
  return soql.replace(/'[^']*'/g, "''");
}

/**
 * Extract top-level object names referenced in FROM clauses.
 *
 * Parent-to-child relationship subqueries — `(SELECT ... FROM Contacts)` inside
 * the SELECT list — use relationship names (plural) that don't appear in the
 * object whitelist. Salesforce enforces object-level security server-side for
 * these, so we skip nested FROM inside parenthesized subqueries.
 *
 * Semi-join / anti-join subqueries in WHERE — `WHERE Id IN (SELECT ... FROM Contact)`
 * — reference real object names and ARE checked.
 */
function extractFromObjects(soql: string): string[] {
  const objects: string[] = [];

  let depth = 0;
  let topLevelFromIndex = -1;

  const upperSoql = soql.toUpperCase();
  for (let i = 0; i < soql.length; i++) {
    if (soql[i] === "(") {
      depth++;
    } else if (soql[i] === ")") {
      depth--;
    } else if (depth === 0) {
      if (
        upperSoql.startsWith("FROM", i) &&
        (i === 0 || /\s/.test(soql[i - 1])) &&
        i + 4 < soql.length &&
        /\s/.test(soql[i + 4])
      ) {
        topLevelFromIndex = i;
        break;
      }
    }
  }

  if (topLevelFromIndex === -1) {
    return objects;
  }

  const afterFrom = soql.slice(topLevelFromIndex);
  const topMatch = /\bFROM\s+(\w+)/i.exec(afterFrom);
  if (topMatch) {
    objects.push(topMatch[1]);
  }

  // Extract ALL FROM objects in the WHERE/HAVING region (after the top-level FROM).
  // This catches both simple semi-joins and nested subqueries.
  const whereClause = soql.slice(topLevelFromIndex + (topMatch ? topMatch[0].length : 4));
  const fromPattern = /\bFROM\s+(\w+)/gi;
  let subMatch;
  while ((subMatch = fromPattern.exec(whereClause)) !== null) {
    objects.push(subMatch[1]);
  }

  return objects;
}

/**
 * Validate a SOQL query for safety.
 *
 * @param soql - The SOQL query string.
 * @param allowedObjects - Set of allowed Salesforce object names (case-insensitive).
 * @returns Validation result.
 */
export function validateSOQL(
  soql: string,
  allowedObjects: Set<string>,
): { valid: boolean; error?: string } {
  // 0. Empty check
  const trimmed = soql.trim();
  if (!trimmed) {
    return { valid: false, error: "Empty query" };
  }

  // Reject semicolons (no statement chaining)
  if (trimmed.includes(";")) {
    return { valid: false, error: "Semicolons are not allowed in SOQL queries" };
  }

  // 1. Regex mutation guard — strip string literals first so keywords inside
  //    values like `WHERE Name = 'delete this'` don't trigger false positives.
  const stripped = stripStringLiterals(trimmed);
  for (const pattern of SOQL_FORBIDDEN_PATTERNS) {
    if (pattern.test(stripped)) {
      return {
        valid: false,
        error: `Forbidden SOQL operation detected: ${pattern.source}`,
      };
    }
  }

  // 2. Must start with SELECT
  if (!/^\s*SELECT\b/i.test(trimmed)) {
    return {
      valid: false,
      error: "Only SELECT queries are allowed in SOQL",
    };
  }

  // 3. Object whitelist (skip when empty — structural-only mode)
  if (allowedObjects.size === 0) {
    return { valid: true };
  }

  const objects = extractFromObjects(trimmed);
  if (objects.length === 0) {
    return { valid: false, error: "No FROM clause found in query" };
  }

  // Build lowercase allowed set for case-insensitive comparison
  const allowedLower = new Set(
    Array.from(allowedObjects).map((o) => o.toLowerCase()),
  );

  for (const obj of objects) {
    if (!allowedLower.has(obj.toLowerCase())) {
      return {
        valid: false,
        error: `Object "${obj}" is not in the allowed list. Check catalog.yml for available objects.`,
      };
    }
  }

  return { valid: true };
}

/**
 * Structural-only SOQL validation — checks SELECT-only, no DML, no semicolons.
 * Does NOT check the object whitelist. Used by `connection.validate()` where
 * the whitelist is applied separately by the querySalesforce tool.
 */
export function validateSOQLStructure(soql: string): { valid: boolean; error?: string } {
  return validateSOQL(soql, new Set());
}

/**
 * Append a LIMIT clause to a SOQL query if one is not already present.
 */
export function appendSOQLLimit(soql: string, limit: number): string {
  const trimmed = soql.trim();
  if (/\bLIMIT\b/i.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed} LIMIT ${limit}`;
}
