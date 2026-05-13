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
  provider: "anthropic" as const,
  model: "claude-opus-4-6",
  baseUrl: null,
  // bedrockRegion is required by the cross-field refine for non-bedrock
  // providers — it must be null when provider !== "bedrock".
  bedrockRegion: null,
  apiKeyMasked: "sk-ant-...abc",
  apiKeyStatus: "masked" as const,
  modelStatus: "healthy" as const,
  modelSuggestedReplacement: null,
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

  test("accepts gateway provider with null apiKeyMasked on platform credits", () => {
    const gatewayConfig = {
      ...validModelConfig,
      provider: "gateway" as const,
      model: "anthropic/claude-opus-4.6",
      apiKeyMasked: null,
      apiKeyStatus: "platform_credits" as const,
    };
    expect(WorkspaceModelConfigSchema.parse(gatewayConfig)).toEqual(gatewayConfig);
  });

  test("accepts gateway provider with BYOT key", () => {
    const byotConfig = {
      ...validModelConfig,
      provider: "gateway" as const,
      model: "anthropic/claude-opus-4.6",
      apiKeyMasked: "*****abcd",
      apiKeyStatus: "masked" as const,
    };
    expect(WorkspaceModelConfigSchema.parse(byotConfig)).toEqual(byotConfig);
  });

  test("accepts decrypt_failed status with null apiKeyMasked on any provider", () => {
    const broken = {
      ...validModelConfig,
      apiKeyMasked: null,
      apiKeyStatus: "decrypt_failed" as const,
    };
    expect(WorkspaceModelConfigSchema.parse(broken)).toEqual(broken);
  });

  test("rejects masked status with null apiKeyMasked", () => {
    const broken = {
      ...validModelConfig,
      apiKeyMasked: null,
      apiKeyStatus: "masked" as const,
    };
    expect(() => WorkspaceModelConfigSchema.parse(broken)).toThrow();
  });

  test("rejects non-gateway provider with platform_credits status", () => {
    const wrong = {
      ...validModelConfig,
      apiKeyMasked: null,
      apiKeyStatus: "platform_credits" as const,
    };
    expect(() => WorkspaceModelConfigSchema.parse(wrong)).toThrow();
  });

  test("accepts bedrock provider with a region", () => {
    const bedrockConfig = {
      ...validModelConfig,
      provider: "bedrock" as const,
      model: "anthropic.claude-opus-4-v1:0",
      bedrockRegion: "us-east-1" as const,
      apiKeyMasked: "*****stored",
      apiKeyStatus: "masked" as const,
    };
    expect(WorkspaceModelConfigSchema.parse(bedrockConfig)).toEqual(bedrockConfig);
  });

  test("rejects bedrock provider without a region", () => {
    const noRegion = {
      ...validModelConfig,
      provider: "bedrock" as const,
      model: "anthropic.claude-opus-4-v1:0",
      bedrockRegion: null,
      apiKeyMasked: "*****stored",
      apiKeyStatus: "masked" as const,
    };
    expect(() => WorkspaceModelConfigSchema.parse(noRegion)).toThrow();
  });

  test("rejects non-bedrock provider that carries a region", () => {
    const stray = {
      ...validModelConfig,
      bedrockRegion: "us-east-1" as const,
    };
    expect(() => WorkspaceModelConfigSchema.parse(stray)).toThrow();
  });

  test("accepts deprecated modelStatus with a suggestion", () => {
    const deprecated = {
      ...validModelConfig,
      modelStatus: "deprecated" as const,
      modelSuggestedReplacement: "claude-opus-4-7",
    };
    expect(WorkspaceModelConfigSchema.parse(deprecated)).toEqual(deprecated);
  });

  test("accepts deprecated modelStatus with no suggestion (inconclusive)", () => {
    const deprecated = {
      ...validModelConfig,
      modelStatus: "deprecated" as const,
      modelSuggestedReplacement: null,
    };
    expect(WorkspaceModelConfigSchema.parse(deprecated)).toEqual(deprecated);
  });

  test("rejects healthy modelStatus with a stray suggestion", () => {
    const stray = {
      ...validModelConfig,
      modelStatus: "healthy" as const,
      modelSuggestedReplacement: "claude-opus-4-7",
    };
    expect(() => WorkspaceModelConfigSchema.parse(stray)).toThrow();
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

  test("connectionId accepts null (post-0064 nullable)", () => {
    // Migration 0064 dropped the legacy `NOT NULL DEFAULT 'default'`.
    // Bundles emitted post-#2341 may carry `connectionId: null` for
    // rows whose source connection was deleted.
    const nullScoped = { ...validPII, connectionId: null };
    expect(PIIColumnClassificationSchema.parse(nullScoped)).toEqual(nullScoped);
  });

  test("connectionGroupId is additive — optional with null allowed", () => {
    // #2341 added the field. Legacy bundles omit it; new bundles populate
    // either a group id or null (for un-scoped / cross-env rows).
    expect(() => PIIColumnClassificationSchema.parse(validPII)).not.toThrow();
    expect(() => PIIColumnClassificationSchema.parse({ ...validPII, connectionGroupId: "g_prod" })).not.toThrow();
    expect(() => PIIColumnClassificationSchema.parse({ ...validPII, connectionGroupId: null })).not.toThrow();
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
