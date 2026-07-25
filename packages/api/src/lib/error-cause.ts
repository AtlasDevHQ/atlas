/**
 * Walking an error's `cause` chain — the shared half of "log what actually
 * broke" (#4773).
 *
 * ## Why this is its own module
 *
 * It lived in `lib/auth/effective-role.ts` for about an hour, which broke two
 * test suites at LINK time: that module is `mock.module`'d by four files, and a
 * partial factory fails the moment anything in the import graph reaches an
 * export it does not list. A pure, dependency-free utility should not ride on a
 * heavily-mocked auth module and force every one of those factories to grow a
 * stub for it. Here, nothing mocks it and nothing has to.
 *
 * ## Why walking beats `err.cause`
 *
 * Wrapper depth is not fixed. A brain read wraps twice
 * (`BrainRoleUnresolvedError` → `MemberRoleLookupError` → driver error); the
 * auth resolver wraps once. A hard-coded single hop therefore logs the WRAPPER
 * from the two-deep site — and these wrappers deliberately carry no information
 * beyond ids the log payload already has, so the driver text that says what
 * actually failed (`connection reset by peer`, `statement timeout`,
 * `relation "member" does not exist`) never lands anywhere.
 */

/**
 * The deepest `cause` in an error chain, or the value itself when there is none.
 *
 * Bounded: `cause` chains are built by this codebase, but a cycle would spin
 * forever and a helper that exists to make LOGGING better must not be able to
 * hang a request. On a cycle it returns whichever link the bound lands on —
 * arbitrary, and better than not returning.
 */
export function rootCause(err: unknown): unknown {
  let current = err;
  for (let depth = 0; depth < 8; depth++) {
    if (!(current instanceof Error) || current.cause === undefined) return current;
    current = current.cause;
  }
  return current;
}

/**
 * The root cause's message, when it adds something the wrapper did not.
 *
 * Returns `undefined` for an unwrapped error so a caller logging both `err` and
 * `cause` does not print the same sentence twice.
 */
export function rootCauseMessage(err: unknown): string | undefined {
  const cause = rootCause(err);
  if (cause === err) return undefined;
  return cause instanceof Error ? cause.message : String(cause);
}
