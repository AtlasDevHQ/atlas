#!/usr/bin/env bun
// check-docs-brain-snippets.ts — published `Brain*` contract snippets in
// apps/docs must name the same members as the real declarations (#5165).
//
// ## Why this exists
//
// `guides/brain-connector-authoring.mdx` opens with the sentence "This page is
// the contract" and then hand-copies `BrainSourceConnector` into a ```ts fence.
// It drifted: the real interface grew a fourth, NON-OPTIONAL member —
// `readonly audience: BrainSourceAudienceFor<S>` (#4985) — and the page never
// did. An author following the page writes a connector that fails registration,
// or, on a class the compile-time narrowing cannot reach, one that mints
// `audience:` grants nothing refreshes: the 168h-then-invisible failure that
// seam exists to prevent. A hand-copied interface on a page that calls itself
// the contract will drift again, so the copy is checked rather than trusted.
//
// ## What it compares, and what it deliberately does NOT
//
// MEMBER NAMES plus OPTIONALITY, per declaration. Not types.
//
// That boundary is the whole reason this gate can exist without being exempted
// later. A doc snippet legitimately simplifies types — the real
// `BrainSourceConnector` is generic in `S` and its `source` is `S`, where a
// reader is better served by seeing what `S` ranges over — so byte-comparing
// type text would fail on correct prose, and a gate that fails on correct prose
// gets an exemption comment instead of a fix. Names and optionality are the axis
// the #5165 drift lived on: a member that is absent, renamed, or shown as `?`
// when the real one is required is a page telling an author something false
// about what they must write. A type that has been simplified for exposition is
// not.
//
// ## Both sides are DISCOVERED, never enumerated
//
// Source side: every exported interface and type alias named `Brain*` under
// `packages/api/src/lib/brain/**`. Doc side: every ```ts fence in
// `apps/docs/content/**/*.mdx` that declares a `Brain*` interface or type alias.
// So a new brain guide, or a fourth snippet on an existing one, enrolls itself.
//
// A doc snippet naming a `Brain*` declaration that no longer exists in source is
// a FAILURE, not a skip — a snippet for a renamed or deleted interface is the
// same lie as one missing a member.
//
// ## Type aliases: two analyzable shapes, and a loud refusal outside them
//
// `BrainSourceAudience` is the second half of the #5165 drift — its two arms
// (`reverified` / `externally-synced`) were never shown at all — so a union has
// to be comparable or half the finding stays unguarded. Two shapes are handled:
// a union of string literals, and a discriminated union of object literals keyed
// on a string-literal `kind`. Anything else FAILS with an instruction to extend
// this guard, rather than silently comparing nothing: a union shape this script
// cannot read is exactly where an omitted arm would hide.
//
// ## Vacuity floor
//
// `BrainSourceConnector` MUST be among the compared declarations. Every other
// check here is discovered, so a page rename, a fence relabelled from ```ts, or
// a regex that stops matching would leave this gate green while comparing
// nothing — and the one snippet whose absence means the contract page has lost
// its contract is that one. `scripts/__tests__/check-docs-brain-snippets.test.sh`
// probes exactly that.
//
// Run locally: bun scripts/check-docs-brain-snippets.ts

import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Glob } from "bun";
import ts from "typescript";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

const SOURCE_GLOB = "packages/api/src/lib/brain/**/*.ts";
const DOCS_GLOB = "apps/docs/content/**/*.mdx";

/** Only declarations in the product's own `Brain*` namespace are contracts. */
const CONTRACT_NAME = /^Brain[A-Z]/;

/**
 * The one declaration whose absence means the contract page stopped publishing
 * its contract — the vacuity floor. See the header.
 */
const REQUIRED_DECLARATION = "BrainSourceConnector";

/** A declaration reduced to the axis this gate compares. */
type Shape =
  /** An interface: member names, each with its optionality. */
  | { readonly kind: "members"; readonly members: ReadonlySet<string> }
  /** A union this gate can read: the set of arms, each as a printable token. */
  | { readonly kind: "union"; readonly arms: ReadonlySet<string> };

interface Declared {
  readonly shape: Shape;
  /** Repo-relative path the declaration was read from, for error messages. */
  readonly where: string;
}

function parse(text: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, /* setParentNodes */ true);
}

/**
 * An interface's members as `name` / `name?` tokens.
 *
 * Index signatures, call signatures and constructors carry no name to compare,
 * so they are represented by their kind — two declarations that differ only by
 * gaining one still differ in this set, which is the property that matters.
 */
