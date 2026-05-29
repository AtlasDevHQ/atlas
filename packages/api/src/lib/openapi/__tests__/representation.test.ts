import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";

import { buildOperationGraph } from "../spec";
import {
  buildAgentRepresentation,
  RepresentationNotImplementedError,
  REPRESENTATION_MODES,
} from "../representation";

const SPEC = JSON.parse(
  fs.readFileSync(path.join(import.meta.dir, "twenty-acceptance", "spec.json"), "utf8"),
);

const graph = buildOperationGraph(SPEC);

describe("buildAgentRepresentation — Path A (operation-graph)", () => {
  const rep = buildAgentRepresentation(graph, "operation-graph", { displayName: "Twenty" });

  it("returns the bake-off metrics with the mode it ran", () => {
    expect(rep.mode).toBe("operation-graph");
    expect(rep.operationCount).toBe(graph.operations.size);
    expect(rep.operationCount).toBeGreaterThanOrEqual(11);
    // Token estimate is a positive, bounded heuristic (chars/4), never the raw
    // 250KB spec dumped verbatim.
    expect(rep.approxTokens).toBe(Math.ceil(rep.promptContext.length / 4));
    expect(rep.approxTokens).toBeLessThan(4000);
  });

  it("lists every operation backing a scripts/twenty-mcp.ts action", () => {
    // The MCP actions map onto these generic operationIds. The representation
    // must name each so the agent can address it with no per-operation code.
    for (const opId of [
      "findManyPeople", // listPeople / searchPeople
      "findOnePerson", // getPerson
      "createOnePerson", // upsertPerson (create branch)
      "updateOnePerson", // upsertPerson (update branch)
      "deleteOnePerson", // deletePerson
      "findManyCompanies", // listCompanies / searchCompanies
      "deleteOneCompany", // deleteCompany
      "findManyNotes", // listNotes
      "findOneNote", // note fetch in the $ref chain
      "createOneNote", // createNote
      "deleteOneNote", // deleteNote
      "findManyNoteTargets", // Person -> Note join traversal
      "createOneNoteTarget", // createNote link step
    ]) {
      expect(rep.promptContext, `representation should mention ${opId}`).toContain(opId);
    }
  });

  it("tells the agent to use executeRestOperation, not executeSQL", () => {
    expect(rep.promptContext).toContain("executeRestOperation");
    expect(rep.promptContext).toContain("NOT a SQL database");
  });

  it("marks the surface read-only until the write-allowlist ships (slice 5 boundary)", () => {
    expect(rep.promptContext.toLowerCase()).toContain("read-only");
  });

  it("does NOT advertise the Python composition path by default (gated to slice 3 networkPolicy)", () => {
    expect(rep.promptContext).not.toContain("executePython");
    const withPython = buildAgentRepresentation(graph, "operation-graph", {
      displayName: "Twenty",
      pythonCompositionEnabled: true,
    });
    expect(withPython.promptContext).toContain("executePython");
  });

  // ── The four Twenty traps the suite exists to lock in ────────────────

  it("TRAP 1 — surfaces the field[op]:value filter syntax (NOT bracket-nested)", () => {
    expect(rep.promptContext).toContain("emails.primaryEmail[eq]:foo@example.com");
    expect(rep.promptContext).toContain("field[COMPARATOR]:value");
  });

  it("TRAP 2 — surfaces the Person<->NoteTarget join column targetPersonId (NOT personId)", () => {
    expect(rep.promptContext).toContain("targetPersonId");
    // The NoteTarget shape must show targetPersonId; it must never invent a
    // bare personId join column (the jezweb trap).
    const noteTargetBlock = sliceSchemaBlock(rep.promptContext, "NoteTarget");
    expect(noteTargetBlock).toContain("targetPersonId");
    expect(noteTargetBlock).not.toMatch(/(?<![a-zA-Z])personId(?![a-zA-Z])/);
  });

  it("TRAP 3 — surfaces Atlas custom fields inline on Person (NOT under a customFields wrapper)", () => {
    const personBlock = sliceSchemaBlock(rep.promptContext, "Person");
    expect(personBlock).toContain("atlasFirstSource");
    expect(personBlock).toContain("atlasLastSource");
    expect(rep.promptContext).not.toContain("customFields");
  });

  it("TRAP 4 — surfaces note bodies under bodyV2.markdown (NOT a top-level body)", () => {
    const noteBlock = sliceSchemaBlock(rep.promptContext, "Note");
    expect(noteBlock).toContain("bodyV2");
    expect(noteBlock).toContain("markdown");
  });

  it("exposes nested record shapes one level deep (emails.primaryEmail)", () => {
    const personBlock = sliceSchemaBlock(rep.promptContext, "Person");
    expect(personBlock).toContain("primaryEmail");
  });

  it("renders $ref joins as pointers the agent can follow", () => {
    // Person.noteTargets -> NoteTarget[]; NoteTarget.note -> Note.
    expect(rep.promptContext).toContain("-> NoteTarget");
    expect(rep.promptContext).toContain("-> Note");
  });
});

