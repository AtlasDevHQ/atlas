/**
 * Concern 2 of 4 — bounded failure-detail narrowing.
 *
 * Before this module, `jira.ts` and `github.ts` each carried the full
 * `!response.ok → json → text → slice(0, 200)` block verbatim, `linear.ts`
 * carried the text-only half of it, and the 200-char truncation itself was
 * open-coded at four more sites in `lib/email/delivery.ts` — plus others
 * outside this arc's scope. This is its one definition.
 *
 * ── Why 200 characters, and what the bound is NOT ────────────────────────
 *
 * The bound exists to keep an agent-visible error SMALL, not to redact it. A
 * vendor's error body reaches the model's context, the approval card and
 * `action_log.error`; an unbounded one can be a full HTML error page. 200
 * characters is enough for every real vendor error message and short enough
 * that a runaway body cannot crowd the turn.
 *
 * It is emphatically **not** a secrecy control. If an upstream ever reflected
 * the request headers back, truncation would not save us — the rule that does
 * is that these modules never put a credential into a string in the first
 * place (Salesforce goes further and redacts every vendor string it did not
 * compose — a habit it kept when #5572 moved it off `jsforce`, since the
 * error bodies are just as much the vendor's now). Do not reach for a bigger
 * number here
 * because a message got clipped: read the log, which carries the same detail
 * under the same bound and is not in the agent's context.
 *
 * @see ./index.ts — the spine's scope, and what it deliberately does NOT own.
 */

import type { VendorHttpFailure } from "./result";

/** The one bound. See the module header for why it is 200 and not 2000. */
export const FAILURE_DETAIL_MAX_CHARS = 200;

export function truncateFailureDetail(raw: string): string {
  return raw.slice(0, FAILURE_DETAIL_MAX_CHARS);
}

/**
 * Read an already-failed response's body as text, never throwing.
 *
 * The body of a failed response may be unreadable or already consumed, and
 * the status alone is enough to report — so this returns `""` rather than
 * turning a vendor's 500 into a parse error the caller did not ask about.
 */
export async function readFailureText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    // intentionally ignored: the body of an already-failed response may be
    // unreadable or already consumed, and the status alone is enough to report.
    return "";
  }
}

/**
 * The text fallback: `HTTP <status>: <bounded body>`, or `HTTP <status>` when
 * there is no readable body.
 */
export async function describeFailureText(response: Response): Promise<string> {
  const rawText = await readFailureText(response);
  return rawText
    ? `HTTP ${response.status}: ${truncateFailureDetail(rawText)}`
    : `HTTP ${response.status}`;
}

/**
 * Narrow a non-2xx response into the discriminated `http` failure.
 *
 * `describeBody` is the vendor's structured extractor — the half that differs
 * per vendor (Jira's `{ errorMessages, errors }`, GitHub's `{ message,
 * errors[] }`). It runs inside the same `try` as the JSON parse deliberately:
 * an extractor that walks a shape the vendor did not send throws exactly like
 * a malformed body does, and both want the same text fallback. Omit it for a
 * vendor whose error bodies have no structure worth reading (Linear's
 * transport-level failures).
 *
 * ⚠️ **With an extractor, the text fallback degrades to `HTTP <status>`.**
 * `response.json()` consumes the body whether or not it parses, so there is
 * nothing left for `text()` to read. This is preserved behaviour, not a bug
 * introduced here — `jira.ts` and `github.ts` both had this exact shape, and
 * #5569 was required to change no wire copy. Making the fallback reachable
 * means cloning the response before the parse, which changes agent-visible
 * error text for every vendor with an extractor: a product decision that
 * wants its own issue. Pinned in `__tests__/vendor-http.test.ts` so it stays
 * a known limitation rather than a surprise. The no-extractor path is
 * unaffected and does carry the bounded body.
 */
export async function describeHttpFailure(
  response: Response,
  describeBody?: (body: unknown, status: number) => string,
): Promise<VendorHttpFailure> {
  const status = response.status;
  if (!describeBody) {
    return { reason: "http", status, detail: await describeFailureText(response) };
  }
  let detail: string;
  try {
    detail = describeBody(await response.json(), status);
  } catch {
    // intentionally ignored: an unparseable body and a shape the extractor
    // could not walk are the same condition here, and neither the error nor
    // its message adds anything to the status this already carries. Nothing
    // is logged — the caller logs the returned failure, once, with its own
    // vendor context.
    detail = await describeFailureText(response);
  }
  return { reason: "http", status, detail };
}
