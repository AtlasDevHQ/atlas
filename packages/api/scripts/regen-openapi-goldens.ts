/**
 * Regenerate the OpenAPI semantic-generator golden YAML fixtures (#2931).
 *
 * The golden tests (`src/lib/openapi/__tests__/semantic-generator.test.ts`)
 * assert that `generateSemanticModel` + `renderEntityYaml` produce EXACTLY the
 * committed YAML for the Twenty fixture's entities. Regenerating those goldens
 * is deliberately an explicit command — NEVER automatic — so a behavioural
 * change to the generator surfaces as a reviewable golden diff in the PR rather
 * than silently passing.
 *
 * Usage (from packages/api):
 *   bun run openapi:regen-goldens
 *
 * Then review `git diff` on the golden/ dir before committing.
 */
import * as fs from "fs";
import * as path from "path";
import { buildOperationGraph } from "../src/lib/openapi/spec";
import { generateSemanticModel, renderEntityYaml } from "../src/lib/openapi/semantic-generator";

const TESTS_DIR = path.join(import.meta.dir, "..", "src", "lib", "openapi", "__tests__");
const SPEC_PATH = path.join(TESTS_DIR, "twenty-acceptance", "spec.json");
const GOLDEN_DIR = path.join(TESTS_DIR, "semantic-generator", "golden");

const spec = JSON.parse(fs.readFileSync(SPEC_PATH, "utf8"));
const graph = buildOperationGraph(spec);
const model = generateSemanticModel(graph);

fs.mkdirSync(GOLDEN_DIR, { recursive: true });

// Clear stale goldens first so a renamed/removed entity doesn't leave an orphan
// (the "no stale files" test assertion catches it otherwise, but cleaning here
// keeps the regen output authoritative).
for (const f of fs.readdirSync(GOLDEN_DIR)) {
  if (f.endsWith(".yml")) fs.rmSync(path.join(GOLDEN_DIR, f));
}

let written = 0;
for (const entity of model.entities) {
  const file = path.join(GOLDEN_DIR, `${entity.name}.yml`);
  fs.writeFileSync(file, renderEntityYaml(entity), "utf8");
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
  written++;
}

console.log(`\nRegenerated ${written} golden YAML file(s) from ${path.relative(process.cwd(), SPEC_PATH)}.`);
console.log("Review `git diff` before committing — a golden change means the generator's output changed.");