function interfaceShape(node: ts.InterfaceDeclaration): Shape {
  const members = new Set<string>();
  for (const member of node.members) {
    if (ts.isIndexSignatureDeclaration(member)) {
      members.add("[index]");
      continue;
    }
    if (ts.isCallSignatureDeclaration(member)) {
      members.add("[call]");
      continue;
    }
    if (ts.isConstructSignatureDeclaration(member)) {
      members.add("[construct]");
      continue;
    }
    const name = member.name;
    if (name === undefined) {
      // Any other unnamed member shape. Recorded rather than dropped so it
      // cannot be the difference this gate is blind to.
      members.add(`[unnamed:${ts.SyntaxKind[member.kind]}]`);
      continue;
    }
    const optional =
      (ts.isPropertySignature(member) || ts.isMethodSignature(member)) &&
      member.questionToken !== undefined;
    members.add(`${name.getText(name.getSourceFile())}${optional ? "?" : ""}`);
  }
  return { kind: "members", members };
}

/** A single union arm reduced to a token, or `null` when unreadable. */
function armToken(node: ts.TypeNode): string | null {
  // `"incremental"` — a bare string-literal arm.
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) {
    return JSON.stringify(node.literal.text);
  }
  // `{ readonly kind: "reverified"; … }` — a discriminated object arm. Only the
  // discriminant is compared: the arms' own payload members are the types this
  // gate deliberately does not police (see the header), while the SET of arms is
  // the thing a snippet can silently omit.
  if (ts.isTypeLiteralNode(node)) {
    for (const member of node.members) {
      if (!ts.isPropertySignature(member) || member.name === undefined) continue;
      if (member.name.getText(member.name.getSourceFile()) !== "kind") continue;
      const type = member.type;
      if (type !== undefined && ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal)) {
        return `kind:${JSON.stringify(type.literal.text)}`;
      }
    }
  }
  return null;
}

/**
 * A type alias's arms, or `null` when the alias is not one of the two shapes
 * this gate can read. `null` is a LOUD refusal at the call sites, never a skip.
 */
function aliasShape(node: ts.TypeAliasDeclaration): Shape | null {
  const type = node.type;
  if (!ts.isUnionTypeNode(type)) return null;
  const arms = new Set<string>();
  for (const arm of type.types) {
    const token = armToken(arm);
    if (token === null) return null;
    arms.add(token);
  }
  return arms.size > 0 ? { kind: "union", arms } : null;
}

/**
 * Every `Brain*` interface / type alias declared in one parsed file.
 *
 * `exportedOnly` splits the two sides: a source declaration is a published
 * contract only when it is exported, while a doc fence is illustrative prose and
 * never carries `export`.
 */
