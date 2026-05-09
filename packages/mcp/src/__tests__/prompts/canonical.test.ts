/**
 * Unit tests for the canonical-questions prompt loader (#2076).
 *
 * The loader reads `eval/canonical-questions/questions.yml`, derives a
 * stable per-question slug, and shapes each entry like the existing
 * `library-{id}` prompt. These tests pin the slug strategy and
 * description format so future refactors don't silently rename
 * registered prompts (which agent picker UIs would treat as new IDs).
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  loadCanonicalPrompts,
  CANONICAL_PROMPT_PREFIX,
  type CanonicalPrompt,
} from "../../prompts/canonical.js";

let tmpRoot: string;
let originalEnv: string | undefined;

function writeQuestions(yamlBody: string): string {
  const file = path.join(tmpRoot, "questions.yml");
  fs.writeFileSync(file, yamlBody, "utf8");
  return file;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "canonical-prompts-"));
  originalEnv = process.env.ATLAS_CANONICAL_QUESTIONS_PATH;
});

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env.ATLAS_CANONICAL_QUESTIONS_PATH;
  } else {
    process.env.ATLAS_CANONICAL_QUESTIONS_PATH = originalEnv;
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("loadCanonicalPrompts", () => {
  it("returns [] when the file does not exist", () => {
    const result = loadCanonicalPrompts({
      path: path.join(tmpRoot, "missing.yml"),
    });
    expect(result).toEqual([]);
  });

  it("returns [] when the file is malformed YAML", () => {
    const file = writeQuestions("questions:\n  - id: cq-001\n   bad indentation");
    const result = loadCanonicalPrompts({ path: file });
    expect(result).toEqual([]);
  });

  it("returns [] when `questions` is missing or not a list", () => {
    const file = writeQuestions("version: '1.0'\n");
    expect(loadCanonicalPrompts({ path: file })).toEqual([]);

    fs.writeFileSync(file, "questions: not-a-list\n");
    expect(loadCanonicalPrompts({ path: file })).toEqual([]);
  });

  it("derives slug from metric_id for `mode: metric`", () => {
    const file = writeQuestions(`
questions:
  - id: cq-001
    category: simple_metric
    question: What is our total GMV?
    mode: metric
    metric_id: total_gmv
`);
    const [prompt] = loadCanonicalPrompts({ path: file });
    expect(prompt!.name).toBe("canonical-total-gmv");
  });

  it("derives slug from entity + pattern for `mode: pattern`", () => {
    const file = writeQuestions(`
questions:
  - id: cq-016
    category: filtered_pattern
    question: How does promotion usage affect order value?
    mode: pattern
    entity: Orders
    pattern: orders_with_promotions
`);
    const [prompt] = loadCanonicalPrompts({ path: file });
    expect(prompt!.name).toBe("canonical-orders-orders-with-promotions");
  });

  it("derives slug from entity + dimension for `mode: virtual`", () => {
    const file = writeQuestions(`
questions:
  - id: cq-011
    category: virtual_dimension
    question: How are orders distributed by size bucket?
    mode: virtual
    entity: Orders
    dimension: order_size_bucket
`);
    const [prompt] = loadCanonicalPrompts({ path: file });
    expect(prompt!.name).toBe("canonical-orders-order-size-bucket");
  });

  it("derives slug from term for `mode: glossary`", () => {
    const file = writeQuestions(`
questions:
  - id: cq-013
    category: glossary
    question: Show me revenue last quarter
    mode: glossary
    term: revenue
`);
    const [prompt] = loadCanonicalPrompts({ path: file });
    expect(prompt!.name).toBe("canonical-glossary-revenue");
  });

  it("falls back to the question id when mode-specific fields are missing", () => {
    const file = writeQuestions(`
questions:
  - id: cq-099
    category: simple_metric
    question: An exotic question with no metric_id
    mode: metric
`);
    const [prompt] = loadCanonicalPrompts({ path: file });
    expect(prompt!.name).toBe("canonical-cq-099");
  });

  it("skips entries with missing id, question, or mode", () => {
    const file = writeQuestions(`
questions:
  - id: cq-001
    question: Has no mode
  - id: cq-002
    mode: metric
  - mode: metric
    question: Has no id
  - id: cq-003
    question: Valid entry
    mode: metric
    metric_id: total_gmv
`);
    const result = loadCanonicalPrompts({ path: file });
    expect(result.length).toBe(1);
    expect(result[0]!.name).toBe("canonical-total-gmv");
  });

  it("description includes the question text and eval mode", () => {
    const file = writeQuestions(`
questions:
  - id: cq-001
    category: simple_metric
    question: What is our total GMV?
    mode: metric
    metric_id: total_gmv
`);
    const [prompt] = loadCanonicalPrompts({ path: file });
    expect(prompt!.description).toContain("What is our total GMV?");
    expect(prompt!.description.toLowerCase()).toContain("deterministic");
  });

  it("flags glossary questions as `llm` eval mode", () => {
    const file = writeQuestions(`
questions:
  - id: cq-013
    category: glossary
    question: Show me revenue last quarter
    mode: glossary
    term: revenue
`);
    const [prompt] = loadCanonicalPrompts({ path: file });
    expect(prompt!.evalMode).toBe("llm");
    expect(prompt!.description.toLowerCase()).toContain("llm");
  });

  it("question text is preserved verbatim for prompts/get", () => {
    const file = writeQuestions(`
questions:
  - id: cq-007
    category: join
    question: What is our revenue split between DTC and marketplace?
    mode: metric
    metric_id: revenue_dtc_vs_marketplace
`);
    const [prompt] = loadCanonicalPrompts({ path: file });
    expect(prompt!.question).toBe(
      "What is our revenue split between DTC and marketplace?",
    );
  });

  it("loads all 20 prompts from the real eval/canonical-questions/questions.yml", () => {
    // The default path resolution walks up from this file.
    const result = loadCanonicalPrompts();
    expect(result.length).toBe(20);

    // Names are unique — a duplicate would mean an MCP `prompts/list` call
    // returns two entries with the same name and the second registration
    // would silently overwrite the first.
    const names = new Set(result.map((p) => p.name));
    expect(names.size).toBe(20);

    // Every name uses the canonical- prefix.
    for (const p of result) {
      expect(p.name.startsWith(CANONICAL_PROMPT_PREFIX)).toBe(true);
    }
  });

  // #2185 — runtime invariant check that mirrors the type-level
  // discrimination. Every prompt loaded from the real YAML must satisfy
  // `sourceMode === "glossary"` ↔ `evalMode === "llm"`.
  it("every loaded prompt satisfies the sourceMode↔evalMode invariant", () => {
    const result = loadCanonicalPrompts();
    expect(result.length).toBeGreaterThan(0);
    for (const p of result) {
      if (p.sourceMode === "glossary") {
        expect(p.evalMode).toBe("llm");
      } else {
        expect(p.evalMode).toBe("deterministic");
      }
    }
  });

  // #2185 — narrowing on `sourceMode` at the consumer side compiles only
  // because the type is a discriminated union. If a future refactor
  // collapses the arms, the `evalMode` literal narrowing here will fail
  // type-check rather than silently re-widen.
  it("narrowing on sourceMode produces a literal evalMode (compile-time)", () => {
    function narrow(p: CanonicalPrompt): "llm" | "deterministic" {
      if (p.sourceMode === "glossary") {
        // Type system narrows evalMode to the literal "llm" here. The
        // explicit annotation documents the narrowing — collapsing the
        // discriminated union back to a flat shape would fail this line.
        const evalMode: "llm" = p.evalMode;
        return evalMode;
      }
      const evalMode: "deterministic" = p.evalMode;
      return evalMode;
    }
    const [first] = loadCanonicalPrompts();
    if (first) {
      const result = narrow(first);
      expect(["llm", "deterministic"]).toContain(result);
    }
  });
});

describe("CanonicalPrompt discriminated union (#2185)", () => {
  // Helper that forces TS to check the value against the full union — a
  // bare `const x: CanonicalPrompt = {...}` lets contextual typing widen
  // and sometimes admits invalid combinations; passing through a typed
  // parameter keeps the union check strict.
  function asPrompt(p: CanonicalPrompt): CanonicalPrompt {
    return p;
  }

  it("rejects mismatched sourceMode + evalMode at compile time", () => {
    // glossary must pair with llm.
    // @ts-expect-error — deterministic evalMode on the glossary arm violates the union.
    asPrompt({
      name: "x",
      description: "x",
      question: "x",
      category: null,
      sourceMode: "glossary",
      evalMode: "deterministic",
    });

    // metric (and any non-glossary mode) must pair with deterministic.
    // @ts-expect-error — llm evalMode on the non-glossary arm violates the union.
    asPrompt({
      name: "x",
      description: "x",
      question: "x",
      category: null,
      sourceMode: "metric",
      evalMode: "llm",
    });

    // The closed sourceMode union rejects unknown literals — the
    // constructor normalizes to "other", so a bare unknown string in
    // a typed literal must not compile.
    asPrompt({
      name: "x",
      description: "x",
      question: "x",
      category: null,
      // @ts-expect-error — "exotic_future_mode" is not a member of CanonicalSourceMode.
      sourceMode: "exotic_future_mode",
      evalMode: "deterministic",
    });

    // The well-formed arms compile without error — sanity-check the
    // negative tests above by exercising both arms positively.
    const glossary = asPrompt({
      name: "x",
      description: "x",
      question: "x",
      category: null,
      sourceMode: "glossary",
      evalMode: "llm",
    });
    const metric = asPrompt({
      name: "x",
      description: "x",
      question: "x",
      category: null,
      sourceMode: "metric",
      evalMode: "deterministic",
    });
    expect(glossary.evalMode).toBe("llm");
    expect(metric.evalMode).toBe("deterministic");
  });
});
