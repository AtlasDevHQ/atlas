#!/usr/bin/env bun
// check-docs-brain-snippets.ts — published `Brain*` contract snippets in
// apps/docs must name the same members as the real declarations (#5165).
//
// ## Why this exists
//
// `guides/brain-connector-authoring.mdx` opens with the sentence "This page is
// the contract" and then hand-copies `BrainSourceConnector` into a fenced block.
// It drifted: the real interface gained a non-optional third member —
// `readonly audience: BrainSourceAudienceFor<S>` (#4985), taking it to four —
// and the page never did. An author following the page writes a connector that
// fails registration, or, on a chat-class source where neither the conditional
// type nor the registration check constrains the arm, one that mints `audience:`
// grants nothing refreshes: the 168h-then-invisible failure that seam exists to
// prevent. A hand-copied interface on a page that calls itself the contract will
// drift again, so the copy is checked rather than trusted.
//
// ## What it compares, and what it deliberately does NOT
//
// MEMBER NAMES, plus `readonly` and `?`. Not types.
//
// That boundary is the whole reason this gate can exist without being exempted
// later. A doc snippet legitimately simplifies types — the real
// `BrainSourceConnector` is generic in `S` and its `source` is `S`, where a
// reader is better served by seeing what `S` ranges over — so byte-comparing
// type text would fail on correct prose, and a gate that fails on correct prose
// gets an exemption comment instead of a fix. Names and modifiers are the axis
// the #5165 drift lived on: a member that is absent, renamed, shown as `?` when
// the real one is required, or shown mutable when the real one is `readonly` is
// a page telling an author something false about what they must write. A type
// that has been simplified for exposition is not.
//
// Type PARAMETERS are also not compared, for the same reason — the page publishes
// `<S extends EpisodeSource = EpisodeSource>` and is free to drop it.
//
// ## Both sides are DISCOVERED, never enumerated
//
// Source side: every exported interface and type alias named `Brain*` under
// `packages/*/src/**` and `ee/src/**`. Doc side: every fenced TypeScript block in
// `apps/docs/content/**/*.mdx` that declares a `Brain*` interface or type alias.
// So a new brain guide, or an additional snippet on an existing one, enrols
// itself.
//
// The source glob is deliberately wider than `lib/brain/**`: `BrainFactSegment`
// (`api/routes/admin-publish-preview.ts`) and `BrainToolReason`
// (`lib/tools/search-brain.ts`) are exported `Brain*` contracts outside it, and a
// narrow glob would tell a page publishing either that its snippet names a
// declaration that "no longer exists" — a false diagnosis with a destructive
// remedy attached.
//
// A doc snippet naming a `Brain*` declaration that is not exported anywhere in
// scope is a FAILURE, not a skip — a snippet for a renamed or deleted interface
// is the same lie as one missing a member.
//
// ## Type aliases: two readable shapes, and an OPAQUE record outside them
//
// `BrainSourceAudience` is the second half of the #5165 drift — its two arms
// (`reverified` / `externally-synced`) were never shown at all — so a union has
// to be comparable or that half stays uncheckable. Two shapes are readable: a
// union of string literals, and a union of object literals sharing one
// string-literal discriminant property.
//
// Anything else is recorded as the `opaque` variant of {@link Shape} rather than
// compared, and a doc snippet for an opaque declaration FAILS with the reason.
// Be precise about the scope of that: opaque is loud only where a page actually
// publishes one. Most exported `Brain*` aliases are opaque today (`BrainGrant` is
// `readonly string[]`, `BrainAsOfInstant` is a branded intersection,
// `BrainSourceAudienceFor` is conditional) and none of them is published, so
// nothing fails — this is not a claim that every alias in the tree is comparable,
// and for an unpublished one it is precisely a skip.
//
// ## Fenced blocks are parsed line-wise
//
// The first cut used a single multiline regex anchored at column 0. Three
// silent-skip holes, all measured: a fence indented for a numbered step or a JSX
// child never matched (and this tree already has indented `ts` fences); a missing
// closing fence swallowed the rest of the file, so every later snippet went
// unchecked; and a `ts` fence nested inside a 4-backtick `md` block was compared
// as though it were published contract, which is a false failure on correct prose.
//
// {@link FENCE_OPEN} / {@link closesFence} are the CommonMark rules, ported from
// the sibling guard `scripts/check-docs-links.ts` so the two agree about what a
// fence is. An unterminated fence is a malformed page, reported rather than
// skipped — the same reflex this repo applies to an unparseable SQL query.
//
// ## Three ways this gate refuses to be vacuous, because everything else is
// ## discovered
//
// 1. {@link REQUIRED_DECLARATIONS} must all be compared. A fence relabelled away
//    from `ts`, an indent that stops matching, or a snippet renamed out of the
//    `Brain*` namespace then becomes loud instead of leaving the gate green having
//    compared everything EXCEPT the snippets that matter. (A page *rename* is not
//    on that list and never was: `DOCS_GLOB` keys on the extension, so renaming a
//    file changes nothing.)
// 2. The per-file count of opening TypeScript fences must equal the number
//    extracted, so a scanner that starts skipping is caught arithmetically rather
//    than by someone noticing a name is gone.
// 3. {@link textualBrainNames} reconciles the parser's output against the body
//    text, because (2) is not sufficient: a MERGED fenced block keeps the count
//    correct while TypeScript error-recovers past the prose and drops a whole
//    declaration. Measured — `BrainSourceVendorClient` left the compared set with
//    the gate printing PASS.
//
// `scripts/__tests__/check-docs-brain-snippets.test.sh` probes all three, and
// every arm below: 21 fixtures, and each one names a marker so a crash or a
// different arm firing cannot satisfy it.
//
// Run locally: bun scripts/check-docs-brain-snippets.ts

