/**
 * The operator action tools' NAMES, and nothing else.
 *
 * Deliberately dependency-free: `registry.ts` builds its "action tools failed
 * to load" warnings from this list, and those warnings are needed precisely
 * when importing `./index` (and through it the five action modules) has
 * FAILED — so the names must be readable without loading any of them.
 *
 * Until this file existed the list lived as three hand-maintained copies in
 * `registry.ts` (two warning constants and a log line), which is three ways
 * for the model-facing copy to drift from what actually registers. The other
 * half of the contract lives in `./index`'s `ACTION_TOOLS`, and
 * `registry-actions.test.ts` pins the two to each other — so target #6 is one
 * name here, one entry there, and the warnings, registration and log copy all
 * follow.
 *
 * The names are registry names on purpose, not vendor labels: `sendEmailReport`
 * must stay distinguishable from the core `sendEmail`, `createLinearTicket`
 * from `createLinearIssue`, and `createSalesforceRecord` from
 * `querySalesforce` — those siblings SURVIVE an action-load failure, and a
 * category label ("the email tool") would disown a tool still in the list.
 */
export const ACTION_TOOL_NAMES = [
  "createJiraTicket",
  "createGitHubIssue",
  "createLinearTicket",
  "sendEmailReport",
  "createSalesforceRecord",
] as const;

export type ActionToolName = (typeof ACTION_TOOL_NAMES)[number];

/**
 * Every action TYPE a built-in module owns — the executor-registry keys, as
 * opposed to `ACTION_TOOL_NAMES`' registry names.
 *
 * Here rather than beside the modules for this file's founding reason: it must
 * be readable WITHOUT loading them. `wireActionPlugins` runs before the action
 * modules are imported (plugin wiring happens in the boot layer; the modules
 * load with `api/routes/actions.ts`), so a collision check that had to consult
 * the live registry would be answering a question about load order instead of
 * about ownership.
 *
 * ⚠️ A plugin may not claim one of these (#5570). An action executor decides
 * which system a payload is sent to and which workspace's credentials open it,
 * so "last registration wins" would mean an installed plugin could silently
 * receive every approved `email:send` — recipients, subject and body — for the
 * requester's workspace. Two in-tree plugins already declare these exact types
 * (`plugins/jira`, `plugins/email`), so this is a live collision, not a
 * hypothetical. Overriding a built-in's execution is a decision that deserves
 * its own design; until it has one, the refusal is the safe default and
 * `wiring.ts` logs it at error level.
 *
 * `actions-executor-boot.test.ts` pins this list against what the modules
 * actually register, so a sixth action cannot register a type this list
 * does not name.
 */
export const BUILTIN_ACTION_TYPES = [
  "jira:create",
  "github:create_issue",
  "linear:create",
  "salesforce:create",
  "email:send",
] as const;

export type BuiltinActionType = (typeof BUILTIN_ACTION_TYPES)[number];

/** Does a built-in module own `actionType`'s executor? */
export function isBuiltinActionType(actionType: string): actionType is BuiltinActionType {
  return (BUILTIN_ACTION_TYPES as readonly string[]).includes(actionType);
}