function collect(
  sourceFile: ts.SourceFile,
  where: string,
  exportedOnly: boolean,
): Map<string, Declared | null> {
  const found = new Map<string, Declared | null>();
  const isExported = (node: ts.InterfaceDeclaration | ts.TypeAliasDeclaration): boolean =>
    node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true;

  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
      const name = node.name.text;
      if (CONTRACT_NAME.test(name) && (!exportedOnly || isExported(node))) {
        found.set(
          name,
          ts.isInterfaceDeclaration(node)
            ? { shape: interfaceShape(node), where }
            : // `null` records "declared, but in a union shape this gate cannot
              // read" — distinct from absent, and reported as a failure rather
              // than compared as an empty set.
              (() => {
                const shape = aliasShape(node);
                return shape === null ? null : { shape, where };
              })(),
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** Every ```ts / ```typescript fence body in an MDX file. */
function tsFences(mdx: string): readonly string[] {
  const fences: string[] = [];
  // Opening fence: three-or-more backticks, then a `ts`/`tsx`/`typescript`
  // language tag (optionally followed by fumadocs meta like `title="…"`).
  // Closed by a run of at least as many backticks at line start.
  const open = /^(`{3,})(ts|tsx|typescript)\b[^\n]*\n/gm;
  for (let match = open.exec(mdx); match !== null; match = open.exec(mdx)) {
    const ticks = match[1] ?? "```";
    const bodyStart = match.index + match[0].length;
    const close = new RegExp(`^\`{${ticks.length},}\\s*$`, "m");
    const rest = mdx.slice(bodyStart);
    const end = close.exec(rest);
    fences.push(end === null ? rest : rest.slice(0, end.index));
    // Resume scanning after this fence so a fence BODY can never be read as an
    // opening fence of its own.
    open.lastIndex = end === null ? mdx.length : bodyStart + end.index;
  }
  return fences;
}

function describe(shape: Shape): string {
  const values = shape.kind === "members" ? shape.members : shape.arms;
  return [...values].sort().join(", ");
}

function difference(a: ReadonlySet<string>, b: ReadonlySet<string>): readonly string[] {
  return [...a].filter((value) => !b.has(value)).sort();
}

// ── Source side ─────────────────────────────────────────────────────────────
const source = new Map<string, Declared | null>();
for (const file of new Glob(SOURCE_GLOB).scanSync({ cwd: REPO_ROOT })) {
  // Tests declare `Brain*` fixtures that are not the published contract.
  if (file.includes("__tests__") || file.includes("__mocks__")) continue;
  const abs = resolve(REPO_ROOT, file);
  for (const [name, declared] of collect(
    parse(readFileSync(abs, "utf8"), abs),
    relative(REPO_ROOT, abs),
    /* exportedOnly */ true,
  )) {
    source.set(name, declared);
  }
}

if (source.size === 0) {
  console.error(
    `[docs-brain-snippets] FAIL: no exported Brain* declarations found under ${SOURCE_GLOB}.`,
  );
  console.error(
    "[docs-brain-snippets] The source side of this gate read nothing, so it can prove nothing — has lib/brain moved?",
  );
  process.exit(1);
}

// ── Doc side ────────────────────────────────────────────────────────────────
const problems: string[] = [];
const compared = new Set<string>();

for (const file of new Glob(DOCS_GLOB).scanSync({ cwd: REPO_ROOT })) {
  const abs = resolve(REPO_ROOT, file);
  const rel = relative(REPO_ROOT, abs);
  const mdx = readFileSync(abs, "utf8");
  for (const fence of tsFences(mdx)) {
    // A fence is illustrative TS, not a module — parse it standalone. Syntax
    // errors are not this gate's business; an unparseable fence simply declares
    // nothing and is reported by the vacuity floor if it was the required one.
    for (const [name, declared] of collect(
      parse(fence, `${abs}.fence.ts`),
      rel,
      /* exportedOnly */ false,
    )) {
      if (!source.has(name)) {
        problems.push(
          `${rel}: publishes a snippet for \`${name}\`, which is no longer an exported Brain* declaration under ${SOURCE_GLOB}.\n` +
            `  A snippet for a renamed or deleted declaration misleads exactly as much as one missing a member. Update or remove the snippet.`,
        );
        continue;
      }
      const real = source.get(name);
      if (real === null) {
        problems.push(
          `${rel}: publishes a snippet for \`${name}\`, whose real declaration is a union shape this gate cannot read.\n` +
            `  Extend armToken() in scripts/check-docs-brain-snippets.ts so the arms are comparable — a union it cannot read is where an omitted arm hides.`,
        );
        continue;
      }
      if (declared === null) {
        problems.push(
          `${rel}: the \`${name}\` snippet is a union shape this gate cannot read, while its real declaration is comparable (${describe(real.shape)}).\n` +
            `  Write the snippet's arms as string literals or as \`{ kind: "…" }\` objects so the published arms are checkable.`,
        );
        continue;
      }
      if (declared.shape.kind !== real.shape.kind) {
        problems.push(
          `${rel}: the \`${name}\` snippet is declared as a ${declared.shape.kind === "members" ? "interface" : "union"}, but ${real.where} declares it as a ${real.shape.kind === "members" ? "interface" : "union"}.`,
        );
        continue;
      }
      compared.add(name);
      const docValues =
        declared.shape.kind === "members" ? declared.shape.members : declared.shape.arms;
      const realValues = real.shape.kind === "members" ? real.shape.members : real.shape.arms;
      const missing = difference(realValues, docValues);
      const extra = difference(docValues, realValues);
      if (missing.length === 0 && extra.length === 0) continue;
      const noun = declared.shape.kind === "members" ? "member" : "arm";
      const lines = [
        `${rel}: the published \`${name}\` snippet has drifted from ${real.where}.`,
      ];
      if (missing.length > 0) {
        lines.push(
          `  MISSING from the snippet (${noun}${missing.length === 1 ? "" : "s"} the real declaration has): ${missing.join(", ")}`,
        );
      }
      if (extra.length > 0) {
        lines.push(
          `  NOT IN the real declaration (${noun}${extra.length === 1 ? "" : "s"} the snippet invents): ${extra.join(", ")}`,
        );
      }
      lines.push(`  real: ${describe(real.shape)}`);
      lines.push(`  page: ${describe(declared.shape)}`);
      lines.push(
        `  A trailing \`?\` is part of the comparison: showing a required member as optional is the same lie as omitting it.`,
      );
      problems.push(lines.join("\n"));
    }
  }
}

// ── Vacuity floor ───────────────────────────────────────────────────────────
if (!compared.has(REQUIRED_DECLARATION)) {
  console.error(
    `[docs-brain-snippets] FAIL: no published snippet for \`${REQUIRED_DECLARATION}\` was compared.`,
  );
  console.error(
    `[docs-brain-snippets] That snippet is the connector-authoring guide's stated contract, and every other check here is DISCOVERED — so a page rename, a fence relabelled away from \`\`\`ts, or a regex that stopped matching would leave this gate green while comparing nothing.`,
  );
  console.error(
    `[docs-brain-snippets] Restore the snippet, or move the floor in scripts/check-docs-brain-snippets.ts if the contract genuinely moved.`,
  );
  process.exit(1);
}

if (problems.length > 0) {
  console.error(
    `[docs-brain-snippets] FAIL: ${problems.length} published Brain* snippet ${problems.length === 1 ? "problem" : "problems"}:\n`,
  );
  for (const problem of problems) console.error(`${problem}\n`);
  process.exit(1);
}

console.log(
  `[docs-brain-snippets] PASS: ${compared.size} published Brain* snippet${compared.size === 1 ? "" : "s"} match their declarations (${[...compared].sort().join(", ")}).`,
);
