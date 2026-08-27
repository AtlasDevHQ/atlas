/**
 * Tests for the proposal confirm card's outcome state machine (#5482).
 *
 * Mirrors `correct-fact-confirm-card.test.tsx`, because the card mirrors the
 * card it is modelled on — the same four-arm `retrySafe` machine,
 * re-implemented, and a re-implementation that is untested is where the two
 * silently diverge.
 *
 * Two properties are specific to THIS card and are why the file is not a copy:
 *
 *   - ⭐ **It renders the claim.** The correction card deliberately does not
 *     preview its target (ACL-gated storage, a second visibility decision). Here
 *     the claim is the user's own words and its exact wording IS what they are
 *     consenting to, so the card must show all three slots — that is what stops
 *     a confidently wrong agent sentence getting a differently worded claim
 *     confirmed.
 *   - ⭐ **The two success outcomes must not be collapsed.** `proposed` means a
 *     draft waits for a reviewer; `corroborated` means the brain already held
 *     the claim and nothing was queued. Reporting the second as the first is
 *     exactly the confident wrongness the confirm flow exists to remove.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { render, fireEvent, waitFor, screen } from "@testing-library/react";
import type { ReactNode } from "react";

import { ProposeFactConfirmCard } from "../components/chat/propose-fact-confirm-card";
import { AtlasProvider } from "../context";

const stubAuthClient = {
  signIn: { email: async () => ({}) },
  signUp: { email: async () => ({}) },
  signOut: async () => {},
  useSession: () => ({ data: null, isPending: false }),
};

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <AtlasProvider
      config={{ apiUrl: "http://localhost:3001", isCrossOrigin: false, authClient: stubAuthClient }}
    >
      {children}
    </AtlasProvider>
  );
}

/** A completed tool part carrying a staged claim awaiting confirmation. */
function stagedPart(overrides: Record<string, unknown> = {}) {
  return {
    state: "output-available",
    output: {
      status: "needs_confirmation",
      summary: 'propose — record "Ana" · "is the DRI for" · "billing" as a draft for review',
      confirm: {
        subject: "Ana",
        predicate: "is the DRI for",
        object: "billing",
        reason: "Ana said so in standup",
        // Opaque single-use token the card forwards verbatim.
        token: "signed-proposal-confirm-token",
        ...overrides,
      },
    },
  };
}

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

function renderCard(part: unknown = stagedPart()) {
  return render(
    <Wrapper>
      <ProposeFactConfirmCard part={part} />
    </Wrapper>,
  );
}

function clickConfirm() {
  fireEvent.click(screen.getByRole("button", { name: /confirm proposal/i }));
}

