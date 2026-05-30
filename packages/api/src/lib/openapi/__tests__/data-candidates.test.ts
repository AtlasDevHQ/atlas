/**
 * Tests for the data-candidate registry (v0.0.2 slice 6a, #3028): the registry
 * invariants, the shared config schema, and the "thin wrapper" property — a
 * candidate's pagination config must resolve against the SAME generic paginator
 * registry (no forked strategy file).
 */
import { describe, it, expect } from "bun:test";
import {
  DATA_CANDIDATES,
  DATA_CANDIDATE_CATALOG_IDS,
  DATA_CANDIDATE_CONFIG_SCHEMA,
  STRIPE_DATA_CANDIDATE,
  findDataCandidateByCatalogId,
  findDataCandidateBySlug,
} from "../data-candidates";
import { OPENAPI_SUPPORTED_AUTH_KINDS } from "../catalog";
import { defaultPaginatorRegistry } from "../strategies";

describe("DATA_CANDIDATES registry invariants", () => {
  it("derives every catalogId as catalog:${slug}", () => {
    for (const c of DATA_CANDIDATES) {
      expect(c.catalogId).toBe(`catalog:${c.slug}`);
    }
  });

  it("uses only executable (non-oauth2) auth kinds in slice 6a", () => {
    for (const c of DATA_CANDIDATES) {
      expect(OPENAPI_SUPPORTED_AUTH_KINDS).toContain(c.authKind);
    }
  });

  it("exposes every catalogId in DATA_CANDIDATE_CATALOG_IDS", () => {
    expect([...DATA_CANDIDATE_CATALOG_IDS].toSorted()).toEqual(
      DATA_CANDIDATES.map((c) => c.catalogId).toSorted(),
    );
  });

  it("looks candidates up by catalogId and slug, undefined otherwise", () => {
    expect(findDataCandidateByCatalogId("catalog:stripe-data")).toBe(STRIPE_DATA_CANDIDATE);
    expect(findDataCandidateBySlug("stripe-data")).toBe(STRIPE_DATA_CANDIDATE);
    expect(findDataCandidateByCatalogId("catalog:nope")).toBeUndefined();
    expect(findDataCandidateBySlug("nope")).toBeUndefined();
  });

  it("every candidate's pagination config resolves over the GENERIC registry (no forked strategy)", () => {
    for (const c of DATA_CANDIDATES) {
      if (c.pagination === undefined) continue;
      // Resolving against the default registry proves the candidate reuses a
      // built-in strategy — a forked/unknown strategy would throw here.
      const strategy = defaultPaginatorRegistry.resolve(c.pagination);
      expect(defaultPaginatorRegistry.has(strategy.name)).toBe(true);
    }
  });
});

describe("stripe-data candidate", () => {
  it("is bearer-auth, pre-fills a spec URL, and never asks for one", () => {
    expect(STRIPE_DATA_CANDIDATE.authKind).toBe("bearer");
    expect(STRIPE_DATA_CANDIDATE.openapiUrl).toMatch(/^https?:\/\//);
    // openapi_url + auth_kind are pre-filled, so the install form must NOT carry them.
    const formKeys = DATA_CANDIDATE_CONFIG_SCHEMA.map((f) => f.key);
    expect(formKeys).not.toContain("openapi_url");
    expect(formKeys).not.toContain("auth_kind");
  });

  it("declares the expand[] bracket-array query quirk", () => {
    expect(STRIPE_DATA_CANDIDATE.quirk?.queryParamShaping).toEqual([
      { param: "expand", bracketArray: true },
    ]);
  });

  it("declares cursor pagination keyed on the last item's id + has_more", () => {
    expect(STRIPE_DATA_CANDIDATE.pagination).toMatchObject({
      strategy: "cursor",
      itemsPath: "data",
      cursorParam: "starting_after",
      cursorFromLastItem: true,
      cursorItemField: "id",
      hasMorePath: "has_more",
    });
  });
});

describe("DATA_CANDIDATE_CONFIG_SCHEMA", () => {
  it("marks auth_value as the sole secret field (drives encryptSecretFields)", () => {
    const secretKeys = DATA_CANDIDATE_CONFIG_SCHEMA.filter((f) => f.secret === true).map((f) => f.key);
    expect(secretKeys).toEqual(["auth_value"]);
  });

  it("requires only auth_value (everything else pre-filled or optional)", () => {
    const required = DATA_CANDIDATE_CONFIG_SCHEMA.filter((f) => f.required === true).map((f) => f.key);
    expect(required).toEqual(["auth_value"]);
  });
});