import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Glob } from "bun";
import ts from "typescript";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

// Where published `Brain*` contracts may be declared. Scoped to each package's
// `src` rather than the whole package, so a build output
// (`packages/types/dist/brain.d.ts`) cannot be read as a second declaration of a
// name its own source already exports.
const SOURCE_GLOBS = ["packages/*/src/**/*.ts", "ee/src/**/*.ts"] as const;
const DOCS_GLOB = "apps/docs/content/**/*.mdx";

/** Only declarations in the product's own `Brain*` namespace are contracts. */
const CONTRACT_NAME = /^Brain[A-Z]/;

/**
 * Declarations whose absence from the compared set means a contract page stopped
 * publishing its contract — the name-level vacuity floor.
 *
 * Both are #5165's own subject: the interface whose member was missing, and the
 * union whose arms were never shown. The second is here because the arm
 * comparison guards drift WITHIN a published union and cannot guard the union
 * going unpublished — measured, by deleting the fence and watching the gate stay
 * green with only `BrainSourceConnector` floored.
 */
const REQUIRED_DECLARATIONS = ["BrainSourceConnector", "BrainSourceAudience"] as const;

/** Fenced-block languages whose body is parsed as TypeScript. */
const TS_FENCE_TAG = /^(ts|tsx|typescript)\b/i;

/** A declaration reduced to the axis this gate compares. */
type Shape =
  /** An interface: member names, each with its modifiers. */
  | { readonly kind: "members"; readonly members: ReadonlySet<string> }
  /** A union this gate can read: the set of arms, each as a printable token. */
  | { readonly kind: "union"; readonly arms: ReadonlySet<string> }
  /**
   * Declared, but in a shape this gate cannot compare. Carried as a variant
   * rather than as `Declared | null` so that ABSENT is expressible only as a
   * missing map key — the three-way absent/null/present read was a real
   * type hole (`Map.has()` does not narrow `Map.get()`).
   */
  | { readonly kind: "opaque"; readonly reason: string };

interface Declared {
  readonly shape: Shape;
  /** Repo-relative path the declaration was read from, for error messages. */
  readonly where: string;
}

function parse(text: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, /* setParentNodes */ true);
}

/**
 * `Brain*` declaration names a fence body mentions TEXTUALLY.
 *
 * The reconciliation partner of {@link collect}, and the reason it exists is a
 * measured hole rather than a hypothetical. `ts.createSourceFile` does NOT throw
 * on a syntax error — it error-recovers and returns a PARTIAL tree. Blanking one
 * closing fence MERGES two fenced blocks, so the prose between them lands inside
 * the body; TypeScript then recovers past the wreckage and
 * `BrainSourceVendorClient` silently left the compared set while the gate printed
 * PASS. The per-file fence COUNT still agreed, so the arithmetic floor could not
 * see it either.
 *
 * Comparing this against what the AST yielded turns parse-recovery loss into a
 * failure, WITHOUT the gate having to reject every unparseable fence in the docs
 * tree — which is not an option: 75 `ts`-tagged fences site-wide are legitimately
 * elided (`…`, JSX in a `ts` fence, a bare expression), and a gate that fails on
 * correct prose earns an exemption comment instead of a fix. A fence that
 * declares no `Brain*` name is not this gate's business at all.
 */
