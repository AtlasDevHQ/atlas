/**
 * Salesforce DataSource adapter via jsforce.
 *
 * Salesforce uses SOQL, not SQL, so it cannot be a DBConnection (which has
 * `query(sql)`). Instead, it exposes a separate DataSource interface and
 * a separate registry.
 *
 * Connection URL format: salesforce://user:pass@login.salesforce.com?token=TOKEN
 */

import type { QueryResult, ConnectionMetadata } from "@atlas/api/lib/db/connection";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("salesforce");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SObjectInfo {
  name: string;
  label: string;
  queryable: boolean;
}

export interface SObjectField {
  name: string;
  type: string;
  label: string;
  picklistValues: { value: string; label: string; active: boolean }[];
  referenceTo: string[];
  nillable: boolean;
  length: number;
}

export interface SObjectDescribe {
  name: string;
  label: string;
  fields: SObjectField[];
}

export interface SalesforceConfig {
  loginUrl: string;
  username: string;
  password: string;
  securityToken?: string;
  clientId?: string;
  clientSecret?: string;
}

export interface SalesforceDataSource {
  query(soql: string, timeoutMs?: number): Promise<QueryResult>;
  describe(objectName: string): Promise<SObjectDescribe>;
  listObjects(): Promise<SObjectInfo[]>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// URL parser
// ---------------------------------------------------------------------------

/**
 * Parse a Salesforce connection URL into SalesforceConfig.
 *
 * Format: salesforce://user:pass@login.salesforce.com?token=TOKEN
 *
 * - hostname → loginUrl (default `login.salesforce.com`)
 * - URL username/password → credentials
 * - Query params: `token` (security token), `clientId`, `clientSecret`
 */
export function parseSalesforceURL(url: string): SalesforceConfig {
  const parsed = new URL(url);
  if (parsed.protocol !== "salesforce:") {
    throw new Error(
      `Invalid Salesforce URL: expected salesforce:// scheme, got "${parsed.protocol}"`,
    );
  }

  const username = decodeURIComponent(parsed.username);
  if (!username) {
    throw new Error("Invalid Salesforce URL: missing username.");
  }

  const password = decodeURIComponent(parsed.password);
  if (!password) {
    throw new Error("Invalid Salesforce URL: missing password.");
  }

  const hostname = parsed.hostname || "login.salesforce.com";
  const loginUrl = `https://${hostname}`;

  const securityToken = parsed.searchParams.get("token") ?? undefined;
  const clientId = parsed.searchParams.get("clientId") ?? undefined;
  const clientSecret = parsed.searchParams.get("clientSecret") ?? undefined;

  return { loginUrl, username, password, securityToken, clientId, clientSecret };
}

// ---------------------------------------------------------------------------
// DataSource factory
// ---------------------------------------------------------------------------

/**
 * Create a Salesforce DataSource backed by jsforce.
 */
export function createSalesforceDataSource(
  config: SalesforceConfig,
): SalesforceDataSource {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let jsforce: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    jsforce = require("jsforce");
  } catch {
    throw new Error(
      "Salesforce support requires the jsforce package. Install it with: bun add jsforce",
    );
  }

  const connOpts: Record<string, unknown> = {
    loginUrl: config.loginUrl,
  };

