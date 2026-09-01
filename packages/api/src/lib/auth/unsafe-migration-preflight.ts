/**
 * Pre-flight for Better Auth's migrator: pre-create, as NULLABLE, any required
 * column it would otherwise refuse to add to a populated table.
 *
 * Better Auth refuses to `ALTER TABLE ... ADD COLUMN ... NOT NULL` with no
 * default when the table already has rows — correctly, because existing rows
 * have no value to backfill (and MySQL would silently fill them with an
 * implicit default instead of erroring). It raises `UnsafeMigrationError` and
 * its own message says what to do: *"Add the column as nullable, backfill a
 * correct value for every row, then make it NOT NULL."*
 *
 * Nothing did that, so a dependency bump became a deploy-blocking outage:
 * better-auth 1.6.25 -> 1.7.1 added a required `account.issuer`, every prod
 * region has a populated `account`, the throw set `_migrationError`, that
 * became an `INTERNAL_DB_UNREACHABLE` diagnostic, and under SaaS that arm makes
 * `/api/health` return 503 — which fails the Railway healthcheck for the full
 * 300s window and rolls the release back. All three regions, deterministically.
 * See issue 5580.
 *
 * This module does the nullable half automatically. It deliberately does NOT
 * backfill or add the NOT NULL constraint: only the schema's author knows what
 * a correct value is for an existing row, and guessing one is how you get a
 * column full of empty strings that reads as real data. The column lands
 * nullable, the boot proceeds, and the gap is logged loudly by name.
 *
 * ## Why this is safe against a *fresh* database
 *
 * On a fresh DB the table does not exist yet, so it is not "populated", so
 * Better Auth creates it whole — with the column already NOT NULL — and this
 * pre-flight does nothing. That asymmetry is also why CI never caught the
 * original bug: an empty `account` table makes the failure unreachable.
 *
 * ## Why the type map is duplicated rather than imported
 *
 * Better Auth does not export its DDL type mapping (`getType` is module-local
 * to `db/get-migration.mjs`; the exported `convertToDB`/`convertFromDB` are
 * value converters, not schema ones). The Postgres column types below are
 * copied from that function. A field type this map does not cover is SKIPPED,
 * not guessed — a wrongly-typed column is worse than the failure it prevents,
 * because Better Auth would then warn about a type mismatch forever while the
 * app reads the wrong shape. Skipped fields are returned so the caller can say
 * so, and the migration then fails exactly as it does today.
 */

import { getMigrations } from "better-auth/db/migration";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("auth-migrate-preflight");

/**
 * Better Auth's own field-attribute type, derived from the signature of
 * `getMigrations` rather than restated structurally. `DBFieldAttribute` lives in
 * `@better-auth/core`, which is a transitive dependency we do not declare, so
 * reaching for it directly would couple us to a package we do not control the
 * version of. Deriving it here gets the same compile-time coupling through the
 * export we already use: if the plan's field shape changes, this stops
 * compiling instead of silently routing every column into `skipped`.
 */
type PlanField = Awaited<ReturnType<typeof getMigrations>>["toBeAdded"][number]["fields"][string];

/**
 * Better Auth's own "is this change unsafe" predicate, mirrored exactly.
 *
 * `get-migration.mjs` asks:
 *
 *     field.required !== false && !hasTimestampColumnDefault(field, dbType)
 *                              && !hasStaticColumnDefault(field)
 *
 * The two default tests are NARROWER than "has a defaultValue", and the gap is
 * load-bearing. `hasStaticColumnDefault` holds only for string/number/boolean
 * with a non-null, non-function default; `hasTimestampColumnDefault` only for a
 * `date` with a FUNCTION default on postgres/mysql/mssql. So a required `json`
 * field carrying a default — or a `string` with a function default — is UNSAFE
 * to Better Auth while a naive `defaultValue !== undefined` check would wave it
 * through. This module reading the predicate more loosely than the migrator
 * that raises it is how the incident recurs silently from the module written to
 * prevent it, so the predicate is copied rather than approximated.
 */
function betterAuthWouldRefuse(field: PlanField): boolean {
  if (field.required === false) return false;

  const hasTimestampDefault = field.type === "date" && typeof field.defaultValue === "function";
  if (hasTimestampDefault) return false;

  // Better Auth's `hasStaticColumnDefault` opens with `!(field.unique &&
  // field.required === false)`. That term is UNREACHABLE here and is left out
  // deliberately rather than by oversight: it is a standalone function there,
  // called without narrowing, whereas this one has already returned above on
  // `required === false`, so the guard can only ever evaluate true. Keeping it
  // is a type error (TS2367 — `true | undefined` versus `false` do not
  // overlap), which is the compiler making the same argument.
  const hasStaticDefault =
    (field.type === "string" || field.type === "number" || field.type === "boolean") &&
    field.defaultValue !== undefined &&
    field.defaultValue !== null &&
    typeof field.defaultValue !== "function";
  return !hasStaticDefault;
}

/**
 * Postgres column type, mirroring Better Auth's own `getType()` — or `null`
 * when this module must not attempt the column at all.
 *
 * `null` covers three distinct refusals, and all three are deliberate:
 *
 *  - **A type the map does not cover** (`id`, arrays, anything a release adds).
 *    Guessing produces a wrongly-typed column that Better Auth then warns about
 *    forever while the app reads the wrong shape.
 *  - **A foreign key.** `getType()` returns its `foreignKeyId` type when
 *    `field.references?.field === "id"` — `uuid` or `integer GENERATED ...`
 *    depending on the instance's `useUUIDs`/`useNumberId`, neither of which is
 *    visible from a plan entry. `text` would be wrong exactly where a wrong type
 *    is hardest to undo.
 *  - **An indexed or unique field.** Better Auth creates the index in the SAME
 *    `toBeAdded` pass that adds the column. Pre-creating the column drops the
 *    field out of the next plan, so the index would never be created — silently
 *    and permanently. Refusing here keeps the column and its index together in
 *    the migrator's hands.
 */
