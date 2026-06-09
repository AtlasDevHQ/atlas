/**
 * SOQL validation for the OAuth per-Workspace Salesforce path (#3311).
 *
 * A core-local copy of the SOQL validator. The canonical static-datasource
 * validator lives in `@useatlas/salesforce` (`plugins/salesforce/src/validation.ts`),
 * but core `@atlas/api` CANNOT import that plugin package: the create-atlas
 * standalone template bundles core's `src/` while its dependency closure
 * excludes workspace plugin packages (they're not published to npm), so a
 * `@useatlas/salesforce` import breaks the scaffold build. The OAuth path is a
 * core concern (its lazy-builder already lives in core), so the validator is
 * duplicated here intentionally. Keep the two in sync — both enforce identical
 * SELECT-only / no-DML / object-whitelist semantics.
 *
 * Validation layers:
 *   0. Empty check / no semicolons
 *   1. Regex mutation guard (INSERT/UPDATE/DELETE/UPSERT/MERGE/UNDELETE)
 *   2. Must start with SELECT
 *   3. Object whitelist — FROM object must be in the allowed set (empty set →
 *      structural-only)
 */

// Exported so the cross-package drift-check test (#3325) can assert this list
// stays byte-for-byte equal to plugins/salesforce/src/validation.ts — the two
// are deliberately duplicated (core can't import the workspace plugin).
export const SOQL_FORBIDDEN_PATTERNS: readonly RegExp[] = Object.freeze([
  /\b(INSERT)\b/i,
  /\b(UPDATE)\b/i,
  /\b(DELETE)\b/i,
  /\b(UPSERT)\b/i,
  /\b(MERGE)\b/i,
  /\b(UNDELETE)\b/i,
]);

/**
 * Sensitive error patterns — scrub error messages before returning them to the
 * agent so credentials / hostnames / internal details don't leak. Mirrors
 * `@atlas/api/lib/security.ts` SENSITIVE_PATTERNS and the plugin's copy.
 */
export const SENSITIVE_PATTERNS =
  /password|secret|credential|connection.?string|SSL|certificate|INVALID_SESSION_ID|LOGIN_MUST_USE_SECURITY_TOKEN|INVALID_LOGIN|INVALID_CLIENT_ID|Authentication failed/i;

/**
 * Strip single-quoted string literals so regex guards / FROM extraction / LIMIT
 * detection don't match keywords embedded in user values (e.g.
 * `WHERE Name = 'delete this'`, `WHERE Name = 'from X'`, `WHERE Name = 'LIMIT'`).
 * Handles SOQL backslash escapes (`\'`, `\\`) so an escaped quote doesn't split
 * the literal mid-value and leak trailing tokens.
 */
function stripStringLiterals(soql: string): string {
  // Single-pass scan (no regex) — replaces each complete '...' literal with ''.
  // Done by hand rather than a quoted-string regex so there is no pattern for a
  // ReDoS analyzer to flag, and it is provably linear. Honors SOQL `\` escapes
  // (`\'`, `\\`) so an escaped quote doesn't end the literal early. An
  // unterminated literal is left as-is (mirrors a regex that requires a close).
  let out = "";
  let i = 0;
  const n = soql.length;
  while (i < n) {
    if (soql[i] !== "'") {
      out += soql[i];
      i++;
      continue;
    }
    // At an opening quote — scan for the close, skipping escaped chars.
    let j = i + 1;
    let closed = false;
    while (j < n) {
      if (soql[j] === "\\") {
        j += 2;
        continue;
      }
      if (soql[j] === "'") {
        closed = true;
        break;
      }
      j++;
    }
    if (!closed) {
      // Unterminated — leave the remainder untouched.
      out += soql.slice(i);
      break;
    }
    out += "''";
    i = j + 1;
  }
  return out;
}

/**
 * Extract top-level object names referenced in FROM clauses.
 *
 * Parent-to-child relationship subqueries — `(SELECT ... FROM Contacts)` inside
 * the SELECT list — use relationship (plural) names not in the object whitelist;
 * Salesforce enforces object-level security server-side for those, so nested
 * FROM inside parenthesized subqueries is skipped. Semi-join / anti-join
 * subqueries in WHERE — `WHERE Id IN (SELECT ... FROM Contact)` — reference real
 * object names and ARE checked.
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
 * @param allowedObjects - Allowed Salesforce object names (case-insensitive).
 *   An empty set means structural-only (no per-object membership check).
 */
export function validateSOQL(
  soql: string,
  allowedObjects: Set<string>,
): { valid: boolean; error?: string } {
  const trimmed = soql.trim();
  if (!trimmed) {
    return { valid: false, error: "Empty query" };
  }

  if (trimmed.includes(";")) {
    return { valid: false, error: "Semicolons are not allowed in SOQL queries" };
  }

  // Regex mutation guard — strip string literals first so keywords inside values
  // like `WHERE Name = 'delete this'` don't trigger false positives.
  const stripped = stripStringLiterals(trimmed);
  for (const pattern of SOQL_FORBIDDEN_PATTERNS) {
    if (pattern.test(stripped)) {
      return {
        valid: false,
        error: `Forbidden SOQL operation detected: ${pattern.source}`,
      };
    }
  }

  if (!/^\s*SELECT\b/i.test(trimmed)) {
    return { valid: false, error: "Only SELECT queries are allowed in SOQL" };
  }

  // Object whitelist (skip when empty — structural-only mode)
  if (allowedObjects.size === 0) {
    return { valid: true };
  }

  // Extract against the literal-stripped form so parens / FROM inside quoted
  // values (e.g. `WHERE Description = 'order from Supplier'`) can't skew depth
  // tracking or inject phantom objects that fail the whitelist.
  const objects = extractFromObjects(stripped);
  if (objects.length === 0) {
    return { valid: false, error: "No FROM clause found in query" };
  }

  const allowedLower = new Set(Array.from(allowedObjects).map((o) => o.toLowerCase()));
  for (const obj of objects) {
    if (!allowedLower.has(obj.toLowerCase())) {
      return {
        valid: false,
        error: `Object "${obj}" is not in the allowed list. Check the semantic layer for available objects.`,
      };
    }
  }

  return { valid: true };
}

/**
 * Append a LIMIT clause to a SOQL query if one is not already present. Detection
 * runs against the literal-stripped form and requires `LIMIT <number>`, so the
 * word LIMIT inside a string value (e.g. `WHERE Name = 'no LIMIT here'`) can't
 * suppress the auto-cap — every query stays bounded by ROW_LIMIT.
 */
export function appendSOQLLimit(soql: string, limit: number): string {
  const trimmed = soql.trim();
  if (/\bLIMIT\s+\d+\b/i.test(stripStringLiterals(trimmed))) {
    return trimmed;
  }
  return `${trimmed} LIMIT ${limit}`;
}