describe("ProposeFactConfirmCard — staged banner", () => {
  test("⭐ renders every slot of the claim, not just the summary", () => {
    // The summary line truncates; these are what the human is consenting to.
    renderCard();
    expect(screen.getByText("Ana")).toBeTruthy();
    expect(screen.getByText("is the DRI for")).toBeTruthy();
    expect(screen.getByText("billing")).toBeTruthy();
    expect(screen.getByRole("button", { name: /confirm proposal/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeTruthy();
  });

  test("shows the reason that will be recorded verbatim in the proposal episode", () => {
    renderCard();
    expect(screen.getByText(/Ana said so in standup/)).toBeTruthy();
  });

  test("says nothing has been recorded yet, and that a draft is not an answer", () => {
    renderCard();
    expect(screen.getByText(/Nothing has been recorded\s+yet/i)).toBeTruthy();
    expect(screen.getByText(/waiting for a reviewer to publish it/i)).toBeTruthy();
  });

  test("warns that the draft is workspace-visible", () => {
    // A proposal's episode is granted `org` — the only grant that makes the
    // draft reachable by a reviewer at all — so the card says so before the
    // click rather than leaving it to be discovered.
    renderCard();
    expect(screen.getByText(/visible to your workspace/i)).toBeTruthy();
  });

  test("Cancel records nothing", () => {
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(screen.getByText(/Cancelled — nothing was recorded/)).toBeTruthy();
  });

  test("a non-confirmation result (a degraded path) renders as a compact line", () => {
    renderCard({
      state: "output-available",
      output: { error: "No active workspace is bound to this session.", reason: "no_workspace" },
    });
    expect(screen.getByText(/Proposal not staged/)).toBeTruthy();
    expect(screen.getByText(/No active workspace is bound to this session\./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /confirm proposal/i })).toBeNull();
  });

  test("a result missing a claim slot is refused by the guard, not half-rendered", () => {
    // The guard checks exactly what the card DISPLAYS. A shallower one would let
    // this reach the Confirm button with an empty value where the assertion
    // should be — a human consenting to a claim the card could not show them.
    renderCard({
      state: "output-available",
      output: {
        status: "needs_confirmation",
        summary: "propose — …",
        confirm: { subject: "Ana", predicate: "is the DRI for", token: "t" },
      },
    });
    expect(screen.queryByRole("button", { name: /confirm proposal/i })).toBeNull();
    expect(screen.getByText(/Proposal not staged/)).toBeTruthy();
  });
});

describe("ProposeFactConfirmCard — the recorded state", () => {
  test("POSTs the staged claim verbatim, token included", async () => {
    let seen: { url: string; body: unknown } | null = null;
    global.fetch = (async (url: string, init: RequestInit) => {
      seen = { url: String(url), body: JSON.parse(String(init.body)) as unknown };
      return new Response(
        JSON.stringify({
          outcome: "proposed",
          factId: "fact-1",
          status: "draft",
          proposalEpisodeId: "ep-1",
          provisional: false,
          tensionEdges: 0,
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    renderCard();
    clickConfirm();
    await waitFor(() => expect(seen).not.toBeNull());

    const call = seen as unknown as { url: string; body: Record<string, unknown> };
    expect(call.url).toContain("/api/v1/brain-proposals/confirm");
    expect(call.body.subject).toBe("Ana");
    expect(call.body.token).toBe("signed-proposal-confirm-token");
  });

  test("⭐ a draft outcome says a reviewer must publish it", async () => {
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          outcome: "proposed",
          factId: "fact-1",
          status: "draft",
          proposalEpisodeId: "ep-1",
          provisional: false,
          tensionEdges: 0,
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    renderCard();
    clickConfirm();
    await waitFor(() => expect(screen.getByText("Proposal recorded")).toBeTruthy());
    expect(screen.getByText(/not an answer yet/i)).toBeTruthy();
  });

  test("⭐ a corroboration outcome says so, and does NOT claim a draft was queued", async () => {
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          outcome: "corroborated",
          factId: "fact-existing",
          proposalEpisodeId: "ep-1",
          evidenceAdded: true,
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    renderCard();
    clickConfirm();
    await waitFor(() => expect(screen.getByText("Recorded as evidence")).toBeTruthy());
    expect(screen.getByText(/already held this claim/i)).toBeTruthy();
    expect(screen.queryByText(/waiting for a reviewer/i)).toBeNull();
  });

  test("reports tension edges when the reviewer will see a flagged conflict", async () => {
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          outcome: "proposed",
          factId: "fact-1",
          status: "draft",
          proposalEpisodeId: "ep-1",
          provisional: false,
          tensionEdges: 2,
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    renderCard();
    clickConfirm();
    await waitFor(() => expect(screen.getByText(/in tension with 2 existing claim/i)).toBeTruthy());
  });
});

describe("ProposeFactConfirmCard — the retrySafe machine", () => {
  test("a 4xx offers Try again — the proposal provably did not land", async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ error: "confirm_token_invalid", message: "Expired." }), {
        status: 400,
      })) as unknown as typeof fetch;

    renderCard();
    clickConfirm();
    await waitFor(() => expect(screen.getByText("Expired.")).toBeTruthy());
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
  });

  test("a 5xx withholds Try again and says the claim may have been recorded", async () => {
    // Raised at or after the transaction, so the outcome is genuinely ambiguous
    // and re-confirming could double-record.
    global.fetch = (async () =>
      new Response(JSON.stringify({ error: "internal_error", message: "Boom." }), {
        status: 500,
      })) as unknown as typeof fetch;

    renderCard();
    clickConfirm();
    await waitFor(() => expect(screen.getByText(/may have been recorded/i)).toBeTruthy());
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
  });

  test("a network fault withholds Try again — it can drop after the write committed", async () => {
    global.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    renderCard();
    clickConfirm();
    await waitFor(() => expect(screen.getByText(/could not reach the server/i)).toBeTruthy());
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
  });

  test("an unreadable 2xx body withholds Try again — the write DID run", async () => {
    global.fetch = (async () =>
      new Response("not json", { status: 200 })) as unknown as typeof fetch;

    renderCard();
    clickConfirm();
    await waitFor(() => expect(screen.getByText(/do not re-run it/i)).toBeTruthy());
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
  });

  test("⭐ Try again re-POSTs the SAME spent token and is refused as a replay", async () => {
    // The arm with no counterpart in the REST card. The server burns the nonce
    // on the ATTEMPT, so the button a 4xx offers cannot actually succeed for a
    // token that already reached the endpoint — and the copy has to send the
    // user somewhere that works (re-staging).
    const bodies: unknown[] = [];
    let call = 0;
    global.fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      call += 1;
      return call === 1
        ? new Response(
            JSON.stringify({ error: "proposal_refused", message: "The claim's object asserts nothing." }),
            { status: 400 },
          )
        : new Response(
            JSON.stringify({
              error: "confirm_token_invalid",
              message: "This confirmation was already used. Ask Atlas to stage the proposal again if you need to repeat it.",
            }),
            { status: 400 },
          );
    }) as unknown as typeof fetch;

    renderCard();
    clickConfirm();
    await waitFor(() => expect(screen.getByText(/asserts nothing/i)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    clickConfirm();
    await waitFor(() => expect(screen.getByText(/already used/i)).toBeTruthy());

    // Same token both times — the card never re-stages on its own.
    expect(bodies).toHaveLength(2);
    expect((bodies[0] as Record<string, unknown>).token).toBe(
      (bodies[1] as Record<string, unknown>).token,
    );
    // …and the copy points at the path that actually works.
    expect(screen.getByText(/stage the proposal again/i)).toBeTruthy();
  });
});
