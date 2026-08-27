/**
 * Tests for the correction confirm card's outcome state machine (#5496).
 *
 * Mirrors `rest-write-confirm-card.test.tsx`, because the card mirrors the card
 * it is modelled on — the same four-arm `retrySafe` machine, re-implemented, and
 * a re-implementation that is untested is where the two silently diverge.
 *
 * The load-bearing property is the same: the re-arming "Try again" button
 * appears ONLY when the correction provably did NOT land (a 4xx server
 * rejection). For any ambiguous outcome — a 5xx, or a network fault that could
 * have dropped after the transaction committed — the card withholds the button
 * and says to check the fact, so a correction can't be trivially double-applied.
 *
 * ⚠️ One arm has NO counterpart in the REST card and is the reason this file
 * matters most: the confirm token is single-use and the server burns the nonce
 * on the ATTEMPT, not on success. So "Try again" re-POSTs a spent token and is
 * refused as a replay. That is deliberate — spending the nonce on the attempt is
 * what stops one confirmation being fired against many states — but it means the
 * button a 4xx offers cannot actually succeed, and the copy has to send the user
 * somewhere that works. The last test walks exactly that path.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { render, fireEvent, waitFor, screen } from "@testing-library/react";
import type { ReactNode } from "react";

import { CorrectFactConfirmCard } from "../components/chat/correct-fact-confirm-card";
import { AtlasProvider } from "../context";

const stubAuthClient = {
  signIn: { email: async () => ({}) },
  signUp: { email: async () => ({}) },
  signOut: async () => {},
  useSession: () => ({ data: null, isPending: false }),
};

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <AtlasProvider config={{ apiUrl: "http://localhost:3001", isCrossOrigin: false, authClient: stubAuthClient }}>
      {children}
    </AtlasProvider>
  );
}

/** A completed tool part carrying a staged retract awaiting confirmation. */
function stagedRetractPart() {
  return {
    state: "output-available",
    output: {
      status: "needs_confirmation",
      factId: "6f2c0000-0000-4000-8000-000000000000",
      verb: "retract",
      summary:
        "retract — withdraw this claim (facts derived from it are flagged for human re-review, never removed)",
      confirm: {
        factId: "6f2c0000-0000-4000-8000-000000000000",
        verb: "retract",
        reason: "Ana left the team",
        // Opaque single-use token the card forwards verbatim.
        token: "signed-correction-confirm-token",
      },
    },
  };
}

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

function renderCard(part: unknown = stagedRetractPart()) {
  return render(
    <Wrapper>
      <CorrectFactConfirmCard part={part} />
    </Wrapper>,
  );
}

function clickConfirm() {
  fireEvent.click(screen.getByRole("button", { name: /confirm correction/i }));
}

