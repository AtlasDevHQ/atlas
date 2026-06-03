/**
 * Dashboard parameter binding (#2267 — parameters slice).
 *
 * SECURITY-CRITICAL. This module is the single chokepoint that turns a card's
 * `:<key>` placeholders + the viewer's parameter values into a PARAMETERIZED
 * query: the SQL string gets the placeholders rewritten to the driver's
 * positional form (`$N` for PostgreSQL, `?` for MySQL) and the values come back
 * as an ordered bind array. Values are NEVER interpolated into the SQL text —
 * they reach the database only through the driver's bind protocol, so the
 * injection surface stays exactly as closed as the rest of the SQL pipeline
 * (CLAUDE.md SQL validation rules).
 *
 * Flow:
 *   1. `resolveDashboardParameterValues` — coerce/validate the viewer's values
 *      against the dashboard's declared parameters, filling defaults
 *      (relative-date expressions resolved server-side to concrete dates).
 *   2. `bindDashboardParameters` — rewrite `:<key>` → `$N`/`?` and align the
 *      resolved values into the bind array. Both the rewritten SQL (validated +
 *      executed) and the bind array thread through the existing
 *      `runUserQueryPipeline`.
 *
 * Parameter binding is supported on the core PostgreSQL and MySQL adapters
 * only; the pipeline rejects parameterized execution on other (plugin)
 * datasources rather than risk an unbound placeholder or a silent fallback.
 */

import type { DashboardParameter, DashboardParameterType } from "@useatlas/types";

export type { DashboardParameter, DashboardParameterType };

/** Dialects that support positional bind parameters in the core query path. */
export type BindableDbType = "postgres" | "mysql";

/** Narrow a resolved `DBType` to the dialects that support parameter binding. */
export function isBindableDbType(dbType: string): dbType is BindableDbType {
  return dbType === "postgres" || dbType === "mysql";
}

/**
 * Thrown when a card's parameters cannot be resolved or bound: an undeclared
 * `:placeholder`, an invalid value for a parameter's type, or an unparseable
 * relative-date default. Fail-closed — callers surface it as a validation
 * error and NEVER fall back to string interpolation.
 */
export class DashboardParameterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DashboardParameterError";
  }
}

// ---------------------------------------------------------------------------
// Placeholder scanner
// ---------------------------------------------------------------------------

/**
 * Walk `sql` once and rewrite every `:<name>` placeholder to the dialect's
 * positional form, returning the rewritten SQL and the ordered list of
 * placeholder names to bind against.
 *
 * The scanner is deliberately conservative: it skips colons that are part of
 *   - `::` PostgreSQL type casts,
 *   - single-quoted string literals (`'...'`, with `''` escaping; MySQL also
 *     honours backslash escapes),
 *   - double-quoted identifiers (`"..."`, PostgreSQL) and backtick identifiers
 *     (`` `...` ``, MySQL),
 *   - line comments (`-- ...`) and C-style block comments.
 * Over-skipping (treating SQL as string content) is safe — it can only leave a
 * `:name` un-rewritten, which fails loudly at bind time. Under-skipping is the
 * danger we guard against.
 *
 * Binding semantics differ by dialect:
 *   - PostgreSQL uses numbered placeholders, so a name used more than once
 *     reuses the same `$N` and appears ONCE in `names`.
 *   - MySQL uses positional `?`, so each occurrence emits a `?` and the name
 *     appears once per occurrence in `names`.
 */
