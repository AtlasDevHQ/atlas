import { describe, expect, test } from "bun:test";
import {
  SWEEP_CONTENTIONS,
  isSweepContention,
  sweepOutcome,
  sweepRefusal,
} from "../sweep-report";

/**
 * The sweep's copy decisions (#5447).
 *
 * Two properties, and both are stated as prohibitions because that is what they
 * are:
 *
 *   1. A `{minted: 0}` NEVER reads as done. The route's own 200 description says
 *      the number is three facts wearing one, and names which three.
 *   2. The three 409 arms never collapse into one sentence — not when the server
 *      supplies prose, and not when it supplies none.
 *
 * Every assertion here would also pass against a function returning the empty
 * string, so each is paired with the state that must produce the opposite.
 */

const err = (over: Partial<Parameters<typeof sweepRefusal>[0]> = {}) => ({
  message: "HTTP 409",
  status: 409,
  ...over,
});

describe("sweepRefusal — three arms, three sentences", () => {
  test("the SERVER's prose wins verbatim", () => {
    // The rule `onAuthor` states one file over: the server owns these
    // sentences, and a client that re-spelled them would drift from the seam
    // that knows which contention happened.
    const authored =
      "The tension sweep could not start: another operation holds this workspace's reconcile lock.";
    expect(sweepRefusal(err({ message: authored, code: "reconcile-lock" }))).toContain(authored);
  });

  test("with no prose, each documented arm still reads as itself", () => {
    const rendered = SWEEP_CONTENTIONS.map((code) => sweepRefusal(err({ code })));
    // Three DISTINCT sentences — the acceptance bar. A shared status line
    // ("the server rejected the request (409)") satisfies every individual
    // assertion below and fails this one.
    expect(new Set(rendered).size).toBe(3);
    expect(rendered[0]).toContain("reconcile lock");
    expect(rendered[1]).toContain("conflicting lock");
    expect(rendered[2]).toContain("did not complete");
    // All three documented arms guarantee it, so all three may say it.
    for (const text of rendered) expect(text).toContain("Nothing was changed");
  });

  test("⚠️ `unfinished` does not blame the size of the corpus, and does not rule out a retry", () => {
    // The SQLSTATE covers a timeout AND a cancellation and does not
    // distinguish them, so a message that assumes the timeout sends an operator
    // whose statement was merely cancelled hunting a problem that does not
    // exist — with the one correct remedy ruled out.
    const text = sweepRefusal(err({ code: "unfinished" }));
    expect(text).toContain("Retry once");
    expect(text.toLowerCase()).not.toContain("too much data");
    expect(text.toLowerCase()).not.toContain("too large");
  });

  test("⚠️ an UNRECOGNISED 409 does not assert that nothing was changed", () => {
    // The one clause true of all three documented arms is the one that must not
    // be hoisted: a fourth code is an API newer than this bundle, and claiming
    // the corpus is untouched on its behalf is a claim about a code path that
    // did not exist when the sentence was written.
    const text = sweepRefusal(err({ code: "some-new-bound" }));
    expect(text).not.toContain("Nothing was changed");
    expect(text).toContain("unchanged");
    expect(text).toContain("some-new-bound");
  });

  test("the requestId is appended — on the server's prose AND on the fallback", () => {
    // This copy's own advice is "check the API service logs", which is the one
    // place a correlation id is the entire point. Both paths now run through
    // `friendlyError`, so neither can lose it.
    const authored = sweepRefusal(
      err({ message: "It hit the reconcile lock.", code: "reconcile-lock", requestId: "req-7" }),
    );
    expect(authored).toContain("req-7");
    const fallback = sweepRefusal(err({ code: "reconcile-lock", requestId: "req-8" }));
    expect(fallback).toContain("req-8");
    expect(fallback).toContain("reconcile lock");
  });

  test("⚠️ a STATUS-LESS failure keeps its client-authored message", () => {
    // `serverMessage` early-returns on `status === undefined` by design, so the
    // earlier hand-written tail replaced these with "the server explained
    // nothing" — a claim about a server that was never reached. The hook's own
    // non-JSON message is the motivating case.
    // ⚠️ NOT the `schema_mismatch` code, though that is also status-less:
    // `friendlyError` deliberately substitutes its own "server and app are out of
    // sync" copy for that one, so a fixture carrying it would test that branch
    // instead of this claim. A bare network failure is the case that motivates it.
    const text = sweepRefusal({
      message: "Server returned a non-JSON response. Check your proxy / deploy configuration.",
    });
    expect(text).toContain("proxy");
    expect(text).not.toContain("the server explained nothing");
  });

  test("⚠️ a 5xx says the sweep's EFFECT is unknown — it is a writer", () => {
    // A 5xx can land after edges have already committed, so "nothing changed" is
    // not available. `friendlyError`'s shared copy is silent about the corpus,
    // which is right for the reads it mostly serves and wrong here.
    const text = sweepRefusal({ message: "HTTP 500", status: 500 });
    expect(text).toContain("unknown");
    expect(text).not.toContain("Nothing was changed");
    // A network failure is the same position — the response was lost, not
    // necessarily the request.
    expect(sweepRefusal({ message: "Could not reach the server." })).toContain("unknown");
  });

  test("POSITIVE CONTROL — a 4xx does NOT get the doubt clause", () => {
    // 401/403/404/429 are refused before the sweep does any work, so manufacturing
    // a doubt there would be its own dishonesty. This is what makes the assertion
    // above about the 5xx branch rather than about an unconditional suffix.
    const text = sweepRefusal({
      message: "The tension sweep needs the owner or admin entitlement.",
      status: 403,
    });
    expect(text).toContain("owner or admin entitlement");
    expect(text).not.toContain("before failing is unknown");
  });

  test("isSweepContention rejects an undefined code and an unknown one", () => {
    expect(isSweepContention(undefined)).toBe(false);
    expect(isSweepContention("reconcile-lock")).toBe(true);
    expect(isSweepContention("nope")).toBe(false);
  });
});

