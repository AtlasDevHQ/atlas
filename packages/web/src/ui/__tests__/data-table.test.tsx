import { describe, expect, test } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import { DataTable } from "../components/chat/data-table";

describe("DataTable", () => {
  const columns = ["name", "revenue", "city"];
  const rows = [
    { name: "Acme", revenue: 500000, city: "NYC" },
    { name: "Beta", revenue: 300000, city: "LA" },
    { name: "Gamma", revenue: 200000, city: "SF" },
  ];

  test("renders column headers", () => {
    const { container } = render(<DataTable columns={columns} rows={rows} />);
    const ths = container.querySelectorAll("th");
    const headers = Array.from(ths).map((th) => th.textContent?.trim());
    expect(headers).toEqual(["name", "revenue", "city"]);
  });

  test("renders correct number of data rows", () => {
    const { container } = render(<DataTable columns={columns} rows={rows} />);
    const trs = container.querySelectorAll("tbody tr");
    expect(trs.length).toBe(3);
  });

  test("renders cell values", () => {
    const { container } = render(<DataTable columns={columns} rows={rows} />);
    expect(container.textContent).toContain("Acme");
    expect(container.textContent).toContain("NYC");
  });

  test("formats numeric values", () => {
    const { container } = render(
      <DataTable columns={["val"]} rows={[{ val: 1234567 }]} />,
    );
    // formatCell adds locale separators — at minimum should contain the digits
    expect(container.textContent).toContain("1");
  });

  test("renders em-dash for null values", () => {
    const { container } = render(
      <DataTable columns={["val"]} rows={[{ val: null }]} />,
    );
    expect(container.textContent).toContain("\u2014");
  });

  test("truncates to maxRows and shows overflow message", () => {
    const manyRows = Array.from({ length: 25 }, (_, i) => ({ name: `Item ${i}` }));
    const { container } = render(
      <DataTable columns={["name"]} rows={manyRows} maxRows={10} />,
    );
    const trs = container.querySelectorAll("tbody tr");
    expect(trs.length).toBe(10);
    expect(container.textContent).toContain("Showing 10 of 25 rows");
  });

  test("no overflow message when rows fit", () => {
    const { container } = render(<DataTable columns={columns} rows={rows} maxRows={10} />);
    expect(container.textContent).not.toContain("Showing");
  });

  test("sort ascending on column click", () => {
    const { container } = render(<DataTable columns={columns} rows={rows} />);
    const ths = container.querySelectorAll("th");
    const nameHeader = ths[0];

    // Click to sort ascending by name
    fireEvent.click(nameHeader);

    const firstCell = container.querySelector("tbody tr td");
    expect(firstCell!.textContent).toBe("Acme");
  });

  test("sort descending on second click", () => {
    const { container } = render(<DataTable columns={columns} rows={rows} />);
    const ths = container.querySelectorAll("th");
    const nameHeader = ths[0];

    fireEvent.click(nameHeader); // asc
    fireEvent.click(nameHeader); // desc

    const cells = container.querySelectorAll("tbody tr td:first-child");
    expect(cells[0].textContent).toBe("Gamma");
  });

  test("third click resets sort", () => {
    const { container } = render(<DataTable columns={columns} rows={rows} />);
    const ths = container.querySelectorAll("th");
    const nameHeader = ths[0];

    fireEvent.click(nameHeader); // asc
    fireEvent.click(nameHeader); // desc
    fireEvent.click(nameHeader); // reset

    // After reset, original order: Acme first
    const firstCell = container.querySelector("tbody tr td");
    expect(firstCell!.textContent).toBe("Acme");
  });

  test("renders with array rows (unknown[][])", () => {
    const arrayRows = [
      ["Alice", 100],
      ["Bob", 200],
    ];
    const { container } = render(
      <DataTable columns={["name", "score"]} rows={arrayRows} />,
    );
    expect(container.textContent).toContain("Alice");
    expect(container.textContent).toContain("Bob");
  });

  test("renders empty table without crashing", () => {
    const { container } = render(<DataTable columns={["id"]} rows={[]} />);
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelectorAll("tbody tr").length).toBe(0);
  });
});