describe("CorrectFactConfirmCard — staged banner", () => {
  test("renders the staged correction (verb + summary) with Confirm/Cancel", () => {
    renderCard();
    expect(screen.getByText("retract")).toBeTruthy();
    expect(screen.getByText(/withdraw this claim/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /confirm correction/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeTruthy();
  });

  test("shows the reason that will be recorded verbatim in the correction episode", () => {
    // The human is consenting to a specific rationale being written into an
    // immutable episode under their name — so it has to be on the card.
    renderCard();
    expect(screen.getByText(/Ana left the team/)).toBeTruthy();
  });

  test("says the correction has NOT been applied yet", () => {
    // The whole point of #5496. A card that reads as a receipt rather than a
    // request is the pre-#5496 behaviour wearing new paint.
    renderCard();
    expect(screen.getByText(/has not\s+been applied yet/i)).toBeTruthy();
  });

  test("Cancel leaves the fact unchanged", () => {
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(screen.getByText(/Cancelled — the fact was not changed/)).toBeTruthy();
  });

  test("a non-confirmation result (a refusal) renders as a compact line, not a banner", () => {
    // The tool's degraded paths — no workspace, unresolved actor, an authority
    // refusal — come back as `{ error, reason }`. There is nothing to confirm.
    renderCard({
      state: "output-available",
      output: { error: "Corrections are an admin verb.", reason: "correction_refused" },
    });
    expect(screen.getByText(/Correction not staged/)).toBeTruthy();
    expect(screen.getByText(/Corrections are an admin verb\./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /confirm correction/i })).toBeNull();
  });
});

describe("CorrectFactConfirmCard — the applied state", () => {
  test("reports a retract's flagged dependents as a count, and says no queue lists them", async () => {
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          status: "corrected",
          verb: "retract",
          factId: "6f2c0000-0000-4000-8000-000000000000",
          correctionEpisodeId: "ep-1",
          invalidatedAt: "2026-08-27T12:00:00.000Z",
          supersededBy: null,
          validTo: null,
          flaggedForReReviewCount: 2,
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    renderCard();
    clickConfirm();

    await waitFor(() => expect(screen.getByText(/Correction applied/)).toBeTruthy());
    expect(screen.getByText(/2 derived fact\(s\)/)).toBeTruthy();
    // `MERGE_PROVENANCE_MARKER_SQL`'s rule, on the surface that renders it: say
    // what is RECORDED, never imply a place to go and work through it.
    expect(screen.getByText(/no queue lists them/)).toBeTruthy();
  });
});

describe("CorrectFactConfirmCard — retrySafe gating on confirm outcome", () => {
  test("a 4xx rejection (correction provably did NOT land) offers a re-arming Try again", async () => {
    global.fetch = (async () =>
      new Response(
        JSON.stringify({ error: "correction_refused", message: "Tier-1 has no correction path." }),
        { status: 409 },
      )) as unknown as typeof fetch;
    renderCard();
    clickConfirm();

    await waitFor(() => expect(screen.getByText(/Tier-1 has no correction path\./)).toBeTruthy());
    expect(screen.queryByRole("button", { name: /try again/i })).not.toBeNull();
    // …and it does NOT carry the ambiguous "may have been applied" warning.
    expect(screen.queryByText(/may have been applied/)).toBeNull();
  });

  test("a 5xx (correction may have landed) withholds Try again and says to check the fact", async () => {
    global.fetch = (async () =>
      new Response(
        JSON.stringify({ error: "internal_error", message: "The correction failed." }),
        { status: 500 },
      )) as unknown as typeof fetch;
    renderCard();
    clickConfirm();

    await waitFor(() => expect(screen.getByText(/may have been applied/)).toBeTruthy());
    expect(screen.getByText(/Ask Atlas to check the fact/)).toBeTruthy();
    // Ambiguous outcome ⇒ NO re-arming button (would risk a duplicate write).
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
  });

  test("a network fault (fetch threw) withholds Try again — the outcome is ambiguous", async () => {
    global.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    renderCard();
    clickConfirm();

    await waitFor(() => expect(screen.getByText(/Network error/)).toBeTruthy());
    expect(screen.getByText(/may have been applied/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
  });

  test("a 2xx whose body can't be read reports the correction ran and withholds Try again", async () => {
    global.fetch = (async () =>
      new Response("<<not json>>", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    renderCard();
    clickConfirm();

    await waitFor(() => expect(screen.getByText(/The correction was applied/)).toBeTruthy());
    expect(screen.getByText(/do not re-run it/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
  });

  // ⚠️ The arm with no REST counterpart. The nonce is burned on the ATTEMPT, so
  // the token a 4xx leaves behind is already spent: pressing the button the card
  // just offered produces a replay rejection. This asserts the honest end state
  // — the user is told to have Atlas stage it again, which always works — rather
  // than leaving them pressing a button that cannot succeed.
  test("Try again re-POSTs a BURNED token and lands on re-stage guidance", async () => {
    let call = 0;
    global.fetch = (async () => {
      call += 1;
      return call === 1
        ? new Response(
            JSON.stringify({ error: "correction_refused", message: "Tier-1 has no correction path." }),
            { status: 409 },
          )
        : new Response(
            JSON.stringify({
              error: "confirm_token_invalid",
              message:
                "This confirmation was already used. Ask Atlas to stage the correction again if you need to repeat it.",
            }),
            { status: 400 },
          );
    }) as unknown as typeof fetch;

    renderCard();
    clickConfirm();
    await waitFor(() => expect(screen.getByText(/Tier-1 has no correction path\./)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    clickConfirm();

    await waitFor(() => expect(screen.getByText(/already used/)).toBeTruthy());
    expect(
      screen.getByText(/stage the correction again/),
      "the replay rejection must point at re-staging — the only path that can actually succeed once the nonce is spent",
    ).toBeTruthy();
    expect(call).toBe(2);
  });
});
