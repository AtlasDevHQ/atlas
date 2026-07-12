import { describe, expect, test } from "bun:test";
import { KnowledgeCollectionSchema } from "@/ui/lib/admin-schemas";
import {
  groupForKnowledgeSlug,
  iconForKnowledgeSlug,
  KNOWLEDGE_DISPLAY_ORDER,
  KNOWLEDGE_SOURCE_SLUGS,
  knowledgeSourceForSlug,
  OKF_UPLOAD_SLUG,
  shortConnectorLabel,
} from "../knowledge-connectors";

/**
 * Guards the picker's non-data-driven seam (#4619): the slug → wire `source`
 * map. Rendering is data-driven off the catalog, but the post-install action
 * (kick a sync vs open the upload dialog) reads this map, so it must cover
 * every knowledge source and default a future connector to "synced".
 */

describe("knowledgeSourceForSlug", () => {
  test("maps every seeded connector slug to its wire source", () => {
    expect(knowledgeSourceForSlug("okf-upload")).toBe("upload");
    expect(knowledgeSourceForSlug("bundle-sync")).toBe("bundle-sync");
    expect(knowledgeSourceForSlug("notion-knowledge")).toBe("notion");
    expect(knowledgeSourceForSlug("confluence")).toBe("confluence");
    expect(knowledgeSourceForSlug("confluence-datacenter")).toBe("confluence-datacenter");
    expect(knowledgeSourceForSlug("gitbook")).toBe("gitbook");
    expect(knowledgeSourceForSlug("zendesk")).toBe("zendesk");
    expect(knowledgeSourceForSlug("salesforce-knowledge")).toBe("salesforce-knowledge");
    expect(knowledgeSourceForSlug("intercom")).toBe("intercom");
    expect(knowledgeSourceForSlug("front")).toBe("front");
    expect(knowledgeSourceForSlug("helpscout")).toBe("helpscout");
    expect(knowledgeSourceForSlug("freshdesk")).toBe("freshdesk");
  });

  test("the slug→source map is surjective onto every wire KnowledgeCollectionSource", () => {
    // Guards against "add a source to the union but forget the picker map":
    // every source the wire contract knows must be reachable from some slug.
    const mappedSources = new Set(KNOWLEDGE_SOURCE_SLUGS.map(knowledgeSourceForSlug));
    const wireSources = KnowledgeCollectionSchema.shape.source.options;
    for (const source of wireSources) {
      expect(mappedSources.has(source), `no slug maps to source=${source}`).toBe(true);
    }
  });

  test("`upload` is the only non-synced source; a future connector defaults to synced", () => {
    // Every mapped slug except the upload arm is a synced source.
    for (const slug of KNOWLEDGE_SOURCE_SLUGS) {
      const source = knowledgeSourceForSlug(slug);
      if (slug === OKF_UPLOAD_SLUG) expect(source).toBe("upload");
      else expect(source).not.toBe("upload");
    }
    // Unmapped (future) connector → a synced source, never `upload` (which
    // would wrongly route it to the upload-&-publish follow-up).
    expect(knowledgeSourceForSlug("some-future-connector")).not.toBe("upload");
  });
});

describe("presentation helpers", () => {
  test("the source map and the display order cover the same slugs", () => {
    expect([...KNOWLEDGE_SOURCE_SLUGS].sort()).toEqual([...KNOWLEDGE_DISPLAY_ORDER].sort());
  });

  test("shortConnectorLabel strips the verbose 'Knowledge Base (…)' wrapper", () => {
    expect(shortConnectorLabel("Knowledge Base (Confluence Cloud)")).toBe("Confluence Cloud");
    expect(shortConnectorLabel("Knowledge Base (Upload)")).toBe("Upload");
    // A row that doesn't follow the convention falls back to the full name.
    expect(shortConnectorLabel("Some Other Source")).toBe("Some Other Source");
  });

  test("only the upload/endpoint arms are in the 'manual' group", () => {
    expect(groupForKnowledgeSlug("okf-upload")).toBe("manual");
    expect(groupForKnowledgeSlug("bundle-sync")).toBe("manual");
    expect(groupForKnowledgeSlug("notion-knowledge")).toBe("connector");
    expect(groupForKnowledgeSlug("zendesk")).toBe("connector");
    // A future connector defaults into the connectors group.
    expect(groupForKnowledgeSlug("some-future-connector")).toBe("connector");
  });

  test("every slug (including an unknown one) resolves to an icon", () => {
    for (const slug of KNOWLEDGE_DISPLAY_ORDER) {
      expect(iconForKnowledgeSlug(slug)).toBeTruthy();
    }
    expect(iconForKnowledgeSlug("some-future-connector")).toBeTruthy();
  });
});