export function rewriteNamedPlaceholders(
  sql: string,
  dbType: BindableDbType,
): { sql: string; names: string[] } {
  const out: string[] = [];
  const names: string[] = [];
  // PostgreSQL only: name → assigned $N (for reuse of repeated placeholders).
  const pgAssigned = new Map<string, number>();
  const isPg = dbType === "postgres";

  const isIdentStart = (ch: string) => /[A-Za-z_]/.test(ch);
  const isIdentPart = (ch: string) => /[A-Za-z0-9_]/.test(ch);

  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];

    // --- string literals / quoted identifiers / comments: copy verbatim ---
    if (ch === "'") {
      out.push(ch);
      i++;
      while (i < n) {
        const c = sql[i];
        if (c === "\\" && dbType === "mysql") {
          // MySQL backslash escape — copy the escape + escaped char.
          out.push(c);
          if (i + 1 < n) out.push(sql[i + 1]);
          i += 2;
          continue;
        }
        if (c === "'") {
          // `''` is an escaped quote — stay in the string.
          if (sql[i + 1] === "'") {
            out.push("''");
            i += 2;
            continue;
          }
          out.push(c);
          i++;
          break;
        }
        out.push(c);
        i++;
      }
      continue;
    }
    if (ch === '"') {
      out.push(ch);
      i++;
      while (i < n) {
        const c = sql[i];
        out.push(c);
        i++;
        if (c === '"') {
          if (sql[i] === '"') {
            out.push('"');
            i++;
            continue;
          }
          break;
        }
      }
      continue;
    }
    if (ch === "`") {
      out.push(ch);
      i++;
      while (i < n) {
        const c = sql[i];
        out.push(c);
        i++;
        if (c === "`") {
          if (sql[i] === "`") {
            out.push("`");
            i++;
            continue;
          }
          break;
        }
      }
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      // Line comment — copy to end of line.
      while (i < n && sql[i] !== "\n") {
        out.push(sql[i]);
        i++;
      }
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      out.push("/*");
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) {
        out.push(sql[i]);
        i++;
      }
      if (i < n) {
        out.push("*/");
        i += 2;
      }
      continue;
    }

    // --- colon handling ---
    if (ch === ":") {
      // `::` PostgreSQL cast — copy both colons, do not treat as placeholder.
      if (sql[i + 1] === ":") {
        out.push("::");
        i += 2;
        continue;
      }
      // `:<name>` placeholder.
      if (i + 1 < n && isIdentStart(sql[i + 1])) {
        let j = i + 1;
        while (j < n && isIdentPart(sql[j])) j++;
        const name = sql.slice(i + 1, j);
        if (isPg) {
          let idx = pgAssigned.get(name);
          if (idx === undefined) {
            names.push(name);
            idx = names.length; // 1-based
            pgAssigned.set(name, idx);
          }
          out.push(`$${idx}`);
        } else {
          names.push(name);
          out.push("?");
        }
        i = j;
        continue;
      }
      // Bare colon (e.g. array slice with numeric bounds) — copy verbatim.
      out.push(ch);
      i++;
      continue;
    }

    out.push(ch);
    i++;
  }

  return { sql: out.join(""), names };
}

/** Return the distinct `:<name>` placeholder names referenced in `sql`. */
export function extractPlaceholderNames(sql: string): string[] {
  // Dialect doesn't matter for name extraction; postgres dedupes.
  return rewriteNamedPlaceholders(sql, "postgres").names;
}

// ---------------------------------------------------------------------------
// Binding
// ---------------------------------------------------------------------------

/**
 * Rewrite `:<key>` placeholders to positional binds and produce the aligned
 * bind-value array. Every placeholder MUST have a value in `resolvedValues`
 * (produced by {@link resolveDashboardParameterValues}); an undeclared
 * placeholder throws {@link DashboardParameterError} rather than emitting an
 * unbound positional that would either error at the driver or — far worse —
 * tempt a string-interpolation fallback.
 */
export function bindDashboardParameters(
  sql: string,
  resolvedValues: Record<string, unknown>,
  dbType: BindableDbType,
): { sql: string; values: unknown[] } {
  const { sql: rewritten, names } = rewriteNamedPlaceholders(sql, dbType);
  const values: unknown[] = [];
  for (const name of names) {
    if (!Object.prototype.hasOwnProperty.call(resolvedValues, name)) {
      throw new DashboardParameterError(
        `Card references undeclared parameter ":${name}". Declare it in the dashboard's parameters.`,
      );
    }
    values.push(resolvedValues[name]);
  }
  return { sql: rewritten, values };
}

// ---------------------------------------------------------------------------
// Value resolution + coercion
// ---------------------------------------------------------------------------

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?/;

