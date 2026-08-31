/**
 * `lib/vendor-http` — the spine ADR-0045 deferred and #5569 extracted.
 *
 * These cover the four concerns AT THE SPINE, which is the point of having
 * one: before the extraction, only the Jira suite exercised the timeout
 * classification at all — GitHub and Linear had the same `isAbortError` copy
 * and no test for it, and the parity gap that fired the deferral trigger was
 * a fourth sibling that had neither the code nor a test to notice. The per-
 * client suites still pin each vendor's copy and log shape; what they no
 * longer each have to pin is the mechanism.
 *
 * @see ../index.ts
 * @see ../../../../../docs/adr/0045-hand-rolled-vendor-http-clients.md
 */

import { describe, expect, it, mock } from "bun:test";
import {
  FAILURE_DETAIL_MAX_CHARS,
  describeFailureText,
  describeHttpFailure,
  isAbortError,
  pinVendorHost,
  readFailureText,
  truncateFailureDetail,
  withVendorDeadline,
  type VendorHostPinLogger,
} from "@atlas/api/lib/vendor-http";

/**
 * A logger stub, typed by the seam rather than cast to it.
 *
 * `VendorHostPinOptions.log` is `VendorHostPinLogger` — the one method the
 * module calls — which a real pino logger satisfies structurally. That is why
 * this needs no `any`: narrowing the option was the fix, not silencing the
 * lint rule at the call site.
 */
