import { describe, expect, test } from "bun:test";
import {
  computeScore,
  createAnalysisResult,
  tableFrequencyImpact,
  coverageImpact,
} from "../scoring";

describe("computeScore", () => {
  test("returns impact × confidence × (1 - staleness)", () => {
    expect(computeScore(0.8, 0.9, 0)).toBe(0.72);
  });

  test("staleness of 1 produces 0", () => {
    expect(computeScore(1, 1, 1)).toBe(0);
  });

  test("all zeros produce 0", () => {
    expect(computeScore(0, 0, 0)).toBe(0);
  });

  test("all ones with zero staleness produce 1", () => {
    expect(computeScore(1, 1, 0)).toBe(1);
  });

  test("rounds to 3 decimal places", () => {
    // 0.7 * 0.3 * (1 - 0.1) = 0.189
    expect(computeScore(0.7, 0.3, 0.1)).toBe(0.189);
  });

  test("partial staleness reduces score", () => {
    const full = computeScore(0.8, 0.9, 0);
    const stale = computeScore(0.8, 0.9, 0.5);
    expect(stale).toBeLessThan(full);
    expect(stale).toBe(0.36);
  });
});

describe("createAnalysisResult", () => {
  test("auto-computes score from impact, confidence, staleness", () => {
    const result = createAnalysisResult({
      category: "coverage_gaps",
      entityName: "orders",
      amendmentType: "add_dimension",
      amendment: { name: "status", sql: "status", type: "string" },
      rationale: "test",
      impact: 0.8,
      confidence: 0.9,
      staleness: 0,
    });
    expect(result.score).toBe(0.72);
  });

  test("preserves all input fields", () => {
    const result = createAnalysisResult({
      category: "missing_measures",
      entityName: "products",
      amendmentType: "add_measure",
      amendment: { name: "total_price", sql: "price", type: "sum" },
      rationale: "numeric column",
      testQuery: "SELECT SUM(price) FROM products",
      impact: 0.5,
      confidence: 0.7,
      staleness: 0.2,
    });
    expect(result.category).toBe("missing_measures");
    expect(result.entityName).toBe("products");
    expect(result.testQuery).toBe("SELECT SUM(price) FROM products");
    expect(result.score).toBe(0.28);
  });
});

describe("tableFrequencyImpact", () => {
  test("returns 0.5 when no audit patterns exist", () => {
    expect(tableFrequencyImpact("orders", [])).toBe(0.5);
  });

  test("returns higher impact for frequently-queried tables", () => {
    const patterns = [
      { tables: ["orders"], count: 10 },
      { tables: ["users"], count: 80 },
      { tables: ["products"], count: 2 },
    ];
    // orders: 10/92 * 5 = 0.543, products: 2/92 * 5 = 0.108
    const ordersImpact = tableFrequencyImpact("orders", patterns);
    const productsImpact = tableFrequencyImpact("products", patterns);
    expect(ordersImpact).toBeGreaterThan(productsImpact);
  });

  test("caps at 1.0", () => {
    const patterns = [{ tables: ["orders"], count: 100 }];
    expect(tableFrequencyImpact("orders", patterns)).toBe(1);
  });

  test("returns 0 for unqueried tables", () => {
    const patterns = [{ tables: ["orders"], count: 50 }];
    expect(tableFrequencyImpact("users", patterns)).toBe(0);
  });
});

describe("coverageImpact", () => {
  test("returns 0 when all columns documented", () => {
    expect(coverageImpact(10, 10)).toBe(0);
  });

  test("returns 1 when no columns documented", () => {
    expect(coverageImpact(10, 0)).toBe(1);
  });

  test("returns 0 when totalColumns is 0", () => {
    expect(coverageImpact(0, 0)).toBe(0);
  });

  test("returns 0.5 when half columns documented", () => {
    expect(coverageImpact(10, 5)).toBe(0.5);
  });
});