function postgresType(field: PlanField): string | null {
  if (field.references) return null;
  if (field.index || field.unique) return null;

  switch (field.type) {
    case "string":
      return "text";
    case "boolean":
      return "boolean";
    case "number":
      return field.bigint ? "bigint" : "integer";
    case "date":
      return "timestamptz";
    case "json":
      return "jsonb";
    default:
      return null;
  }
}

/**
 * Quote a Postgres identifier. Better Auth's table and column names come from
 * its own schema (and from `modelName` overrides in our auth config), never
 * from request input — but these strings are interpolated into DDL, which
 * cannot take bind parameters, so they are validated rather than trusted.
 */
function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(
      `Refusing to build DDL for identifier ${JSON.stringify(name)} — not a plain SQL identifier`,
    );
  }
  return `"${name}"`;
}

async function tableIsPopulated(table: string): Promise<boolean> {
  // `LIMIT 1` rather than COUNT(*): this runs on every boot and the answer is
  // a boolean, so a sequential scan of a large table is wasted work.
  const rows = await internalQuery<{ present: number }>(
    `SELECT 1 AS present FROM ${quoteIdent(table)} LIMIT 1`,
  );
  return rows.length > 0;
}

export interface PreflightResult {
  /** `table.column` for each column added as nullable. */
  added: string[];
  /** `table.column` for each unsafe column whose type this map cannot express. */
  skipped: string[];
  /** Better Auth's own refusal messages, verbatim, when it reported any. */
  unsafeChanges: string[];
}

/**
 * Add, as nullable, every required-with-no-default column Better Auth would
 * refuse to add to a populated table.
 *
 * Never throws for a migration reason: this runs BEFORE the real migration, and
 * a pre-flight that turns a recoverable boot into a crashed one has made things
 * worse. Anything it cannot handle is logged and left to `runMigrations()`,
 * which fails exactly as it does today.
 */
export async function preflightUnsafeColumns(
  options: Parameters<typeof getMigrations>[0],
): Promise<PreflightResult> {
  const result: PreflightResult = { added: [], skipped: [], unsafeChanges: [] };

  let plan: Awaited<ReturnType<typeof getMigrations>>;
  try {
    // `throwOnUnsafe: false` is the whole point — it returns the plan plus the
    // refusals in `unsafeChanges` instead of throwing, which is what lets us
    // repair them before the executing call runs.
    plan = await getMigrations(options, { throwOnUnsafe: false });
  } catch (err) {
    // A plan we cannot even build (index conflict, adapter mismatch) is not
    // ours to repair. Let the real migration report it.
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Could not build the Better Auth migration plan — skipping unsafe-column pre-flight",
    );
    return result;
  }

  result.unsafeChanges = [...plan.unsafeChanges];
  if (plan.unsafeChanges.length === 0) return result;

  for (const { table, fields } of plan.toBeAdded) {
    // Asked once per TABLE, not once per column: the answer cannot change
    // within this loop (adding a column does not add rows), and a per-column
    // query would be n round-trips on every boot for no new information.
    // Resolved lazily so a table with no unsafe columns costs nothing.
    let populated: boolean | undefined;

    for (const [name, field] of Object.entries(fields)) {
      // Better Auth's own predicate, not a looser paraphrase of it — see
      // `betterAuthWouldRefuse`. A field it would accept needs no repair.
      if (!betterAuthWouldRefuse(field)) continue;

      // From here the field IS one Better Auth will refuse, so every path out
      // of this block must record a disposition. A bare `continue` here is the
      // silent drop this module exists to prevent: the migration would still
      // fail and nothing would have said which column did it.
      const columnType = postgresType(field);
      if (!columnType) {
        result.skipped.push(`${table}.${name}`);
        continue;
      }

      try {
        populated ??= await tableIsPopulated(table);
        // Not populated: Better Auth creates or alters it safely on its own.
        // Not a refusal, so not `skipped` — but the loop is done with it.
        if (!populated) continue;
        await internalQuery(
          `ALTER TABLE ${quoteIdent(table)} ADD COLUMN IF NOT EXISTS ${quoteIdent(name)} ${columnType}`,
        );
        result.added.push(`${table}.${name}`);
      } catch (err) {
        // A table that does not exist yet lands here too (fresh DB, racing
        // creation) — that is fine, Better Auth will create it whole.
        log.warn(
          { table, column: name, err: err instanceof Error ? err.message : String(err) },
          "Could not pre-create an unsafe Better Auth column as nullable — leaving it to the migration",
        );
        result.skipped.push(`${table}.${name}`);
      }
    }
  }

  if (result.added.length > 0) {
    log.warn(
      { columns: result.added, unsafeChanges: result.unsafeChanges },
      "Added required Better Auth column(s) as NULLABLE so the migration could proceed — " +
        "existing rows hold NULL. Backfill a correct value and add the NOT NULL constraint " +
        "in a numbered migration; until then these columns are nullable in the database and " +
        "required in Better Auth's schema.",
    );
  }
  if (result.skipped.length > 0) {
    log.error(
      { columns: result.skipped, unsafeChanges: result.unsafeChanges },
      "Better Auth refused to add required column(s) to populated table(s) and the pre-flight " +
        "could not repair them — the migration below will fail and managed auth will not work",
    );
  }

  return result;
}
