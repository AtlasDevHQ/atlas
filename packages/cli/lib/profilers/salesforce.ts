/**
 * Salesforce profiler — CLI shim over the plugin profiler (ADR-0017).
 *
 * The SOQL profiling logic now lives in the Salesforce plugin package
 * (`plugins/salesforce/src/profiler.ts`), exposed on `connection.listObjects` /
 * `connection.profile` and resolved off the registry by the host. The CLI
 * consumes that SAME export directly (CLI → plugin), so this module is a thin
 * adapter mapping the CLI's positional `(connectionString, filterTables,
 * prefetchedObjects, progress)` signature onto the plugin's url-based options
 * object — keeping `init.ts` / `diff.ts` call sites unchanged.
 *
 * The plugin profiler types are structural mirrors of the canonical
 * `@useatlas/types` profiler contracts (which `@atlas/api/lib/profiler`
 * re-exports), so the plugin's `PluginProfilingResult` / `PluginDatabaseObject`
 * flow back as `ProfilingResult` / `DatabaseObject` by structural typing.
 */

import type {
  DatabaseObject,
  ProfilingResult,
} from "@atlas/api/lib/profiler";
import {
  listSalesforceObjects as listSalesforceObjectsPlugin,
  profileSalesforce as profileSalesforcePlugin,
} from "../../../../plugins/salesforce/src/index";
import type { ProfileProgressCallbacks } from "../../src/progress";

export async function listSalesforceObjects(
  connectionString: string,
): Promise<DatabaseObject[]> {
  return listSalesforceObjectsPlugin({ url: connectionString });
}

export async function profileSalesforce(
  connectionString: string,
  filterTables?: string[],
  prefetchedObjects?: DatabaseObject[],
  progress?: ProfileProgressCallbacks,
): Promise<ProfilingResult> {
  return profileSalesforcePlugin({
    url: connectionString,
    selectedTables: filterTables,
    prefetchedObjects,
    progress,
  });
}
