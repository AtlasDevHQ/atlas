/**
 * Persona fixture parser for `atlas ops smoke-crm`.
 *
 * Reads a YAML document of personas and returns the discriminated union of
 * `LeadEvent` variants the saas-crm dispatcher consumes. Validation is
 * intentionally manual (rather than zod / similar) so the error messages
 * point at the offending persona index — a typo on persona 7 of 10 should
 * say "persona[6].planInterest is required for source=sales-form", not a
 * generic schema-violation blob.
 *
 * The fixture is operator-authored, not user input, so it's safe to fail
 * loudly on the first invalid persona — there's no "partial best-effort"
 * mode here. A broken fixture is always an operator typo.
 */
import { readFileSync } from "node:fs";

import { load as parseYaml } from "js-yaml";

import type {
  ConversionLeadEvent,
  DemoLeadEvent,
  LeadEvent,
  SalesFormLeadEvent,
  SignupLeadEvent,
} from "@useatlas/twenty/lead-normalizer";

/** Top-level YAML shape. */
interface FixtureDoc {
  readonly personas: ReadonlyArray<Record<string, unknown>>;
}

export class FixtureParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixtureParseError";
  }
}

/** Path-prefixed throw helper — keeps the index visible at every error. */
function fail(personaIndex: number, message: string): never {
  throw new FixtureParseError(`persona[${personaIndex}]: ${message}`);
}

function requireString(
  personaIndex: number,
  obj: Record<string, unknown>,
  key: string,
): string {
  const value = obj[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(personaIndex, `${key} is required and must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(
  personaIndex: number,
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    fail(personaIndex, `${key} must be a string when present`);
  }
  return value;
}

function parseSalesFormPersona(
  personaIndex: number,
  raw: Record<string, unknown>,
): SalesFormLeadEvent {
  return {
    source: "sales-form",
    email: requireString(personaIndex, raw, "email"),
    name: requireString(personaIndex, raw, "name"),
    company: requireString(personaIndex, raw, "company"),
    planInterest: requireString(personaIndex, raw, "planInterest"),
    message: requireString(personaIndex, raw, "message"),
    ip: optionalString(personaIndex, raw, "ip") ?? null,
    userAgent: optionalString(personaIndex, raw, "userAgent") ?? null,
  };
}

function parseDemoPersona(
  personaIndex: number,
  raw: Record<string, unknown>,
): DemoLeadEvent {
  return {
    source: "demo",
    email: requireString(personaIndex, raw, "email"),
    ip: optionalString(personaIndex, raw, "ip") ?? null,
    userAgent: optionalString(personaIndex, raw, "userAgent") ?? null,
  };
}

function parseSignupPersona(
  personaIndex: number,
  raw: Record<string, unknown>,
): SignupLeadEvent {
  const name = optionalString(personaIndex, raw, "name");
  return {
    source: "signup",
    email: requireString(personaIndex, raw, "email"),
    ...(name ? { name } : {}),
  };
}

function parseConversionPersona(
  personaIndex: number,
  raw: Record<string, unknown>,
): ConversionLeadEvent {
  return {
    source: "conversion",
    email: requireString(personaIndex, raw, "email"),
    stripeCustomerId: requireString(personaIndex, raw, "stripeCustomerId"),
  };
}

/** Pure entry point — `text` is a YAML string. Throws `FixtureParseError`. */
export function parseFixtureYaml(text: string): LeadEvent[] {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new FixtureParseError(
      `YAML parse failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!doc || typeof doc !== "object") {
    throw new FixtureParseError("fixture root must be an object with a `personas` key");
  }
  const personas = (doc as FixtureDoc).personas;
  if (!Array.isArray(personas)) {
    throw new FixtureParseError("fixture root must have a `personas` array");
  }
  if (personas.length === 0) {
    throw new FixtureParseError("fixture must contain at least one persona");
  }

  const out: LeadEvent[] = [];
  for (let i = 0; i < personas.length; i++) {
    const raw = personas[i];
    if (!raw || typeof raw !== "object") {
      throw new FixtureParseError(`persona[${i}]: must be an object`);
    }
    const source = (raw as Record<string, unknown>).source;
    if (typeof source !== "string") {
      fail(i, "source is required and must be a string");
    }
    const record = raw as Record<string, unknown>;
    switch (source) {
      case "sales-form":
        out.push(parseSalesFormPersona(i, record));
        break;
      case "demo":
        out.push(parseDemoPersona(i, record));
        break;
      case "signup":
        out.push(parseSignupPersona(i, record));
        break;
      case "conversion":
        out.push(parseConversionPersona(i, record));
        break;
      default:
        fail(
          i,
          `unknown source "${source}" — expected one of: sales-form, demo, signup, conversion`,
        );
    }
  }
  return out;
}

/** Read fixture from disk and parse. Errors surface unchanged. */
export function loadFixture(path: string): LeadEvent[] {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (err) {
    throw new FixtureParseError(
      `cannot read fixture file at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parseFixtureYaml(text);
}
