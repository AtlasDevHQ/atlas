import { describe, expect, test } from "bun:test";
import { detectDbLabel } from "./db-labels";

describe("detectDbLabel", () => {
  test("maps postgresql:// to PostgreSQL", () => {
    expect(detectDbLabel("postgresql://u:p@host:5432/db")).toBe("PostgreSQL");
  });

  test("maps postgres:// to PostgreSQL", () => {
    expect(detectDbLabel("postgres://u:p@host:5432/db")).toBe("PostgreSQL");
  });

  test("maps mysql:// to MySQL", () => {
    expect(detectDbLabel("mysql://u:p@host:3306/db")).toBe("MySQL");
  });

  test("maps mysql2:// to MySQL", () => {
    expect(detectDbLabel("mysql2://u:p@host:3306/db")).toBe("MySQL");
  });

  test("falls back to Database for unknown schemes", () => {
    expect(detectDbLabel("sqlite:///path/to/db")).toBe("Database");
  });

  test("falls back to Database for empty string", () => {
    expect(detectDbLabel("")).toBe("Database");
  });
});
