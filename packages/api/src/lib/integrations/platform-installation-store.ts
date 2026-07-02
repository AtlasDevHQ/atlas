/**
 * PlatformInstallationStore — the single seam behind the Slack and
 * Discord installation stores.
 *
 * Both `lib/slack/store.ts` and `lib/discord/store.ts` persist the same
 * five-operation contract (`get` / `getByOrg` / `save` / `delete` /
 * `deleteByOrg`) over three shared invariants:
 *
 *   1. **decrypt-or-hide-row** — a stored credential that fails to
 *      decrypt hides the whole row (the parse returns null) instead of
 *      surfacing a broken install as connected. Captured by
 *      {@link decryptOrHide}, which both platform parsers route their
 *      cipher blob through.
 *   2. **org-hijack-safe upsert** — an upsert whose `WHERE org_id IS
 *      NULL OR org_id = $x` clause matched no row (the routing id is
 *      already bound to a different org) is rejected with one uniform
 *      error. The rejection lives HERE, in {@link PlatformInstallationStore.save},
 *      so the invariant has exactly one *implementation*; each backend
 *      only reports "row written?" as a boolean. (The real Slack and
 *      Discord backends still integration-test the rejection end-to-end
 *      through this seam — the point is structural centralization, not
 *      test exclusivity.)
 *   3. **single-tenant env fallback** — with no internal DB, `get`
 *      resolves from a platform env var rather than the table.
 *
 * The two platforms diverge only in **backend** (Slack's `chat_cache`
 * JSONB rows vs Discord's typed `discord_installations` columns) and
 * **cipher** — both captured by the injected {@link InstallationBackend}.
 * The two backends stay physically separate because their storage
 * shapes and ciphers differ: Slack's cipher/format in particular is
 * externally constrained by `@chat-adapter/slack` interop and the
 * "don't disturb working machinery" rationale (ADR-0003 § Alternatives),
 * so it cannot merge. (ADR-0003 itself decides the metadata-vs-
 * credentials store split, not the Slack-vs-Discord backend split — the
 * latter follows from the differing storage shapes, not the ADR.) This
 * seam unifies the *contract*, not the storage — one seam, two backend
 * adapters.
 */

import { hasInternalDB } from "@atlas/api/lib/db/internal";

/**
 * Minimal structural logger — satisfied by `pino.Logger`
 * (`createLogger(...)`). Kept local so the seam doesn't couple to the
 * concrete logger implementation and stays trivially fakeable in tests.
 */
export interface StoreLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Result of a decrypt-or-hide attempt. `ok: false` means the stored
 * ciphertext could not be decrypted and the caller must hide the whole
 * row (return null) rather than expose a broken install.
 */
export type DecryptResult = { ok: true; value: string } | { ok: false };

/**
 * The decrypt-or-hide-row policy in one place: decrypt the stored
 * cipher blob; on any failure, invoke `onError` (for a log line) and
 * return `{ ok: false }` so the caller drops the row. Type-narrows the
 * caught error to a message string on the caller's behalf.
 *
 * The "missing credential" case (Slack: hide; Discord: OAuth-only, keep
 * with `bot_token: null`) is intentionally NOT handled here — it
 * diverges per platform and stays in each parser. Only the shared
 * "present-but-undecryptable ⇒ hide" step is centralized.
 */
export function decryptOrHide<Cipher>(
  cipher: Cipher,
  decrypt: (c: Cipher) => string,
  onError: (message: string) => void,
): DecryptResult {
  try {
    return { ok: true, value: decrypt(cipher) };
  } catch (err) {
    onError(err instanceof Error ? err.message : String(err));
    return { ok: false };
  }
}

/**
 * Per-platform backend adapter. Owns the SQL and the cipher; the
 * generic store owns the control flow and the three invariants above.
 *
 * @typeParam Full - the with-secret record (e.g. `SlackInstallationWithSecret`).
 * @typeParam Public - the secret-stripped record returned by `getByOrg`.
 * @typeParam SaveInput - the platform-shaped save payload.
 */
export interface InstallationBackend<Full, Public, SaveInput> {
  /** Platform name for log/error text, e.g. `"Slack"` / `"Discord"`. */
  readonly name: string;
  /**
   * The noun the hijack error names, e.g. `"Slack workspace"` /
   * `"Guild"`. Rendered as `"<routingNoun> <id> is already bound to a
   * different organization."`.
   */
  readonly routingNoun: string;
  /**
   * Whether `delete(routingId)` requires an internal DB. Slack's delete
   * is a best-effort no-op + warning without one; Discord throws.
   * Preserves each store's pre-seam behavior.
   */
  readonly deleteRequiresInternalDb: boolean;

