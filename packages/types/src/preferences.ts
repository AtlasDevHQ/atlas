/**
 * Per-user preference types shared across API, frontend, and SDK.
 *
 * `DEFAULT_LANDINGS` is the single source of truth for the legal value set —
 * the DB CHECK constraint, the Zod enum on the API, and the narrowing guards
 * on the web all reference this tuple so a future addition (`notebook`,
 * `reports`, ...) lands in one place instead of three.
 */

export const DEFAULT_LANDINGS = ["chat", "admin"] as const;
export type DefaultLanding = (typeof DEFAULT_LANDINGS)[number];

export function isDefaultLanding(value: unknown): value is DefaultLanding {
  return (
    typeof value === "string" &&
    (DEFAULT_LANDINGS as readonly string[]).includes(value)
  );
}

export interface UserPreferences {
  defaultLanding: DefaultLanding;
}
