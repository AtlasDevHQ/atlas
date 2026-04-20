import { describe, expect, test } from "bun:test";
import {
  PIIColumnClassificationSchema,
  SemanticDiffResponseSchema,
  WorkspaceBrandingSchema,
  WorkspaceModelConfigSchema,
} from "../admin-config";
import {
  MASKING_STRATEGIES,
  PII_CATEGORIES,
  PII_CONFIDENCE_LEVELS,
} from "@useatlas/types";

const validBranding = {
  id: "brand_1",
  orgId: "org_1",
  logoUrl: "https://example.com/logo.png",
  logoText: "Acme",
  primaryColor: "#FF5500",
  faviconUrl: null,
  hideAtlasBranding: true,
  createdAt: "2026-04-20T12:00:00.000Z",
  updatedAt: "2026-04-20T12:00:00.000Z",
};

const validModelConfig = {
  id: "cfg_1",
  orgId: "org_1",
  provider: "anthropic",
  model: "claude-opus-4-6",
  baseUrl: null,
  apiKeyMasked: "sk-ant-...abc",
  createdAt: "2026-04-20T12:00:00.000Z",
  updatedAt: "2026-04-20T12:00:00.000Z",
};

const validPII = {
  id: "pii_1",
  orgId: "org_1",
  tableName: "users",
  columnName: "email",
  connectionId: "conn_1",
  category: "email" as const,
  confidence: "high" as const,
  maskingStrategy: "partial" as const,
  reviewed: true,
  dismissed: false,
  createdAt: "2026-04-20T12:00:00.000Z",
  updatedAt: "2026-04-20T12:00:00.000Z",
};

const validDiff = {
  connection: "default",
  newTables: ["orders"],
  removedTables: ["legacy_foo"],
  tableDiffs: [
    {
      table: "users",
      addedColumns: [{ name: "phone", type: "text" }],
      removedColumns: [],
      typeChanges: [{ name: "age", yamlType: "number", dbType: "int" }],
    },
  ],
  unchangedCount: 8,
  summary: { total: 10, new: 1, removed: 1, changed: 1, unchanged: 8 },
};

describe("WorkspaceBrandingSchema", () => {
  test("parses a valid branding row", () => {
    expect(WorkspaceBrandingSchema.parse(validBranding)).toEqual(validBranding);
  });

  test("rejects non-ISO createdAt", () => {
    expect(() => WorkspaceBrandingSchema.parse({ ...validBranding, createdAt: "yesterday" })).toThrow();
  });
});

describe("WorkspaceModelConfigSchema", () => {
  test("parses a valid model config", () => {
    expect(WorkspaceModelConfigSchema.parse(validModelConfig)).toEqual(validModelConfig);
  });
});

describe("PIIColumnClassificationSchema", () => {
  test("parses a valid classification", () => {
    expect(PIIColumnClassificationSchema.parse(validPII)).toEqual(validPII);
  });

  test("rejects unknown category", () => {
    expect(() => PIIColumnClassificationSchema.parse({ ...validPII, category: "crypto_wallet" })).toThrow();
  });

  test("rejects unknown confidence", () => {
    expect(() => PIIColumnClassificationSchema.parse({ ...validPII, confidence: "certain" })).toThrow();
  });

  test("rejects unknown maskingStrategy", () => {
    expect(() => PIIColumnClassificationSchema.parse({ ...validPII, maskingStrategy: "encrypt" })).toThrow();
  });

  test("all PII_CATEGORIES values parse", () => {
    for (const category of PII_CATEGORIES) {
      expect(() => PIIColumnClassificationSchema.parse({ ...validPII, category })).not.toThrow();
    }
  });

  test("all PII_CONFIDENCE_LEVELS values parse", () => {
    for (const confidence of PII_CONFIDENCE_LEVELS) {
      expect(() => PIIColumnClassificationSchema.parse({ ...validPII, confidence })).not.toThrow();
    }
  });

  test("all MASKING_STRATEGIES values parse", () => {
    for (const maskingStrategy of MASKING_STRATEGIES) {
      expect(() => PIIColumnClassificationSchema.parse({ ...validPII, maskingStrategy })).not.toThrow();
    }
  });
});

describe("SemanticDiffResponseSchema", () => {
  test("parses a full diff", () => {
    expect(SemanticDiffResponseSchema.parse(validDiff)).toEqual(validDiff);
  });

  test("warnings is optional", () => {
    expect(() => SemanticDiffResponseSchema.parse({ ...validDiff, warnings: undefined })).not.toThrow();
  });

  test("accepts empty diff", () => {
    const empty = {
      connection: "default",
      newTables: [],
      removedTables: [],
      tableDiffs: [],
      unchangedCount: 0,
      summary: { total: 0, new: 0, removed: 0, changed: 0, unchanged: 0 },
    };
    expect(() => SemanticDiffResponseSchema.parse(empty)).not.toThrow();
  });
});