  /** SELECT + parse the record for a routing id; null when absent/hidden. */
  selectByRouting(routingId: string): Promise<Full | null>;
  /** SELECT + parse the record for an org; null when absent/hidden. */
  selectByOrg(orgId: string): Promise<Full | null>;
  /**
   * Org-hijack-safe atomic upsert. Returns `true` when a row was
   * written, `false` when the `WHERE org_id …` clause rejected a row
   * bound to a different org. Never throws for the hijack case — the
   * generic store maps `false` to the uniform rejection error.
   */
  upsert(routingId: string, input: SaveInput): Promise<boolean>;
  /** DELETE by routing id (internal-DB path only). */
  deleteByRouting(routingId: string): Promise<void>;
  /** DELETE by org; `true` when a row was removed. */
  deleteByOrg(orgId: string): Promise<boolean>;
  /** Single-tenant env-var fallback record, or null. */
  envFallback(routingId: string): Full | null;
  /**
   * Drop the secret field(s) for the public (org-scoped) shape.
   *
   * NOTE: the type system will NOT catch a passthrough — because every
   * `Full` (with-secret) type structurally extends its `Public`
   * counterpart, `toPublic: (full) => full` type-checks yet leaks the
   * secret. The `{ bot_token: _drop, ...pub }` destructuring in each
   * impl is the real guard; the store tests that assert the secret is
   * absent are load-bearing, not redundant.
   */
  toPublic(full: Full): Public;
}

/**
 * Generic installation store. Wraps a {@link InstallationBackend} with
 * the shared five-op control flow: internal-DB gates, uniform
 * error-log-and-rethrow, the env fallback, and the single org-hijack
 * rejection.
 */
export class PlatformInstallationStore<Full, Public, SaveInput> {
  constructor(
    private readonly backend: InstallationBackend<Full, Public, SaveInput>,
    private readonly log: StoreLogger,
  ) {}

  /**
   * Get the record for a routing id. Reads the internal DB first, then
   * falls back to the platform env var (single-tenant mode). A DB error
   * is logged and rethrown — it never falls through to the env var, so
   * a transient outage can't silently downgrade a multi-tenant deploy.
   */
  async get(routingId: string): Promise<Full | null> {
    if (!hasInternalDB()) return this.backend.envFallback(routingId);
    try {
      return await this.backend.selectByRouting(routingId);
    } catch (err) {
      this.log.error(
        { routingId, err: err instanceof Error ? err.message : String(err) },
        `Failed to load ${this.backend.name} installation`,
      );
      throw err;
    }
  }

  /**
   * Get the secret-stripped record for an org. Returns null when no
   * internal DB is configured (org-scoped lookups require one).
   */
  async getByOrg(orgId: string): Promise<Public | null> {
    if (!hasInternalDB()) return null;
    try {
      const full = await this.backend.selectByOrg(orgId);
      return full ? this.backend.toPublic(full) : null;
    } catch (err) {
      this.log.error(
        { orgId, err: err instanceof Error ? err.message : String(err) },
        `Failed to load ${this.backend.name} installation by org`,
      );
      throw err;
    }
  }

  /**
   * Save or update a record. Throws when no internal DB is configured,
   * or when the routing id is already bound to a different org (the
   * upsert matched no row) — the one place the org-hijack invariant is
   * enforced.
   */
  async save(routingId: string, input: SaveInput): Promise<void> {
    if (!hasInternalDB()) {
      throw new Error(
        `Cannot save ${this.backend.name} installation — no internal database configured`,
      );
    }
    let written: boolean;
    try {
      written = await this.backend.upsert(routingId, input);
    } catch (err) {
      this.log.error(
        { routingId, err: err instanceof Error ? err.message : String(err) },
        `Failed to save ${this.backend.name} installation`,
      );
      throw err;
    }
    if (!written) {
      // Auditable security event: someone tried to bind a routing id
      // already owned by another org. `warn`, not `error` — it's a user
      // error, not a system fault — but it must not be invisible.
      this.log.warn(
        { routingId },
        `Rejected ${this.backend.name} installation — routing id already bound to a different organization`,
      );
      throw new Error(
        `${this.backend.routingNoun} ${routingId} is already bound to a different organization. ` +
          "Disconnect the existing installation first.",
      );
    }
  }

  /**
   * Remove a record by routing id. Without an internal DB, Slack warns
   * and no-ops while Discord throws — governed by
   * {@link InstallationBackend.deleteRequiresInternalDb}.
   */
  async delete(routingId: string): Promise<void> {
    if (!hasInternalDB()) {
      if (this.backend.deleteRequiresInternalDb) {
        throw new Error(
          `Cannot delete ${this.backend.name} installation — no internal database configured`,
        );
      }
      this.log.warn(
        { routingId },
        `Cannot delete ${this.backend.name} installation — no internal database configured`,
      );
      return;
    }
    try {
      await this.backend.deleteByRouting(routingId);
    } catch (err) {
      this.log.error(
        { routingId, err: err instanceof Error ? err.message : String(err) },
        `Failed to delete ${this.backend.name} installation`,
      );
      throw err;
    }
  }

  /**
   * Remove the record for an org. Returns true when a row was deleted.
   * Throws when no internal DB is configured.
   */
  async deleteByOrg(orgId: string): Promise<boolean> {
    if (!hasInternalDB()) {
      throw new Error(
        `Cannot delete ${this.backend.name} installation — no internal database configured`,
      );
    }
    try {
      return await this.backend.deleteByOrg(orgId);
    } catch (err) {
      this.log.error(
        { orgId, err: err instanceof Error ? err.message : String(err) },
        `Failed to delete ${this.backend.name} installation by org`,
      );
      throw err;
    }
  }
}