/** Format a Date as a UTC `YYYY-MM-DD` string. */
function toIsoDate(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Resolve a `date` default expression to a concrete `YYYY-MM-DD` string —
 * server-side, never passed to SQL as text. Supported grammar
 * (case-insensitive, `now()` and `now` interchangeable):
 *   - `now` | `now()` | `today`            → the reference date
 *   - `now - <N> day[s]|week[s]|month[s]|year[s]`  (also `+`)
 *   - an ISO date (`YYYY-MM-DD`) or ISO datetime (date portion is used)
 * Anything else throws {@link DashboardParameterError}.
 */
export function resolveDateExpression(expr: string, now: Date): string {
  const raw = expr.trim();
  if (ISO_DATE_RE.test(raw)) return raw;
  if (ISO_DATETIME_RE.test(raw)) return raw.slice(0, 10);

  const normalized = raw.toLowerCase().replace(/\(\s*\)/g, ""); // now() → now
  if (normalized === "now" || normalized === "today") {
    return toIsoDate(now);
  }

  const m = normalized.match(
    /^now\s*([+-])\s*(\d+)\s*(day|days|week|weeks|month|months|year|years)$/,
  );
  if (m) {
    const sign = m[1] === "-" ? -1 : 1;
    const amount = sign * parseInt(m[2], 10);
    const unit = m[3];
    // Work from the UTC date components so the math is timezone-stable.
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    if (unit.startsWith("day")) d.setUTCDate(d.getUTCDate() + amount);
    else if (unit.startsWith("week")) d.setUTCDate(d.getUTCDate() + amount * 7);
    else if (unit.startsWith("month")) d.setUTCMonth(d.getUTCMonth() + amount);
    else if (unit.startsWith("year")) d.setUTCFullYear(d.getUTCFullYear() + amount);
    return toIsoDate(d);
  }

  throw new DashboardParameterError(
    `Invalid date default "${expr}". Use an ISO date (YYYY-MM-DD) or a relative expression like "now - 30 days".`,
  );
}

/** Coerce + validate one supplied value against a parameter type. */
function coerceValue(
  param: DashboardParameter,
  value: string | number | null,
): string | number | null {
  if (value === null) return null;
  switch (param.type) {
    case "date": {
      const s = typeof value === "number" ? String(value) : value;
      if (ISO_DATE_RE.test(s)) return s;
      if (ISO_DATETIME_RE.test(s)) return s.slice(0, 10);
      throw new DashboardParameterError(
        `Parameter "${param.key}" expects a date (YYYY-MM-DD), got "${value}".`,
      );
    }
    case "number": {
      const num = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(num)) {
        throw new DashboardParameterError(
          `Parameter "${param.key}" expects a number, got "${value}".`,
        );
      }
      return num;
    }
    case "text": {
      const s = typeof value === "number" ? String(value) : value;
      if (s.length > 1000) {
        throw new DashboardParameterError(
          `Parameter "${param.key}" exceeds the 1000-character limit.`,
        );
      }
      return s;
    }
    default: {
      const _exhaustive: never = param.type;
      throw new DashboardParameterError(`Unsupported parameter type "${_exhaustive}".`);
    }
  }
}

/** Resolve a parameter's default to a concrete bind value. */
function resolveDefault(param: DashboardParameter, now: Date): string | number | null {
  if (param.default === null || param.default === undefined) return null;
  switch (param.type) {
    case "date":
      return resolveDateExpression(String(param.default), now);
    case "number": {
      const num = typeof param.default === "number" ? param.default : Number(param.default);
      if (!Number.isFinite(num)) {
        throw new DashboardParameterError(
          `Parameter "${param.key}" has a non-numeric default "${param.default}".`,
        );
      }
      return num;
    }
    case "text":
      return String(param.default);
    default: {
      const _exhaustive: never = param.type;
      throw new DashboardParameterError(`Unsupported parameter type "${_exhaustive}".`);
    }
  }
}

/**
 * Resolve the final bind value for every declared parameter: the viewer's
 * supplied value (coerced + validated) when present, otherwise the parameter's
 * server-resolved default. Values supplied for keys that aren't declared are
 * ignored — only declared parameters can reach SQL.
 *
 * `now` defaults to the current time; tests pass a fixed instant for
 * deterministic relative-date resolution.
 */
export function resolveDashboardParameterValues(
  definitions: DashboardParameter[] | null | undefined,
  provided: Record<string, string | number | null> | undefined,
  now: Date = new Date(),
): Record<string, string | number | null> {
  const resolved: Record<string, string | number | null> = {};
  for (const param of definitions ?? []) {
    const hasSupplied =
      provided != null && Object.prototype.hasOwnProperty.call(provided, param.key);
    resolved[param.key] = hasSupplied
      ? coerceValue(param, provided![param.key])
      : resolveDefault(param, now);
  }
  return resolved;
}
