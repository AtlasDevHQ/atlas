/** Optional runtime dependency — dynamically imported for Excel export. */
declare module "exceljs" {
  export class Workbook {
    addWorksheet(name: string): Worksheet;
    xlsx: { writeBuffer(): Promise<ArrayBuffer> };
  }
  interface Worksheet {
    columns: Array<{ header: string; key: string }>;
    addRow(data: Record<string, unknown>): void;
  }
}