function loggerStub(): {
  calls: Array<{ payload: object; msg: string }>;
  log: VendorHostPinLogger;
} {
  const calls: Array<{ payload: object; msg: string }> = [];
  return {
    calls,
    log: {
      error: mock((payload: object, msg: string) => {
        calls.push({ payload, msg });
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// Concern 3 — timeout/abort
// ---------------------------------------------------------------------------

describe("isAbortError", () => {
  it("⭐ recognizes a DOMException, which does not subclass Error on every runtime", () => {
    // The whole reason the check is duck-typed. An `instanceof Error` check
    // would misreport a timeout as an upstream failure on a runtime where
    // DOMException is not an Error subclass.
    expect(isAbortError(new DOMException("aborted", "AbortError"))).toBe(true);
  });

  it("recognizes a plain object carrying the name", () => {
    expect(isAbortError({ name: "AbortError" })).toBe(true);
  });

  it("does not claim an ordinary error, a null, or a string", () => {
    expect(isAbortError(new Error("connection reset"))).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError("AbortError")).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
  });
});

describe("withVendorDeadline", () => {
  it("returns the value when the callback resolves inside the budget", async () => {
    const result = await withVendorDeadline(1_000, async () => "created");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("created");
  });

  it("⭐ classifies an abort as a timeout rather than an upstream failure", async () => {
    const result = await withVendorDeadline(1_000, async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.reason).toBe("timeout");
      expect(result.failure.timeoutMs).toBe(1_000);
      // The abort itself is kept: its identity is the evidence that the bound
      // was ours and not something the vendor returned.
      expect(isAbortError(result.failure.cause)).toBe(true);
    }
  });

  it("⭐ lets a non-abort rejection propagate untouched", async () => {
    // A transport error is the caller's own vendor-specific business;
    // wrapping it in a result would bury the cause.
    const boom = new Error("ECONNRESET");
    await expect(
      withVendorDeadline(1_000, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });

  it("actually aborts the signal it hands the callback once the budget expires", async () => {
    const result = await withVendorDeadline(
      5,
      (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toBe("timeout");
  });

  it("hands ONE signal to a callback making several requests", async () => {
    // Linear's shape: an optional team lookup then the create, sharing a
    // single budget so the pair cannot outlast the bound between them.
    const seen: AbortSignal[] = [];
    const result = await withVendorDeadline(1_000, async (signal) => {
      seen.push(signal);
      seen.push(signal);
      return "ok";
    });
    expect(result.ok).toBe(true);
    expect(seen[0]).toBe(seen[1] as AbortSignal);
  });

  it("clears its timer on the success path, so the process is not held open", async () => {
    // A leaked timer keeps the event loop alive for the whole budget. Proven
    // by the callback's signal never aborting after the call returns.
    const result = await withVendorDeadline(50, async (signal) => signal);
    expect(result.ok).toBe(true);
    if (result.ok) {
      await new Promise((r) => setTimeout(r, 80));
      expect(result.value.aborted).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Concern 2 — bounded failure-detail narrowing
// ---------------------------------------------------------------------------

describe("truncateFailureDetail", () => {
  it("bounds a runaway body at the documented limit", () => {
    expect(truncateFailureDetail("x".repeat(5_000))).toHaveLength(
      FAILURE_DETAIL_MAX_CHARS,
    );
  });

  it("leaves a short detail alone", () => {
    expect(truncateFailureDetail("Project PROJ does not exist")).toBe(
      "Project PROJ does not exist",
    );
  });

  it("⭐ pins the bound at 200 — the number five sites used to each own", () => {
    expect(FAILURE_DETAIL_MAX_CHARS).toBe(200);
  });
});

describe("readFailureText", () => {
  it("returns the body of a failed response", async () => {
    expect(await readFailureText(new Response("upstream exploded", { status: 502 }))).toBe(
      "upstream exploded",
    );
  });

  it("⭐ returns empty rather than throwing when the body is already consumed", async () => {
    // The status alone is enough to report; turning a vendor's 500 into a
    // parse error the caller never asked about is the failure this prevents.
    const response = new Response("once", { status: 500 });
    await response.text();
    expect(await readFailureText(response)).toBe("");
  });
});

describe("describeFailureText", () => {
  it("composes status and bounded body", async () => {
    expect(await describeFailureText(new Response("nope", { status: 503 }))).toBe(
      "HTTP 503: nope",
    );
  });

  it("falls back to the status alone when there is no body", async () => {
    expect(await describeFailureText(new Response("", { status: 500 }))).toBe("HTTP 500");
  });

  it("bounds the body it composes in", async () => {
    const detail = await describeFailureText(new Response("y".repeat(1_000), { status: 500 }));
    expect(detail).toBe(`HTTP 500: ${"y".repeat(FAILURE_DETAIL_MAX_CHARS)}`);
  });
});

describe("describeHttpFailure", () => {
  it("uses the vendor's structured extractor when the body parses", async () => {
    const failure = await describeHttpFailure(
      new Response(JSON.stringify({ message: "Validation Failed" }), { status: 422 }),
      (body) => (body as { message: string }).message,
    );
    expect(failure).toEqual({ reason: "http", status: 422, detail: "Validation Failed" });
  });

  it("⭐ degrades to the status alone when a structured read fails — the body is spent", async () => {
    // ⚠️ Known, PRESERVED limitation, pinned so nobody "fixes" it by accident.
    // `response.json()` consumes the body whether or not it parses, so the
    // text fallback after a failed structured read has nothing left to read
    // and yields `HTTP <status>`. That is byte-for-byte what jira.ts and
    // github.ts did before the extraction — the fallback was already
    // unreachable-in-practice there, and preserving it was the requirement
    // (#5569: no wire changes).
    //
    // Making it reachable means cloning the response before the parse, which
    // CHANGES agent-visible error copy on every vendor that supplies an
    // extractor. That is a product decision with its own issue, not a tidy-up
    // to fold into a refactor.
    const failure = await describeHttpFailure(
      new Response("<html>gateway timeout</html>", { status: 504 }),
      (body) => (body as { message: string }).message,
    );
    expect(failure.detail).toBe("HTTP 504");
  });

  it("⭐ falls back when the extractor throws on a shape the vendor did not send", async () => {
    // The extractors are deliberately unguarded — they walk the vendor's
    // documented error shape and a throw is the signal that this body is not
    // it. Running them inside the same try as the parse is what makes that
    // equivalent to an unparseable body.
    const failure = await describeHttpFailure(
      new Response(JSON.stringify(null), { status: 500 }),
      (body) => (body as { errors: string[] }).errors.join("; "),
    );
    expect(failure.detail).toBe("HTTP 500");
  });

  it("⭐ the text path DOES carry the bounded body — nothing consumed it first", async () => {
    // The asymmetry above is confined to the extractor path. Linear's client
    // and the email delivery chain take this path, so their truncation is
    // live, not vestigial.
    const failure = await describeHttpFailure(
      new Response("z".repeat(1_000), { status: 502 }),
    );
    expect(failure.detail).toBe(`HTTP 502: ${"z".repeat(FAILURE_DETAIL_MAX_CHARS)}`);
  });

  it("takes the text path when no extractor is supplied", async () => {
    const failure = await describeHttpFailure(new Response("rate limited", { status: 429 }));
    expect(failure).toEqual({ reason: "http", status: 429, detail: "HTTP 429: rate limited" });
  });
});

// ---------------------------------------------------------------------------
// Concern 4 — host pinning
// ---------------------------------------------------------------------------

const JIRA_PIN = {
  label: "The configured Jira base URL",
  subject: "Jira base URL",
  vendor: "Jira",
  shouldBe: "your Jira site URL, e.g. https://acme.atlassian.net",
} as const;

describe("pinVendorHost", () => {
  it("⭐ refuses an internal address before anything reaches the network", () => {
    // The value is typed by a WORKSPACE admin — a tenant on SaaS — and the
    // request carries a credential to whatever host it names.
    for (const host of ["https://localhost", "https://127.0.0.1", "https://169.254.169.254"]) {
      const { log } = loggerStub();
      expect(() => pinVendorHost(host, { ...JIRA_PIN, log: log })).toThrow(
        /reachable public Jira host/,
      );
    }
  });

  it("⭐ does not echo the guard's own verdict back to whoever typed the URL", () => {
    // Repeating "blocked internal address" turns the settings form into a
    // network scanner with a readout.
    const { log } = loggerStub();
    let message = "";
    try {
      pinVendorHost("https://169.254.169.254", { ...JIRA_PIN, log: log });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toMatch(/blocked|internal|denylist|169\.254/i);
    expect(message).toBe(
      "The configured Jira base URL does not point at a reachable public Jira host. Use your Jira site URL, e.g. https://acme.atlassian.net.",
    );
  });

  it("refuses a non-https URL, naming the scheme it got", () => {
    const { log } = loggerStub();
    expect(() =>
      pinVendorHost("http://tenant.atlassian.net", { ...JIRA_PIN, log: log }),
    ).toThrow('The configured Jira base URL must use https (got "http:").');
  });

  it("refuses a malformed URL with actionable copy", () => {
    const { log } = loggerStub();
    expect(() => pinVendorHost("not a url", { ...JIRA_PIN, log: log })).toThrow(
      "The configured Jira base URL is not a valid URL. It should be your Jira site URL, e.g. https://acme.atlassian.net.",
    );
  });

  it("logs the refusal against the caller's own logger, with the host hashed for correlation", () => {
    const { calls, log } = loggerStub();
    expect(() =>
      pinVendorHost("https://127.0.0.1", { ...JIRA_PIN, log: log }),
    ).toThrow();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.msg).toBe("Jira base URL was refused by the egress guard");
    expect(calls[0]?.payload).toHaveProperty("host");
  });

  it("reduces an allowed URL to its origin by default", () => {
    const { log } = loggerStub();
    expect(
      pinVendorHost("https://tenant.my.salesforce.com/", {
        log: log,
        label: "The configured Salesforce instance URL",
        subject: "Salesforce instance URL",
        vendor: "Salesforce",
        shouldBe: "your org's My Domain URL, e.g. https://acme.my.salesforce.com",
      }),
    ).toBe("https://tenant.my.salesforce.com");
  });

  it("keeps the path, trailing slashes stripped, under keepPath", () => {
    const { log } = loggerStub();
    expect(
      pinVendorHost("https://acme.atlassian.net/jira//", {
        ...JIRA_PIN,
        log: log,
        keepPath: true,
      }),
    ).toBe("https://acme.atlassian.net/jira");
  });

  it("⭐ templates both derivations' copy byte-for-byte", () => {
    // Jira and Salesforce reached this check independently and worded it
    // differently. The template had to preserve both exactly, or the
    // extraction would have been a silent wire change.
    const { log } = loggerStub();
    let jira = "";
    let salesforce = "";
    try {
      pinVendorHost("bad", { ...JIRA_PIN, log: log });
    } catch (err) {
      jira = err instanceof Error ? err.message : "";
    }
    try {
      pinVendorHost("bad", {
        log: log,
        label: "The instance URL Salesforce returned",
        subject: "Salesforce instance URL",
        vendor: "Salesforce",
        shouldBe: "your org's My Domain URL, e.g. https://acme.my.salesforce.com",
      });
    } catch (err) {
      salesforce = err instanceof Error ? err.message : "";
    }
    expect(jira).toBe(
      "The configured Jira base URL is not a valid URL. It should be your Jira site URL, e.g. https://acme.atlassian.net.",
    );
    expect(salesforce).toBe(
      "The instance URL Salesforce returned is not a valid URL. It should be your org's My Domain URL, e.g. https://acme.my.salesforce.com.",
    );
  });
});
