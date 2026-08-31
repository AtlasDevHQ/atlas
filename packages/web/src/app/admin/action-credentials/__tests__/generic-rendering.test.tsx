import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AtlasProvider, type AtlasAuthClient } from "@/ui/context";
import ActionCredentialsPage from "../page";

/**
 * The genericity guard for #5553.
 *
 * The acceptance criterion is "the form generated from the field specs, no
 * per-target UI branches". The way to test that is not to read the source for
 * an `if (target === "jira")` — it is to serve the page a target that did not
 * exist when the page was written and assert it renders completely: label,
 * every field, the required/optional split, the secret masking, the save
 * payload. A page with a per-target branch renders a synthetic target as an
 * empty card and fails here.
 *
 * Nothing in this file mentions the pilot target for the same reason.
 */

const stubAuthClient: AtlasAuthClient = {
  signIn: { email: async () => ({}) },
  signUp: { email: async () => ({}) },
  signOut: async () => {},
  useSession: () => ({ data: null, isPending: false }),
};

let testQueryClient: QueryClient;

function Wrapper({ children }: { children: ReactNode }) {
  return createElement(
    QueryClientProvider,
    { client: testQueryClient },
    createElement(AtlasProvider, {
      config: {
        apiUrl: "http://localhost:3001",
        isCrossOrigin: false as const,
        authClient: stubAuthClient,
      },
      children,
    }),
  );
}

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A target the page has never seen, with one of every field shape. */
const SYNTHETIC_TARGET = {
  target: "widgetron",
  label: "Widgetron",
  state: "unconfigured",
  fields: [
    {
      envVar: "WIDGETRON_URL",
      label: "Base URL",
      hint: "Your Widgetron site URL.",
      secret: false,
      required: true,
      multiline: false,
      present: false,
      source: "unset",
      stored: false,
    },
    {
      envVar: "WIDGETRON_TOKEN",
      label: "API Token",
      hint: "Widgetron API token.",
      secret: true,
      required: true,
      multiline: false,
      present: false,
      source: "unset",
      stored: false,
    },
    {
      envVar: "WIDGETRON_PROJECT",
      label: "Default Project",
      hint: "Used when the agent names none.",
      secret: false,
      required: false,
      multiline: false,
      present: false,
      source: "unset",
      stored: false,
    },
    // The #5555 shape: a PEM-form secret. `multiline: true` is what tells the
    // form to render a textarea instead of a single-line password input.
    {
      envVar: "WIDGETRON_SIGNING_KEY",
      label: "Signing Key",
      hint: "PEM private key for Widgetron webhooks.",
      secret: true,
      required: false,
      multiline: true,
      present: false,
      source: "unset",
      stored: false,
    },
  ],
};

const CONFIGURED_TARGET = {
  ...SYNTHETIC_TARGET,
  state: "workspace",
  fields: SYNTHETIC_TARGET.fields.map((f, i) =>
    i < 2 ? { ...f, present: true, source: "workspace", stored: true } : f,
  ),
};

const ENV_TARGET = {
  ...SYNTHETIC_TARGET,
  state: "env",
  fields: SYNTHETIC_TARGET.fields.map((f, i) =>
    i < 2 ? { ...f, present: true, source: "env" } : f,
  ),
};

/**
 * A stored row missing one required field (#5564). Nothing resolves, so every
 * field reports `source: "unset"` — `stored` is the only thing left saying the
 * row holds the base URL.
 */
const PARTIAL_TARGET = {
  ...SYNTHETIC_TARGET,
  state: "partial-row-shadowing-env",
  fields: SYNTHETIC_TARGET.fields.map((f, i) => (i === 0 ? { ...f, stored: true } : f)),
};

interface Written {
  method: string;
  url: string;
  body: unknown;
}

/**
 * Serve the given list response; record every write. Returns the recorder so
 * a test can assert on the exact payload the page sent.
 */
function mockApi(list: unknown): Written[] {
  const writes: Written[] = [];
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    if (method === "GET") return Promise.resolve(jsonResponse(list));
    writes.push({
      method,
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    // Every write returns the single-target status shape the route documents.
    return Promise.resolve(jsonResponse(CONFIGURED_TARGET));
  }) as unknown as typeof fetch;
  return writes;
}

function input(envVar: string): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>(`input#cred-widgetron\\:${envVar}`);
  expect(el).not.toBeNull();
  return el!;
}

