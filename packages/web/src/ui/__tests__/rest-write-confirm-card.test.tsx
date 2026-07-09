/**
 * Tests for the REST confirm-before-write card's outcome state machine
 * (#2868 slice 5, #2929 review). The load-bearing property: the re-arming
 * "Try again" button appears ONLY when the write provably did NOT fire (a 4xx
 * server rejection). For any ambiguous outcome — a 5xx, or a network fault that
 * could have dropped after the write dispatched — the card surfaces
 * "check before retrying" copy and withholds the button, so a non-idempotent
 * DELETE/POST can't be trivially double-fired.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { render, fireEvent, waitFor, screen } from "@testing-library/react";
import type { ReactNode } from "react";

import { RestWriteConfirmCard } from "../components/chat/rest-write-confirm-card";
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

/** A completed tool part carrying a staged allowlisted DELETE awaiting confirmation. */
function stagedDeletePart() {
  return {
    state: "output-available",
    output: {
      status: "needs_confirmation",
      method: "DELETE",
      operationId: "deleteOnePerson",
      datasourceId: "twenty",
      datasourceName: "Twenty",
      summary: "Delete a person — DELETE /people/{id} on Twenty",
      confirm: {
        datasourceId: "twenty",
        operationId: "deleteOnePerson",
        pathParams: { id: "p-1" },
        token: "signed-confirm-token", // #3007: opaque single-use token the banner forwards verbatim
      },
    },
  };
}

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

function renderCard() {
  return render(
    <Wrapper>
      <RestWriteConfirmCard part={stagedDeletePart()} />
    </Wrapper>,
  );
}

function clickConfirm() {
  fireEvent.click(screen.getByRole("button", { name: /confirm write/i }));
}

describe("RestWriteConfirmCard — staged banner", () => {
  test("renders the staged write (method + summary) with Confirm/Cancel", () => {
    renderCard();
    expect(screen.getByText("DELETE")).toBeTruthy();
    expect(screen.getByText(/Delete a person/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /confirm write/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeTruthy();
  });

  test("Cancel leaves the write un-run", () => {
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(screen.getByText(/Cancelled — the write was not run/)).toBeTruthy();
  });
});

describe("RestWriteConfirmCard — retrySafe gating on confirm outcome", () => {
  test("a 4xx rejection (write provably did NOT fire) offers a re-arming Try again", async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ error: "writes_disabled", message: "Writes are disabled." }), {
        status: 403,
      })) as unknown as typeof fetch;
    renderCard();
    clickConfirm();
    await waitFor(() => expect(screen.getByText(/Writes are disabled\./)).toBeTruthy());
    // 4xx ⇒ safe to retry ⇒ the button is present.
    expect(screen.queryByRole("button", { name: /try again/i })).not.toBeNull();
    // …and it does NOT carry the ambiguous "may have completed" warning.
    expect(screen.queryByText(/may have completed/)).toBeNull();
  });

  test("a 5xx (write may have fired) withholds Try again and warns to check the datasource", async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ error: "internal_error", message: "Failed to execute the write." }), {
        status: 500,
      })) as unknown as typeof fetch;
    renderCard();
    clickConfirm();
    await waitFor(() => expect(screen.getByText(/may have completed/)).toBeTruthy());
    expect(screen.getByText(/Check Twenty before retrying/)).toBeTruthy();
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
    expect(screen.getByText(/may have completed/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
  });

  test("a 2xx whose body can't be read reports the write ran and withholds Try again", async () => {
    global.fetch = (async () =>
      new Response("<<not json>>", { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
    renderCard();
    clickConfirm();
    await waitFor(() => expect(screen.getByText(/The write completed/)).toBeTruthy());
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
  });
});
