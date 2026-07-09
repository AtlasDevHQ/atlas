import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";

/**
 * Pins the upload dialog's two response paths (#81 arch review follow-up):
 * a successful ingest renders real counts + skipped/rejected details, and a
 * whole-bundle 400 renders the per-file rejections WITHOUT fabricating wire
 * fields (the panel state is its own view type — `documents: null`, no made-up
 * `format`).
 */

void mock.module("@/lib/api-url", () => ({ getApiUrl: () => "" }));

const UploadBundleDialog = (await import("../upload-bundle-dialog")).UploadBundleDialog;

let responseStatus = 200;
let responseBody: unknown = {};
const realFetch = globalThis.fetch;

beforeEach(() => {
  responseStatus = 200;
  responseBody = {};
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(responseBody), { status: responseStatus })) as typeof globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  cleanup();
});

function renderDialog() {
  const onIngested = mock(() => {});
  render(
    <UploadBundleDialog
      collectionSlug="runbooks"
      open
      onOpenChange={() => {}}
      onIngested={onIngested}
    />,
  );
  return onIngested;
}

async function pickFileAndSubmit() {
  const input = screen.getByTestId("bundle-file") as HTMLInputElement;
  const file = new File([new Uint8Array([1, 2, 3])], "kb.zip", { type: "application/zip" });
  fireEvent.change(input, { target: { files: [file] } });
  fireEvent.click(screen.getByTestId("upload-submit"));
}

describe("UploadBundleDialog response paths", () => {
  test("a successful ingest renders counts, skipped-asset note, and rejections", async () => {
    responseBody = {
      collection: "runbooks",
      format: "zip",
      documents: { created: 2, updated: 1, demoted: 0, resurrected: 0, unchanged: 3, total: 6 },
      linksWritten: 4,
      published: false,
      rejected: [{ path: "bad.md", reason: "unterminated frontmatter block" }],
      skippedNonMarkdown: 5,
    };
    const onIngested = renderDialog();
    await pickFileAndSubmit();

    await waitFor(() => expect(screen.queryByText(/2 new/)).not.toBeNull());
    expect(screen.queryByText(/5 non-markdown files skipped/)).not.toBeNull();
    expect(screen.queryByText(/1 file rejected/)).not.toBeNull();
    expect(screen.queryByText(/unterminated frontmatter block/)).not.toBeNull();
    expect(onIngested).toHaveBeenCalled();
  });

  test("a whole-bundle 400 shows the error + per-file rejections with NO fabricated counts", async () => {
    responseStatus = 400;
    responseBody = {
      error: "no_documents",
      message: "No ingestable documents — every file was rejected.",
      requestId: "req-12345678",
      rejected: [{ path: "../evil.md", reason: "unsafe path" }],
    };
    const onIngested = renderDialog();
    await pickFileAndSubmit();

    await waitFor(() => expect(screen.queryByText(/every file was rejected/)).not.toBeNull());
    // The rejection list renders; the counts line ("N new · …") must NOT — the
    // error path has no ingest counts and must not invent any.
    expect(screen.queryByText(/unsafe path/)).not.toBeNull();
    expect(screen.queryByText(/new ·/)).toBeNull();
    expect(onIngested).not.toHaveBeenCalled();
  });
});