describe("sweepOutcome — a zero is three facts, never an all-clear", () => {
  test("⚠️ `{minted: 0}` names all three causes and is NOT resolved", () => {
    const copy = sweepOutcome({ minted: 0, truncated: false });
    const all = [copy.headline, ...copy.clauses].join(" ");
    expect(copy.unresolved).toBe(true);
    expect(all).toContain("does not identify a cause");
    // The three the route documents, each as its own clause.
    expect(all).toContain("curated single-valued AND approved");
    expect(all).toContain("already converged");
    expect(all).toContain("no live facts");
    // And the phrasing this panel exists to refuse.
    expect(all.toLowerCase()).not.toContain("nothing to flag");
    expect(all.toLowerCase()).not.toContain("up to date");
  });

  test("the COMMONEST cause is first, and it says a pending proposal does not count", () => {
    // Ordering is load-bearing: a workspace that has just started curating has a
    // PENDING entry, and the sweep is armed only by an APPROVED one. Listing
    // "the corpus has converged" first sends that operator to the wrong page.
    const copy = sweepOutcome({ minted: 0, truncated: false });
    const first = copy.clauses.find((c) => c.includes("curated single-valued"));
    const converged = copy.clauses.find((c) => c.includes("already converged"));
    expect(first).toBeDefined();
    expect(converged).toBeDefined();
    expect(copy.clauses.indexOf(first!)).toBeLessThan(copy.clauses.indexOf(converged!));
    expect(first).toContain("pending proposal does not count");
  });

  test("a non-zero run states the count, and that the write is additive", () => {
    const copy = sweepOutcome({ minted: 4, truncated: false });
    expect(copy.headline).toContain("4 advisory tension edges");
    expect(copy.unresolved).toBe(false);
    expect(copy.clauses.join(" ")).toContain("additive and advisory");
    // POSITIVE CONTROL for the assertions above: a non-zero run must NOT carry
    // the zero's three causes, or those assertions would pass on every input.
    expect(copy.clauses.join(" ")).not.toContain("does not identify a cause");
  });

  test("one edge is singular", () => {
    expect(sweepOutcome({ minted: 1, truncated: false }).headline).toContain("1 advisory tension edge.");
  });

  test("`truncated` says run it again to resume — on BOTH arms", () => {
    // The run cap can bite on a sweep that wrote nothing, so the clause cannot
    // live inside the non-zero branch.
    for (const minted of [0, 7]) {
      const copy = sweepOutcome({ minted, truncated: true });
      const all = copy.clauses.join(" ");
      expect(all).toContain("Run it again to resume");
      expect(all).toContain("picks up where this one stopped");
      expect(copy.unresolved).toBe(true);
    }
    // POSITIVE CONTROL — the clause is absent when the cap did not bite.
    expect(sweepOutcome({ minted: 7, truncated: false }).clauses.join(" ")).not.toContain(
      "Run it again to resume",
    );
  });
});