const TEXTUAL_DECLARATION = /^[ \t]*(?:export[ \t]+)?(?:interface|type)[ \t]+(Brain[A-Z]\w*)/gm;

function textualBrainNames(body: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const match of body.matchAll(TEXTUAL_DECLARATION)) {
    const name = match[1];
    if (name !== undefined) names.add(name);
  }
  return names;
}

/**
 * A property name as written, with quotes normalized away.
 *
 * `.text` rather than `getText()`: an identifier and a legally-quoted
 * `readonly "catalogId": string` must produce the SAME token, or a quoting style
 * reads as drift. It also drops the dependency on live parent pointers that
 * `getText()` carries.
 */
function propertyName(name: ts.PropertyName): string {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)
    ? name.text
    : name.getText(name.getSourceFile());
}

/**
 * An interface's members as `readonly name?` tokens.
 *
 * Index, call and construct signatures carry no name to compare, so they are
 * represented by their kind — two declarations that differ only by gaining one
 * still differ in this set.
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
      // Defensive: any other unnamed member shape. Recorded rather than dropped
      // so it cannot be the difference this gate is blind to.
      members.add(`[unnamed:${ts.SyntaxKind[member.kind]}]`);
      continue;
    }
    const isProperty = ts.isPropertySignature(member);
    const optional =
      (isProperty || ts.isMethodSignature(member)) && member.questionToken !== undefined;
    // `readonly` is a member-level modifier, not a type simplification, so it is
    // inside this gate's boundary: a snippet dropping it tells an author the
    // field is mutable, which is the same class of lie as dropping the `?`.
    const readonlyModifier =
      isProperty &&
      member.modifiers?.some((m) => m.kind === ts.SyntaxKind.ReadonlyKeyword) === true;
    members.add(`${readonlyModifier ? "readonly " : ""}${propertyName(name)}${optional ? "?" : ""}`);
  }
  return { kind: "members", members };
}

/** A single union arm reduced to a token, or `null` when unreadable. */
function armToken(node: ts.TypeNode, discriminant: string): string | null {
  // `"incremental"` — a bare string-literal arm.
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) {
    return JSON.stringify(node.literal.text);
  }
  // `{ readonly kind: "reverified"; … }` — a discriminated object arm. Only the
  // discriminant is compared: the arms' own payload members are the types this
  // gate deliberately does not police, while the set of arms is what a snippet
  // can silently omit.
  if (ts.isTypeLiteralNode(node)) {
    for (const member of node.members) {
      if (!ts.isPropertySignature(member) || member.name === undefined) continue;
      if (propertyName(member.name) !== discriminant) continue;
      const type = member.type;
      if (type !== undefined && ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal)) {
        return `${discriminant}:${JSON.stringify(type.literal.text)}`;
      }
    }
  }
  return null;
}

/**
 * The property every object arm uses as its discriminant, or `null`.
 *
 * NOT hard-coded to `kind`: `BrainPrincipalContext` discriminates on `origin`,
 * and a gate that only knew `kind` would call it unreadable and tell an author to
 * extend `armToken` when nothing was wrong with their snippet.
 */
function discriminantOf(arms: readonly ts.TypeNode[]): string | null {
  const literals = arms.filter(ts.isTypeLiteralNode);
  if (literals.length === 0) return null;
  const candidates = new Set<string>();
  const first = literals[0];
  if (first === undefined) return null;
  for (const member of first.members) {
    if (!ts.isPropertySignature(member) || member.name === undefined) continue;
    const type = member.type;
    if (type !== undefined && ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal)) {
      candidates.add(propertyName(member.name));
    }
  }
  for (const name of candidates) {
    if (literals.every((arm) => armToken(arm, name) !== null)) return name;
  }
  return null;
}

