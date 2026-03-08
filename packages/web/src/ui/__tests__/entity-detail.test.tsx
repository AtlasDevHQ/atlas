import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { EntityDetail, type EntityData } from "../components/admin/entity-detail";

function makeEntity(overrides: Partial<EntityData> = {}): EntityData {
  return {
    name: "users",
    table: "users",
    description: "User accounts table",
    dimensions: {
      id: { name: "id", type: "integer", description: "Primary key", primary_key: true },
      email: { name: "email", type: "string", description: "User email", sample_values: ["alice@co.com", "bob@co.com"] },
      org_id: { name: "org_id", type: "integer", description: "Organization FK", foreign_key: true },
    },
    ...overrides,
  };
}

describe("EntityDetail", () => {
  test("renders entity name and description", () => {
    const { container } = render(<EntityDetail entity={makeEntity()} />);
    expect(container.textContent).toContain("users");
    expect(container.textContent).toContain("User accounts table");
  });

  test("renders view badge for views", () => {
    const { container } = render(<EntityDetail entity={makeEntity({ type: "view" })} />);
    expect(container.textContent).toContain("view");
  });

  test("shows table name when different from entity name", () => {
    const { container } = render(
      <EntityDetail entity={makeEntity({ name: "user_entity", table: "public.users" })} />,
    );
    expect(container.textContent).toContain("public.users");
  });

  test("renders dimensions with types", () => {
    const { container } = render(<EntityDetail entity={makeEntity()} />);
    expect(container.textContent).toContain("id");
    expect(container.textContent).toContain("integer");
    expect(container.textContent).toContain("email");
    expect(container.textContent).toContain("string");
  });

  test("shows PK badge for primary key columns", () => {
    const { container } = render(<EntityDetail entity={makeEntity()} />);
    expect(container.textContent).toContain("PK");
  });

  test("shows FK badge for foreign key columns", () => {
    const { container } = render(<EntityDetail entity={makeEntity()} />);
    expect(container.textContent).toContain("FK");
  });

  test("renders sample values", () => {
    const { container } = render(<EntityDetail entity={makeEntity()} />);
    expect(container.textContent).toContain("alice@co.com");
    expect(container.textContent).toContain("bob@co.com");
  });

  test("renders dimension count header", () => {
    const { container } = render(<EntityDetail entity={makeEntity()} />);
    expect(container.textContent).toContain("Dimensions (3)");
  });

  test("renders joins when provided", () => {
    const entity = makeEntity({
      joins: [
        { to: "organizations", description: "users.org_id → organizations.id", relationship: "many_to_one" },
      ],
    });
    const { container } = render(<EntityDetail entity={entity} />);
    expect(container.textContent).toContain("Joins (1)");
    expect(container.textContent).toContain("organizations");
    expect(container.textContent).toContain("many_to_one");
  });

  test("renders measures when provided", () => {
    const entity = makeEntity({
      measures: {
        total_users: { name: "total_users", sql: "COUNT(DISTINCT id)", type: "count" },
      },
    });
    const { container } = render(<EntityDetail entity={entity} />);
    expect(container.textContent).toContain("Measures (1)");
    expect(container.textContent).toContain("total_users");
    expect(container.textContent).toContain("COUNT(DISTINCT id)");
  });

  test("renders query patterns when provided", () => {
    const entity = makeEntity({
      query_patterns: {
        users_by_org: {
          name: "users_by_org",
          description: "Count users per org",
          sql: "SELECT org_id, COUNT(*) FROM users GROUP BY 1",
        },
      },
    });
    const { container } = render(<EntityDetail entity={entity} />);
    expect(container.textContent).toContain("Query Patterns (1)");
    expect(container.textContent).toContain("users_by_org");
    expect(container.textContent).toContain("Count users per org");
  });

  test("omits joins section when no joins", () => {
    const { container } = render(<EntityDetail entity={makeEntity()} />);
    expect(container.textContent).not.toContain("Joins");
  });

  test("handles dimensions as array format", () => {
    const entity = makeEntity({
      dimensions: [
        { name: "col_a", type: "string" },
        { name: "col_b", type: "number" },
      ],
    });
    const { container } = render(<EntityDetail entity={entity} />);
    expect(container.textContent).toContain("col_a");
    expect(container.textContent).toContain("col_b");
    expect(container.textContent).toContain("Dimensions (2)");
  });
});