  if (config.clientId && config.clientSecret) {
    connOpts.oauth2 = {
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      loginUrl: config.loginUrl,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const conn = new jsforce.Connection(connOpts) as any;

  let loginPromise: Promise<void> | null = null;

  async function ensureLoggedIn(): Promise<void> {
    if (loginPromise) return loginPromise;
    loginPromise = (async () => {
      const loginPassword = config.securityToken
        ? config.password + config.securityToken
        : config.password;
      try {
        await conn.login(config.username, loginPassword);
      } catch (err) {
        loginPromise = null;
        log.error(
          {
            err: err instanceof Error ? err : new Error(String(err)),
            loginUrl: config.loginUrl,
            username: config.username,
          },
          "Salesforce login failed",
        );
        throw err;
      }
      log.info("Salesforce login successful");
    })();
    return loginPromise;
  }

  function isSessionExpiredError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message;
    return (
      msg.includes("INVALID_SESSION_ID") ||
      msg.includes("Session expired") ||
      msg.includes("session has expired")
    );
  }

  async function withSessionRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (isSessionExpiredError(err)) {
        log.warn("Salesforce session expired — re-authenticating and retrying");
        loginPromise = null;
        await ensureLoggedIn();
        return await fn();
      }
      throw err;
    }
  }

  return {
    async query(soql: string, timeoutMs = 30000): Promise<QueryResult> {
      return withSessionRetry(async () => {
        await ensureLoggedIn();

        let timeoutId: ReturnType<typeof setTimeout>;
        const result = await Promise.race([
          conn.query(soql),
          new Promise<never>((_, reject) => {
            timeoutId = setTimeout(
              () => reject(new Error("Salesforce query timed out")),
              timeoutMs,
            );
          }),
        ]).finally(() => clearTimeout(timeoutId!));

        const records = (result.records ?? []) as Record<string, unknown>[];

        if (records.length === 0) {
          return { columns: [], rows: [] };
        }

        // Extract columns from first record, filtering out the `attributes` metadata key
        const columns = Object.keys(records[0]).filter(
          (k) => k !== "attributes",
        );

        const rows = records.map((record) => {
          const row: Record<string, unknown> = {};
          for (const col of columns) {
            row[col] = record[col];
          }
          return row;
        });

        return { columns, rows };
      });
    },

    async describe(objectName: string): Promise<SObjectDescribe> {
      return withSessionRetry(async () => {
        await ensureLoggedIn();
        const desc = await conn.describe(objectName);
        return {
          name: desc.name,
          label: desc.label,
          fields: (desc.fields ?? []).map(
            (f: Record<string, unknown>) => ({
              name: f.name as string,
              type: f.type as string,
              label: f.label as string,
              picklistValues: Array.isArray(f.picklistValues)
                ? f.picklistValues.map(
                    (pv: Record<string, unknown>) => ({
                      value: pv.value as string,
                      label: pv.label as string,
                      active: pv.active as boolean,
                    }),
                  )
                : [],
              referenceTo: Array.isArray(f.referenceTo)
                ? (f.referenceTo as string[])
                : [],
              nillable: f.nillable as boolean,
              length: (f.length as number) ?? 0,
            }),
          ),
        };
      });
    },

    async listObjects(): Promise<SObjectInfo[]> {
      return withSessionRetry(async () => {
        await ensureLoggedIn();
        const result = await conn.describeGlobal();
        return (result.sobjects ?? [])
          .filter((obj: Record<string, unknown>) => obj.queryable === true)
          .map((obj: Record<string, unknown>) => ({
            name: obj.name as string,
            label: obj.label as string,
            queryable: true,
          }));
      });
    },

    async close(): Promise<void> {
      if (loginPromise) {
        try {
          await loginPromise;
          await conn.logout();
        } catch (err) {
          log.warn(
            { err: err instanceof Error ? err.message : String(err) },
            "Failed to logout from Salesforce",
          );
        }
        loginPromise = null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Source registry (parallel to ConnectionRegistry)
// ---------------------------------------------------------------------------

const _sources = new Map<string, SalesforceDataSource>();

export function registerSalesforceSource(
  id: string,
  config: SalesforceConfig,
): void {
  const existing = _sources.get(id);
  const newSource = createSalesforceDataSource(config);
  _sources.set(id, newSource);
  if (existing) {
    existing.close().catch((err) => {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), sourceId: id },
        "Failed to close previous Salesforce source during re-registration",
      );
    });
  }
}

export function getSalesforceSource(id: string): SalesforceDataSource {
  const source = _sources.get(id);
  if (!source) {
    throw new Error(`Salesforce source "${id}" is not registered.`);
  }
  return source;
}

export function listSalesforceSources(): string[] {
  return Array.from(_sources.keys());
}

/** Return ConnectionMetadata for each registered Salesforce source. */
export function describeSalesforceSources(): ConnectionMetadata[] {
  return Array.from(_sources.keys()).map((id) => ({
    id,
    dbType: "salesforce" as const,
  }));
}

/** Test helper — clears all registered sources. */
export function _resetSalesforceSources(): void {
  for (const [id, source] of _sources.entries()) {
    source.close().catch((err) => {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), sourceId: id },
        "Failed to close Salesforce source during registry reset",
      );
    });
  }
  _sources.clear();
}