/** A type alias's arms, or an opaque record naming why it could not be read. */
function aliasShape(node: ts.TypeAliasDeclaration): Shape {
  const type = node.type;
  if (!ts.isUnionTypeNode(type)) {
    return {
      kind: "opaque",
      reason: `its declaration is not a union (it is a ${ts.SyntaxKind[type.kind]})`,
    };
  }
  const stringLiteralsOnly = type.types.every(
    (arm) => ts.isLiteralTypeNode(arm) && ts.isStringLiteral(arm.literal),
  );
  const discriminant = stringLiteralsOnly ? null : discriminantOf(type.types);
  if (!stringLiteralsOnly && discriminant === null) {
    return {
      kind: "opaque",
      reason:
        "its arms are neither all string literals nor all object literals sharing one string-literal discriminant property",
    };
  }
  const arms = new Set<string>();
  for (const arm of type.types) {
    const token = armToken(arm, discriminant ?? "kind");
    if (token === null) {
      return { kind: "opaque", reason: "one of its arms could not be reduced to a token" };
    }
    if (arms.has(token)) {
      // Two arms sharing a discriminant value would collapse to one token, and a
      // snippet omitting one of them would then compare equal. Refuse to compare
      // rather than compare wrongly.
      return {
        kind: "opaque",
        reason: `two arms share the discriminant value ${token}, so the arm set cannot be compared by discriminant alone`,
      };
    }
    arms.add(token);
  }
  return { kind: "union", arms };
}

/**
 * Every `Brain*` interface / type alias declared in one parsed file.
 *
 * `scope` splits the two sides: a source declaration is a published contract only
 * when it is exported, while a doc fence is illustrative prose and never carries
 * `export`. A string union rather than a boolean because passing a boolean
 * backwards silently WIDENS the source side (unexported names start counting),
 * which weakens the deleted-declaration check with no signal.
 */
