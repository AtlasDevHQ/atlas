/**
 * The contract between a mutation list and {@link file://./mutate.ts}.
 *
 * Types only — no side effects, so a mutation list can import this without
 * dragging the CLI's argument parsing into a `bun test` process.
 *
 * The load-bearing decision here is that {@link MutationEdit} carries the exact
 * `oldString` / `newString`, never a prose description of the change. A
 * description has to be re-interpreted by whoever measures next, and two
 * defensible interpretations produce two different numbers under one label:
 * #5033 measured a denylist as `IS DISTINCT FROM 'warehouse'` in one file and
 * `<> 'warehouse'` in another — spellings that differ on exactly one input —
 * and published a cell true of neither. When the spelling IS the input, that
 * class cannot occur.
 */

/** One find-and-replace. `oldString` must appear EXACTLY once in `file`. */
export interface MutationEdit {
  /** Path relative to `packages/api`. */
  readonly file: string;
  /**
   * The exact text to replace. Must match once — see
   * {@link https://github.com/AtlasDevHQ/atlas/issues/5060}. A 0-match means
   * the source moved out from under the list; a 2-match means the runner
   * silently picked one of them and the reported count belongs to a mutation
   * nobody chose.
   */
  readonly oldString: string;
  /** The exact replacement. Must differ from `oldString`. */
  readonly newString: string;
}

/** A single mutation — one row of the generated table. */
export interface Mutation {
  /** The row's first cell. Markdown; backticks encouraged. */
  readonly label: string;
  readonly edits: readonly MutationEdit[];
  /**
   * Rendered as a footnote under the table. Use for the *why* of a surprising
   * count — a measured zero that is honest rather than missing, say. Never for
   * the count itself; that is generated.
   */
  readonly note?: string;
}

/** A suite the mutations are measured against — one column of the table. */
export interface MutationTarget {
  /** Column header. Keep it short: `here`, `corpus suite`. */
  readonly name: string;
  /** Test file path relative to `packages/api`. */
  readonly file: string;
  /**
   * Extra environment for this target's runs — a `-pg` suite's
   * `TEST_DATABASE_URL`, typically. Merged over `process.env`, so an operator
   * can still override from the shell.
   */
  readonly env?: Readonly<Record<string, string>>;
}

/** A whole generated table. One spec file per table. */
export interface MutationSpec {
  /** Rendered as the generated file's `#` heading. */
  readonly title: string;
  /** Where the markdown is written, relative to `packages/api`. */
  readonly out: string;
  /** One or more suites. Multi-target is how a mutation gets measured against
   * two files at once — the shape `promotion-pg.test.ts` needs, where a guard
   * is covered from two directions and the interesting fact is the DIFFERENCE
   * between the columns. */
  readonly targets: readonly MutationTarget[];
  readonly mutations: readonly Mutation[];
  /** Prose rendered between the heading and the table. */
  readonly preamble?: string;
}
