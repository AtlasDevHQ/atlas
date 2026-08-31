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
