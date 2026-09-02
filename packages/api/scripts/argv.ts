/**
 * Argument parsing shared by the `scripts/` CLIs.
 *
 * Extracted at the third copy. `collect-eval-corpus.ts` and
 * `build-eval-fixture.ts` use it; `measure-triage.ts` still carries its own,
 * because it is being edited on a sibling branch and moving it here would put
 * a conflict in the middle of an unrelated review. Fold it in once both have
 * landed — the copies had already drifted, which is what makes this worth
 * doing at all: two guarded against a following `--other-flag` being swallowed
 * as a value and one did not.
 */

/**
 * The value after `--name`, or undefined when absent or immediately followed by
 * another flag.
 *
 * The `--`-prefix guard is what lets a flag be both valued and bare: `--record`
 * alone reads as present-with-no-value rather than consuming whatever came
 * next. Callers distinguish the two with {@link hasFlag}.
 */
export function flag(name: string, argv: readonly string[] = process.argv): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1 || index + 1 >= argv.length) return undefined;
  const value = argv[index + 1];
  return value !== undefined && !value.startsWith("--") ? value : undefined;
}

/** Whether `--name` appears at all, regardless of whether it carries a value. */
export function hasFlag(name: string, argv: readonly string[] = process.argv): boolean {
  return argv.includes(name);
}

/**
 * Every value given as `--name <value>`, so a flag may repeat.
 *
 * Repetition rather than a delimiter: a comma-separated list needs an escape
 * rule the first time a value contains a comma, and `--repo a --repo b` never
 * does.
 */
export function repeatedFlag(name: string, argv: readonly string[] = process.argv): string[] {
  const out: string[] = [];
  for (const [index, arg] of argv.entries()) {
    if (arg !== name) continue;
    const value = argv[index + 1];
    if (value !== undefined && !value.startsWith("--")) out.push(value);
  }
  return out;
}
