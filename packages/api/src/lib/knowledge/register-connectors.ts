/**
 * Boot-time registration of the built-in Knowledge Sync Connectors (#4377,
 * ADR-0030). Confluence is the first real connector — before this, the registry
 * had no non-test callers. Called from the same boot seams as
 * `registerBuiltinInstallHandlers` (`api/index.ts`, `mcp-lifecycle.ts`).
 *
 * Idempotent by construction: it registers a connector only when the registry
 * doesn't already have its catalog id, so double-invocation (two boot seams in
 * one process) can't hit `registerKnowledgeSyncConnector`'s duplicate-id throw,
 * and a test that `_resetKnowledgeSyncConnectors()` between runs re-registers
 * cleanly on the next boot call.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { getKnowledgeSyncConnector, registerKnowledgeSyncConnector } from "./connectors";
import { createConfluenceConnector } from "./confluence/connector";
import { CONFLUENCE_CATALOG_ID } from "./confluence/config";

const log = createLogger("knowledge.register-connectors");

/** Register every built-in Knowledge Sync Connector. Safe to call repeatedly. */
export function registerBuiltinKnowledgeConnectors(): void {
  if (getKnowledgeSyncConnector(CONFLUENCE_CATALOG_ID) === undefined) {
    registerKnowledgeSyncConnector(createConfluenceConnector());
    log.info("Registered Confluence Knowledge Sync Connector");
  }
}
