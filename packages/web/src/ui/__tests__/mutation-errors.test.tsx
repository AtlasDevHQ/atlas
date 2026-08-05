import { describe, expect, test, mock } from "bun:test";
import { render } from "@testing-library/react";

// `EnterpriseUpsell` reads useDeployMode (→ useAdminFetch → useAtlasConfig);
// the end-to-end arm below renders it without a provider, so stub the hook to
// a stable mode. SSO is not SaaS-exclusive, so the mode never flips the copy.
void mock.module("@/ui/hooks/use-deploy-mode", () => ({
  useDeployMode: () => ({
    deployMode: "self-hosted",
    loading: false,
    error: null,
    resolved: true,
  }),
}));
import { combineMutationErrors } from "../lib/mutation-errors";
import { serverMessage, type FetchError } from "../lib/fetch-error";
import { MutationErrorSurface } from "../components/admin/mutation-error-surface";

function err(message: string, overrides: Partial<FetchError> = {}): FetchError {
  return { message, ...overrides };
}

describe("combineMutationErrors", () => {
  test("returns null when all slots are empty", () => {
    expect(combineMutationErrors([])).toBeNull();
    expect(combineMutationErrors([null, undefined])).toBeNull();
    expect(combineMutationErrors([null, undefined, err("")])).toBeNull();
  });

  test("returns the single FetchError when only one slot is set", () => {
    const e = err("boom", { status: 500, requestId: "req-1" });
    expect(combineMutationErrors([null, e, undefined])).toEqual(e);
  });

  test("appends a '+N more' suffix when multiple distinct messages are present", () => {
    expect(combineMutationErrors([err("one"), err("two")])?.message).toBe(
      "one (+1 more)",
    );
    expect(
      combineMutationErrors([err("one"), err("two"), err("three")])?.message,
    ).toBe("one (+2 more)");
  });

  test("deduplicates identical messages so the suffix reflects distinct failures", () => {
    expect(combineMutationErrors([err("same"), err("same")])?.message).toBe("same");
    expect(
      combineMutationErrors([err("a"), err("b"), err("a")])?.message,
    ).toBe("a (+1 more)");
  });

  test("skips empty strings and keeps the first real message as primary", () => {
    expect(
      combineMutationErrors([err(""), err("first"), err(""), err("second")])
        ?.message,
    ).toBe("first (+1 more)");
  });

  test("preserves insertion order across the banner", () => {
    expect(
      combineMutationErrors([err("later"), err("earlier")])?.message,
    ).toBe("later (+1 more)");
  });

  test("preserves structured fields from the first distinct error", () => {
    const first = err("gated", {
      status: 403,
      code: "enterprise_required",
      requestId: "req-abc",
    });
    const second = err("other", { status: 500 });
    const combined = combineMutationErrors([first, second]);
    expect(combined).toEqual({
      message: "gated (+1 more)",
      status: 403,
      code: "enterprise_required",
      requestId: "req-abc",
    });
  });

  test("leaves a synthesized placeholder UNDECORATED so it stays recognizable (#5068)", () => {
    // Provenance is recovered by string-comparing against the two spellings
    // this module mints, so ANY transform destroys it. `"HTTP 403 (+1 more)"`
    // matches no sentinel — but neither does `"Request failed (+1 more)"`, so
    // re-wording is not a fix. `serverMessage` returning undefined is the
    // property that matters, and it is the only one a downstream surface can
    // act on. The combiner is the codebase's one message transform, so it is
    // the one place that has to know. Reachable from every
    // `combineMutationErrors` consumer — all six feed `MutationErrorSurface`.
    const combined = combineMutationErrors([
      err("HTTP 403", { status: 403, requestId: "req-x" }),
      err("HTTP 500", { status: 500 }),
    ]);
    expect(combined?.message).toBe("HTTP 403");
    expect(serverMessage(combined!)).toBeUndefined();
    // The count is what gets dropped — cosmetic, and the price of a correct
    // diagnosis. Assert it so the trade is visible rather than assumed.
    expect(combined?.message).not.toContain("+1 more");
    expect(combined?.requestId).toBe("req-x");
  });

  test("a placeholder never shadows a sibling's real message or its requestId", () => {
    // The combined error is the SOLE surface on all six consumers — there is
    // no per-mutation banner behind it. So returning the placeholder as-is
    // when a sibling actually explained itself discards that explanation and
    // its correlation id with no signal at all, which is worse than the
    // status echo it was avoiding. Demote the un-explanatory instead.
    const combined = combineMutationErrors([
      err("HTTP 403", { status: 403, code: "enterprise_required" }),
      err("Migration failed: disk full on region eu-west", { status: 500, requestId: "req-b" }),
    ]);
    expect(combined?.message).toBe("Migration failed: disk full on region eu-west (+1 more)");
    expect(combined?.requestId).toBe("req-b");
    // ...and the demotion is total: the placeholder's status/code must not
    // ride along, or the gate would still render an enterprise upsell.
    expect(combined?.status).toBe(500);
    expect(combined?.code).toBeUndefined();
  });

  test("skips blank and de-dupes on the trimmed message", () => {
    // Both `.trim()`s shipped unfalsified. A whitespace-only primary produced
    // a gate description of "(+1 more)" — the blank-chrome class, and the
    // motivating case the code comment names.
    expect(combineMutationErrors([err("   "), err("real")])?.message).toBe("real");
    expect(combineMutationErrors([err("a"), err(" a ")])?.message).toBe("a");
  });

  test("an ALL-placeholder set still renders the gate's CANNED copy end-to-end", () => {
    // The string assertions above are necessary and not sufficient: what makes
    // this a regression-vs-main is what an admin reads. Before this arm, the
    // combiner→gate boundary had no test at all, which is how two successive
    // fixes to the same defect both looked complete.
    const combined = combineMutationErrors([
      err("HTTP 403", { status: 403, code: "enterprise_required" }),
      err("HTTP 500", { status: 500 }),
    ]);
    const { container } = render(
      <MutationErrorSurface error={combined} feature="SSO" />,
    );
    expect(container.textContent).toContain("contact sales");
    expect(container.textContent).not.toContain("+1 more");
    expect(container.textContent).not.toContain("HTTP 403");
  });

  test("still builds the suffix onto a REAL server message", () => {
    // The complement — without it the fix above could throw away every
    // message and still pass.
    const combined = combineMutationErrors([
      err("Platform admin role required.", { status: 403 }),
      err("other", { status: 500 }),
    ]);
    expect(combined?.message).toBe("Platform admin role required. (+1 more)");
  });
});