function collect(
  sourceFile: ts.SourceFile,
  where: string,
  scope: "exported-only" | "all",
): readonly (readonly [string, Declared])[] {
  const found: (readonly [string, Declared])[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
      const name = node.name.text;
      const exported =
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true;
      if (CONTRACT_NAME.test(name) && (scope === "all" || exported)) {
        found.push([
          name,
          { shape: ts.isInterfaceDeclaration(node) ? interfaceShape(node) : aliasShape(node), where },
        ]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

// ── Fenced-block scanning (CommonMark, ported from check-docs-links.ts) ──────

const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})/;

/**
 * Does this line close the given open fence? CommonMark: same character, at
 * least as long as the opener, nothing but whitespace after (info strings are
 * only legal on the OPENING fence) — so a ``` line inside a ```` block stays
 * inside.
 */
function closesFence(line: string, fence: string): boolean {
  const m = FENCE_OPEN.exec(line);
  const ticks = m?.[1];
  return (
    m !== null &&
    ticks !== undefined &&
    ticks[0] === fence[0] &&
    ticks.length >= fence.length &&
    line.slice(m.index + m[0].length).trim() === ""
  );
}

interface Fence {
  readonly body: string;
  /** 1-based line of the opening fence, for error messages. */
  readonly line: number;
}

interface FenceScan {
  readonly fences: readonly Fence[];
  /**
   * Opening TypeScript fences counted independently of extraction — the
   * arithmetic half of the vacuity floor. A skip or a mis-slice shows up as a
   * disagreement with `fences.length`.
   */
  readonly openedTsFences: number;
  /** 1-based line of an unterminated fence, when the file has one. */
  readonly unterminatedAt: number | null;
}

/**
 * Every fenced TypeScript block in an MDX file, scanned line-wise.
 *
 * Walks EVERY fence, not only TypeScript ones, so a `ts` block nested inside a
 * 4-backtick `md` block is correctly treated as that block's content rather than
 * as published contract.
 */
function scanTsFences(mdx: string): FenceScan {
  const lines = mdx.split("\n");
  const fences: Fence[] = [];
  let openedTsFences = 0;
  let fence: string | null = null;
  let isTs = false;
  let bodyStart = 0;
  let openedAt = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (fence !== null) {
      if (!closesFence(line, fence)) continue;
      if (isTs) fences.push({ body: lines.slice(bodyStart, i).join("\n"), line: openedAt });
      fence = null;
      isTs = false;
      continue;
    }
    const m = FENCE_OPEN.exec(line);
    const ticks = m?.[1];
    if (m === null || ticks === undefined) continue;
    fence = ticks;
    isTs = TS_FENCE_TAG.test(line.slice(m.index + m[0].length).trim());
    if (isTs) openedTsFences++;
    bodyStart = i + 1;
    openedAt = i + 1;
  }

  return {
    fences,
    openedTsFences,
    // An unterminated fence means the guard cannot tell where the snippet ends,
    // so it refuses rather than treating the rest of the file as one body — the
    // shape that silently unchecked every later fence.
    unterminatedAt: fence !== null ? openedAt : null,
  };
}

function describe(shape: Shape): string {
  if (shape.kind === "opaque") return `opaque (${shape.reason})`;
  const values = shape.kind === "members" ? shape.members : shape.arms;
  return [...values].sort().join(", ");
}

function difference(a: ReadonlySet<string>, b: ReadonlySet<string>): readonly string[] {
  return [...a].filter((value) => !b.has(value)).sort();
}

const problems: string[] = [];

// ── Source side ─────────────────────────────────────────────────────────────
const source = new Map<string, Declared>();
for (const glob of SOURCE_GLOBS) {
  for (const file of new Glob(glob).scanSync({ cwd: REPO_ROOT })) {
    // Tests and mocks may declare `Brain*` fixtures that are not the published
    // contract. Defensive rather than load-bearing — `exported-only` already
    // excludes most — but a test fixture that happens to be exported would
    // otherwise shadow the real declaration.
    if (file.includes("__tests__") || file.includes("__mocks__")) continue;
    const abs = resolve(REPO_ROOT, file);
    const rel = relative(REPO_ROOT, abs);
    for (const [name, declared] of collect(
      parse(readFileSync(abs, "utf8"), abs),
      rel,
      "exported-only",
    )) {
      const existing = source.get(name);
      if (existing !== undefined) {
        // Last-write-wins would resolve by glob order, so a page would be
        // compared against whichever file the scan happened to reach second.
        problems.push(
          `\`${name}\` is exported from BOTH ${existing.where} and ${rel}.\n` +
            `  This gate compares a published snippet against one declaration per name, so a duplicate makes the comparison depend on scan order. Rename one, or narrow SOURCE_GLOBS in scripts/check-docs-brain-snippets.ts.`,
        );
        continue;
      }
      source.set(name, declared);
    }
  }
}

if (source.size === 0) {
  console.error(
    `[docs-brain-snippets] FAIL: no exported Brain* declarations found under ${SOURCE_GLOBS.join(", ")}.`,
  );
  console.error(
    "[docs-brain-snippets] The source side of this gate read nothing, so it can prove nothing — has lib/brain moved?",
  );
  process.exit(1);
}

// ── Doc side ────────────────────────────────────────────────────────────────
const compared = new Set<string>();

for (const file of new Glob(DOCS_GLOB).scanSync({ cwd: REPO_ROOT })) {
  const abs = resolve(REPO_ROOT, file);
  const rel = relative(REPO_ROOT, abs);
  const scan = scanTsFences(readFileSync(abs, "utf8"));

  if (scan.unterminatedAt !== null) {
    problems.push(
      `${rel}:${scan.unterminatedAt}: a fenced block is opened and never closed.\n` +
        `  The guard cannot tell where that snippet ends, so it refuses to compare this page rather than silently treating the rest of the file as one snippet body. Close the fence.`,
    );
    continue;
  }
  if (scan.fences.length !== scan.openedTsFences) {
    problems.push(
      `${rel}: counted ${scan.openedTsFences} opening TypeScript fence(s) but extracted ${scan.fences.length}.\n` +
        `  The fence scanner and its own count disagree, which means a snippet is being skipped. Fix scanTsFences() in scripts/check-docs-brain-snippets.ts.`,
    );
    continue;
  }

  const seenInFile = new Map<string, number>();
  for (const fence of scan.fences) {
    // A fence is illustrative TypeScript, not a module — parse it standalone.
    const fenceFile = parse(fence.body, `${abs}.fence.ts`);
    const collected = collect(fenceFile, rel, "all");
    // Reconcile the AST against the text. A `Brain*` name the body spells but the
    // parser did not yield is parse-recovery LOSS, not an absent declaration.
    const parsedNames = new Set(collected.map(([name]) => name));
    const lost = [...textualBrainNames(fence.body)].filter((name) => !parsedNames.has(name));
    if (lost.length > 0) {
      problems.push(
        `${rel}:${fence.line}: this fence spells ${lost.map((n) => `\`${n}\``).join(", ")} but the parser did not yield ${lost.length === 1 ? "it" : "them"}.\n` +
          `  TypeScript error-recovers rather than throwing, so a malformed snippet silently drops declarations from the comparison instead of failing. The usual cause is a MERGED fenced block — a missing closing fence earlier on the page, which puts prose inside this body. Check the fences above line ${fence.line}.`,
      );
      continue;
    }
    for (const [name, declared] of collected) {
      const previousLine = seenInFile.get(name);
      if (previousLine !== undefined) {
        // A before/after or "don't do this / do this" pair is a normal docs
        // idiom, and last-write-wins would make the WRONG half invisible.
        problems.push(
          `${rel}:${fence.line}: declares \`${name}\` more than once (also at line ${previousLine}).\n` +
            `  This gate compares one snippet per name, so a second declaration would hide the first. Publish one canonical snippet per declaration.`,
        );
        continue;
      }
      seenInFile.set(name, fence.line);

      const real = source.get(name);
      if (real === undefined) {
        problems.push(
          `${rel}:${fence.line}: publishes a snippet for \`${name}\`, which is not an exported Brain* declaration under ${SOURCE_GLOBS.join(", ")}.\n` +
            `  A snippet for a renamed or deleted declaration misleads exactly as much as one missing a member. Update or remove the snippet.`,
        );
        continue;
      }
      if (real.shape.kind === "opaque") {
        problems.push(
          `${rel}:${fence.line}: publishes a snippet for \`${name}\`, whose real declaration in ${real.where} is a shape this gate cannot compare — ${real.shape.reason}.\n` +
            `  Extend aliasShape()/armToken() in scripts/check-docs-brain-snippets.ts so it is comparable. A published contract this gate cannot read is exactly where an omitted member or arm hides.`,
        );
        continue;
      }
      if (declared.shape.kind === "opaque") {
        problems.push(
          `${rel}:${fence.line}: the \`${name}\` snippet is a shape this gate cannot compare — ${declared.shape.reason} — while its real declaration in ${real.where} is comparable (${describe(real.shape)}).\n` +
            `  Write the snippet's arms as string literals, or as object literals sharing one string-literal discriminant, so the published arms are checkable.`,
        );
        continue;
      }
      if (declared.shape.kind !== real.shape.kind) {
        problems.push(
          `${rel}:${fence.line}: the \`${name}\` snippet is declared as ${declared.shape.kind === "members" ? "an interface" : "a union"}, but ${real.where} declares it as ${real.shape.kind === "members" ? "an interface" : "a union"}.`,
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
        `${rel}:${fence.line}: the published \`${name}\` snippet has drifted from ${real.where}.`,
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
        `  \`readonly\` and a trailing \`?\` are part of the comparison: showing a required member as optional, or an immutable one as mutable, is the same lie as omitting it.`,
      );
      problems.push(lines.join("\n"));
    }
  }
}

