import { parseAsString } from "nuqs";

// Default to "" (not "default") so the page can auto-select the org's first
// visible connection once /admin/connections loads. Hardcoding "default" made
// every SaaS workspace land on the config-managed alias instead of their own
// `__demo__` / wizard-created connection.
export const schemaDiffSearchParams = {
  connection: parseAsString.withDefault(""),
};
