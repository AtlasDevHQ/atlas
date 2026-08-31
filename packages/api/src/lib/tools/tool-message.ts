/**
 * The one shared piece of agent-facing message shaping.
 *
 * Three tools carried their own copy of this two-line function before #5571 —
 * `search-brain.ts`, `propose-fact.ts` and `correct-fact.ts`. It lives here
 * rather than in the staged-write seam because it is not gate logic: `searchBrain`
 * needs it and stages nothing, and pulling the confirm-token graph into a read
 * tool to borrow a string helper would be the wrong dependency in exchange for
 * the right deduplication.
 */

/**
 * Append the request id so the user has something to quote.
 *
 * CLAUDE.md requires a correlatable id on every failure a user can see. These
 * messages are the only thing standing between an incident and an operator
 * grepping blind — the server-side `log.error` is the only other trace, and
 * nothing correlates the two without this. `undefined` (a call outside a request
 * context) returns the message unchanged rather than printing an empty
 * parenthetical.
 */
export function withRequestId(message: string, requestId: string | undefined): string {
  return requestId ? `${message} (request ${requestId})` : message;
}