/** The field's editable control, whatever the spec made it — input or textarea. */
function control(envVar: string): HTMLInputElement | HTMLTextAreaElement {
  const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `#cred-widgetron\\:${envVar}`,
  );
  expect(el).not.toBeNull();
  return el!;
}

function findButton(label: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label,
  );
  expect(button).toBeDefined();
  return button as HTMLButtonElement;
}

describe("/admin/action-credentials renders any ACTION_TARGETS entry (#5553)", () => {
  beforeEach(() => {
    testQueryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
  });

  afterEach(() => {
    testQueryClient.clear();
    cleanup();
    globalThis.fetch = originalFetch;
  });

  test("a target the page has never seen renders its label, every field and every hint", async () => {
    mockApi({ deployMode: "saas", targets: [SYNTHETIC_TARGET] });

    render(<ActionCredentialsPage />, { wrapper: Wrapper });

    await waitFor(() => {
      if (!document.body.textContent?.includes("Widgetron")) throw new Error("not rendered yet");
    });
    const text = document.body.textContent ?? "";
    for (const f of SYNTHETIC_TARGET.fields) {
      expect(text).toContain(f.label);
      expect(text).toContain(f.hint);
      // The env-var name is shown so a self-host operator can map the field to
      // the variable that answers for it.
      expect(text).toContain(f.envVar);
      expect(control(f.envVar)).not.toBeNull();
    }
  });

  test("a multiline field renders a textarea; its single-line siblings stay inputs (#5555)", async () => {
    mockApi({ deployMode: "saas", targets: [SYNTHETIC_TARGET] });

    render(<ActionCredentialsPage />, { wrapper: Wrapper });

    await waitFor(() => control("WIDGETRON_SIGNING_KEY"));
    expect(control("WIDGETRON_SIGNING_KEY").tagName).toBe("TEXTAREA");
    // The attribute is per-field, not per-target: the flat secret next to it
    // keeps the masked single-line input.
    expect(control("WIDGETRON_TOKEN").tagName).toBe("INPUT");
    expect(input("WIDGETRON_TOKEN").type).toBe("password");
    // Write-only holds for the textarea too — nothing prefilled.
    expect(control("WIDGETRON_SIGNING_KEY").value).toBe("");
  });

  test("a pasted multi-line value reaches the PUT payload with its inner newlines intact", async () => {
    // CONFIGURED_TARGET, not the unconfigured one: this fills only the optional
    // signing key, and Save is gated on the target's REQUIRED fields being
    // answerable (#5564) — on an unconfigured target it would rightly stay
    // disabled, which is a different test than this one.
    const writes = mockApi({ deployMode: "saas", targets: [CONFIGURED_TARGET] });
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----";

    render(<ActionCredentialsPage />, { wrapper: Wrapper });

    await waitFor(() => control("WIDGETRON_SIGNING_KEY"));
    await act(async () => {
      fireEvent.change(control("WIDGETRON_SIGNING_KEY"), { target: { value: `${pem}\n` } });
    });
    await act(async () => {
      fireEvent.click(findButton("Save"));
    });

    await waitFor(() => {
      if (writes.length === 0) throw new Error("no write yet");
    });
    // Inner newlines survive; only the edges are trimmed (the PUT contract
    // trims what it sends, which for a PEM is the trailing newline).
    expect(writes[0]!.body).toEqual({ fields: { WIDGETRON_SIGNING_KEY: pem } });
  });

  test("secret fields are masked and start empty; non-secret fields start empty too", async () => {
    mockApi({ deployMode: "saas", targets: [CONFIGURED_TARGET] });

    render(<ActionCredentialsPage />, { wrapper: Wrapper });

    await waitFor(() => input("WIDGETRON_TOKEN"));
    expect(input("WIDGETRON_TOKEN").type).toBe("password");
    expect(input("WIDGETRON_TOKEN").value).toBe("");
    // The read is masked status-only for EVERY field, so nothing is prefilled.
    expect(input("WIDGETRON_URL").value).toBe("");
  });

  test("Save is disabled until something is typed, then sends only the typed field", async () => {
    const writes = mockApi({ deployMode: "saas", targets: [CONFIGURED_TARGET] });

    render(<ActionCredentialsPage />, { wrapper: Wrapper });

    await waitFor(() => findButton("Save"));
    expect(findButton("Save").disabled).toBe(true);

    await act(async () => {
      fireEvent.change(input("WIDGETRON_URL"), { target: { value: "https://widgets.acme.dev" } });
    });
    expect(findButton("Save").disabled).toBe(false);

    await act(async () => {
      fireEvent.click(findButton("Save"));
    });

    await waitFor(() => {
      if (writes.length === 0) throw new Error("no write yet");
    });
    expect(writes[0]!.method).toBe("PUT");
    expect(writes[0]!.url).toContain("/api/v1/admin/action-credentials/widgetron");
    // The untouched secret is absent from the payload — the PUT contract's
    // "blank preserves the stored secret" is what keeps it stored.
    expect(writes[0]!.body).toEqual({ fields: { WIDGETRON_URL: "https://widgets.acme.dev" } });
  });

  test("marking a field for removal sends clearFields and disables its input", async () => {
    const writes = mockApi({ deployMode: "saas", targets: [CONFIGURED_TARGET] });

    render(<ActionCredentialsPage />, { wrapper: Wrapper });

    await waitFor(() => input("WIDGETRON_PROJECT"));
    const checkbox = document.querySelector<HTMLElement>(
      "#clear-widgetron\\:WIDGETRON_PROJECT",
    );
    expect(checkbox).not.toBeNull();

    await act(async () => {
      fireEvent.click(checkbox!);
    });
    expect(input("WIDGETRON_PROJECT").disabled).toBe(true);

    await act(async () => {
      fireEvent.click(findButton("Save"));
    });

    await waitFor(() => {
      if (writes.length === 0) throw new Error("no write yet");
    });
    expect(writes[0]!.body).toEqual({ fields: {}, clearFields: ["WIDGETRON_PROJECT"] });
  });

  test("removing a target's credentials confirms first, then sends DELETE", async () => {
    const writes = mockApi({ deployMode: "saas", targets: [CONFIGURED_TARGET] });

    render(<ActionCredentialsPage />, { wrapper: Wrapper });

    await waitFor(() => findButton("Remove"));
    await act(async () => {
      fireEvent.click(findButton("Remove"));
    });

    // The dialog is the gate — nothing is sent on the first click.
    expect(writes).toHaveLength(0);
    await waitFor(() => {
      if (!document.body.textContent?.includes("Remove Widgetron credentials?")) {
        throw new Error("confirm dialog not open");
      }
    });

    const confirm = Array.from(document.querySelectorAll("button")).filter(
      (b) => b.textContent?.trim() === "Remove",
    );
    await act(async () => {
      fireEvent.click(confirm[confirm.length - 1]!);
    });

    await waitFor(() => {
      if (writes.length === 0) throw new Error("no write yet");
    });
    expect(writes[0]!.method).toBe("DELETE");
    expect(writes[0]!.url).toContain("/api/v1/admin/action-credentials/widgetron");
  });

  test("an env-resolved target names the environment rung on self-hosted", async () => {
    mockApi({ deployMode: "self-hosted", targets: [ENV_TARGET] });

    render(<ActionCredentialsPage />, { wrapper: Wrapper });

    await waitFor(() => {
      if (!document.body.textContent?.includes("From environment")) {
        throw new Error("env status not rendered yet");
      }
    });
    expect(document.body.textContent).toContain("environment");
    // `state: "env"` is reached only when no workspace row exists at all, so
    // this is the one resolving state with nothing to remove.
    expect(
      Array.from(document.querySelectorAll("button")).some((b) => b.textContent?.trim() === "Remove"),
    ).toBe(false);
  });

  test("an UNCONFIGURED target offers no Remove — the state says outright there is no row", async () => {
    // `mayHaveStoredRow` answered `true` here, because the old response could
    // not tell "no row" from "partial row" and had to offer removal on the
    // "might". The discriminant answers it, so the page stops offering a
    // destructive action that would do nothing (#5564).
    mockApi({ deployMode: "self-hosted", targets: [SYNTHETIC_TARGET] });

    render(<ActionCredentialsPage />, { wrapper: Wrapper });

    await waitFor(() => input("WIDGETRON_URL"));
    expect(
      Array.from(document.querySelectorAll("button")).some((b) => b.textContent?.trim() === "Remove"),
    ).toBe(false);
  });

  test("a PARTIAL row names its own state, offers Remove, and does not ask for what it already holds", async () => {
    // The state the discriminant exists for. Under the old shape this rendered
    // as "Not configured" with all four fields listed as missing — including
    // the base URL the row holds and the admin cannot read back.
    mockApi({ deployMode: "self-hosted", targets: [PARTIAL_TARGET] });

    render(<ActionCredentialsPage />, { wrapper: Wrapper });

    await waitFor(() => findButton("Remove"));
    const text = document.body.textContent ?? "";
    expect(text).toContain("Incomplete");
    // Removal is the escape hatch from a row that is shadowing a working env.
    expect(findButton("Remove").disabled).toBe(false);
    // The stored field is not in the "still needed" list, and its own control
    // says the value survives a blank submit.
    expect(text).toContain("Still needed: API Token");
    expect(input("WIDGETRON_URL").placeholder).toContain("leave blank to keep");
  });

  test("completing a partial row enables Save — one typed field, not four", async () => {
    // The trap the `stored` signal removes: the warning gates Save, so a
    // predicate that called a stored field unsatisfied would disable the very
    // button that repairs the row.
    mockApi({ deployMode: "self-hosted", targets: [PARTIAL_TARGET] });

    render(<ActionCredentialsPage />, { wrapper: Wrapper });

    await waitFor(() => input("WIDGETRON_TOKEN"));
    await act(async () => {
      fireEvent.change(input("WIDGETRON_TOKEN"), { target: { value: "tok_abc" } });
    });

    expect(findButton("Save").disabled).toBe(false);
  });

  test("saving a partial entry warns AND blocks the save that would break a working env fallback", async () => {
    mockApi({ deployMode: "self-hosted", targets: [ENV_TARGET] });

    render(<ActionCredentialsPage />, { wrapper: Wrapper });

    await waitFor(() => input("WIDGETRON_URL"));
    // An env-resolved target has NOTHING stored, so filling one required field
    // and saving creates a row that is missing the other — which stops the
    // environment fallback rather than topping it up. The API returns 400 for
    // exactly this, so the button holds rather than spending a round trip.
    await act(async () => {
      fireEvent.change(input("WIDGETRON_URL"), { target: { value: "https://widgets.acme.dev" } });
    });

    const text = document.body.textContent ?? "";
    expect(text).toContain("API Token");
    expect(text).toContain("all-or-nothing");
    // Named the remaining field, not the one just filled in.
    expect(text).not.toContain("leaves Base URL unset");
    expect(findButton("Save").disabled).toBe(true);
  });

  test("an env-sourced field is never told that leaving it blank keeps it working", async () => {
    // It only keeps working while nothing is saved for the workspace; the
    // moment a sibling field is saved it stops. See `fieldPlaceholder`.
    mockApi({ deployMode: "self-hosted", targets: [ENV_TARGET] });

    render(<ActionCredentialsPage />, { wrapper: Wrapper });

    await waitFor(() => input("WIDGETRON_URL"));
    expect(input("WIDGETRON_URL").placeholder).not.toContain("leave blank");
    expect(input("WIDGETRON_URL").placeholder).toContain("environment");
  });

  test("the self-hosted fallback note is absent on SaaS, where that rung does not exist", async () => {
    mockApi({ deployMode: "saas", targets: [SYNTHETIC_TARGET] });

    render(<ActionCredentialsPage />, { wrapper: Wrapper });

    await waitFor(() => {
      if (!document.body.textContent?.includes("Widgetron")) throw new Error("not rendered yet");
    });
    expect(document.body.textContent).not.toContain("self-hosted deployment");
  });

  test("two targets each get their own form and their own save", async () => {
    const second = { ...SYNTHETIC_TARGET, target: "gadgetco", label: "GadgetCo" };
    mockApi({ deployMode: "saas", targets: [SYNTHETIC_TARGET, second] });

    render(<ActionCredentialsPage />, { wrapper: Wrapper });

    await waitFor(() => {
      if (!document.body.textContent?.includes("GadgetCo")) throw new Error("not rendered yet");
    });
    // Field ids are target-scoped, so two targets sharing an env-var name
    // still edit independently.
    expect(document.querySelector("input#cred-widgetron\\:WIDGETRON_URL")).not.toBeNull();
    expect(document.querySelector("input#cred-gadgetco\\:WIDGETRON_URL")).not.toBeNull();
    expect(
      Array.from(document.querySelectorAll("button")).filter((b) => b.textContent?.trim() === "Save"),
    ).toHaveLength(2);
  });
});
