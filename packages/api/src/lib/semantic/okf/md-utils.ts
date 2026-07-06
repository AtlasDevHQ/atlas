/**
 * The api's binding of the OKF wire module's mechanical frontmatter splitter
 * (`@atlas/okf-bundle/wire`) to `js-yaml` — bound ONCE here so the two OKF
 * parsers that share it (the strict spike parser in `./frontmatter.ts` +
 * `./parse.ts` and the lenient ingest parser in `knowledge/parse-lenient.ts`)
 * cannot drift on how YAML is parsed.
 *
 * Everything else this module used to declare (`RESERVED_BASENAMES`,
 * `mdBasename`, `topLevelHeading`) single-homed into the wire module in
 * #4373 — import those from `@atlas/okf-bundle/wire` directly. The wire
 * module is a zero-dependency leaf; YAML parsing is injected (which is what
 * keeps `@atlas/okf-bundle`'s runtime deps to `fflate` alone), and this file
 * is the injection point.
 */

import * as yaml from "js-yaml";
import {
  splitFrontmatterBlock as splitFrontmatterBlockWith,
  type FrontmatterBlockSplit,
} from "@atlas/okf-bundle/wire";

export type { FrontmatterBlockSplit };

/** The wire module's mechanical three-way split, with js-yaml bound. */
export function splitFrontmatterBlock(content: string): FrontmatterBlockSplit {
  return splitFrontmatterBlockWith(content, (raw) => yaml.load(raw));
}