// ── Report ──────────────────────────────────────────────────────────────────
// `problems` prints BEFORE the floor is evaluated. The floor's own message is
// generic advice; when a required snippet went missing it is usually a problem
// above that says why, and exiting on the floor first suppressed exactly that
// diagnostic.
if (problems.length > 0) {
  console.error(
    `[docs-brain-snippets] FAIL: ${problems.length} published Brain* snippet ${problems.length === 1 ? "problem" : "problems"}:\n`,
  );
  for (const problem of problems) console.error(`${problem}\n`);
}

const missingFloor = REQUIRED_DECLARATIONS.filter((name) => !compared.has(name));
if (missingFloor.length > 0) {
  console.error(
    `[docs-brain-snippets] FAIL: no published snippet was compared for: ${missingFloor.join(", ")}.`,
  );
  console.error(
    `[docs-brain-snippets] Those are the connector-authoring guide's stated contract, and every other check here is DISCOVERED — so a fence relabelled away from a \`ts\` tag, an indent, or a regex that stopped matching would leave this gate green having compared everything EXCEPT the snippets that matter.`,
  );
  console.error(
    `[docs-brain-snippets] Restore the snippet(s), or move REQUIRED_DECLARATIONS in scripts/check-docs-brain-snippets.ts if the contract genuinely moved.`,
  );
}

if (problems.length > 0 || missingFloor.length > 0) process.exit(1);

console.log(
  `[docs-brain-snippets] PASS: ${compared.size} published Brain* snippet${compared.size === 1 ? "" : "s"} match their declarations (${[...compared].sort().join(", ")}).`,
);