describe("buildAgentRepresentation — composed schemas (allOf/oneOf/anyOf)", () => {
  // Generated specs (Stripe etc.) define schemas purely via composition with no
  // direct properties; spec.ts preserves the branches and the representation
  // must surface them rather than omitting the schema from the prompt.
  const composedGraph = buildOperationGraph({
    openapi: "3.0.3",
    info: { title: "Composed", version: "1" },
    paths: { "/x": { get: { operationId: "x", responses: {} } } },
    components: {
      schemas: {
        Base: { type: "object", properties: { id: { type: "string" } } },
        Extended: {
          allOf: [
            { $ref: "#/components/schemas/Base" },
            { type: "object", properties: { extra: { type: "string" } } },
          ],
        },
        Choice: { oneOf: [{ $ref: "#/components/schemas/Base" }, { type: "string" }] },
        Holder: {
          type: "object",
          properties: { addr: { anyOf: [{ $ref: "#/components/schemas/Base" }], nullable: true } },
        },
      },
    },
  });
  const rep = buildAgentRepresentation(composedGraph, "operation-graph");

  it("renders a composition-only schema instead of omitting it", () => {
    expect(rep.promptContext).toContain("**Extended**");
    expect(rep.promptContext).toContain("allOf");
    expect(rep.promptContext).toContain("**Choice**");
    expect(rep.promptContext).toContain("oneOf");
  });

  it("renders property-level composition (a nullable anyOf $ref)", () => {
    expect(rep.promptContext).toContain("addr");
    expect(rep.promptContext).toContain("-> Base");
  });
});

describe("buildAgentRepresentation — mode knob (bake-off parameterization)", () => {
  it("declares both bake-off modes, Path A first", () => {
    expect(REPRESENTATION_MODES[0]).toBe("operation-graph");
    expect(REPRESENTATION_MODES).toContain("semantic-yaml");
  });

  it("fails loud on the not-yet-implemented semantic-yaml mode (Path B / #2931)", () => {
    expect(() => buildAgentRepresentation(graph, "semantic-yaml")).toThrow(
      RepresentationNotImplementedError,
    );
  });
});

/**
 * Extract the rendered block for a named schema (from `- **Name**` up to the
 * next top-level `- **` bullet) so trap assertions don't accidentally match a
 * sibling schema's text.
 */
function sliceSchemaBlock(prompt: string, schemaName: string): string {
  const start = prompt.indexOf(`- **${schemaName}**`);
  if (start === -1) throw new Error(`schema block for ${schemaName} not found in representation`);
  const rest = prompt.slice(start + 1);
  const nextIdx = rest.indexOf("\n- **");
  return nextIdx === -1 ? prompt.slice(start) : prompt.slice(start, start + 1 + nextIdx);
}
