/** Optional runtime dependency — dynamically imported for Excel export. */
declare module "xlsx" {
  const utils: {
    json_to_sheet: (data: unknown[], opts?: { header?: string[] }) => unknown;
    book_new: () => unknown;
    book_append_sheet: (wb: unknown, ws: unknown, name: string) => void;
  };
  function write(wb: unknown, opts: { bookType: string; type: string }): ArrayBuffer;
}
