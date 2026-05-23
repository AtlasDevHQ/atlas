import { parseAsStringEnum } from "nuqs";

/**
 * Tab state for the Usage dashboard. "plan" shows the workspace's plan
 * limits and per-user query counts; "tokens" surfaces LLM token consumption
 * (previously `/admin/token-usage`). The Cmd+K palette deep-links to either
 * via `?tab=plan` / `?tab=tokens`.
 */
export const usageSearchParams = {
  tab: parseAsStringEnum(["plan", "tokens"]).withDefault("plan"),
};
