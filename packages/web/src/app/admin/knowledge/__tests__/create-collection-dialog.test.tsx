import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import type { IntegrationsCatalogEntry } from "@/ui/lib/admin-schemas";

/**
 * Pins the data-driven create flow (#4619): the "New collection" picker lists
 * EVERY `?pillar=knowledge` catalog row as a tile, and each connector's install
 * form is rendered from its `config_schema` and posts to
 * `POST /api/v1/integrations/:slug/install-form` with `__install_id__` + the
 * collected fields. A dropped connector, a typo'd field key, or a wrong slug
 * would otherwise 400 in production with zero test failures. Edit mode (the
 * bundle-sync in-place rotation) is unchanged from before #4619.
 */

void mock.module("@/lib/api-url", () => ({ getApiUrl: () => "" }));

// --- Catalog fixture served by the mocked useAdminFetch ---------------------

function entry(
  slug: string,
  name: string,
  configSchema: unknown,
  description = "A review-gated knowledge collection.",
): IntegrationsCatalogEntry {
  return {
    id: `catalog:${slug}`,
    slug,
    name,
    description,
    type: "context",
    installModel: "form",
    iconUrl: null,
    minPlan: "starter",
    configSchema,
    installed: false,
    installedAt: null,
    installedBy: null,
    installStatus: null,
    upsellOnly: false,
    pillar: "knowledge",
    implementationStatus: "available",
    installConfig: null,
    formInstallable: true,
    access: { kind: "accessible" },
  };
}

const DESCRIPTION_FIELD = { key: "description", type: "string", label: "Description" };
const UPLOAD_SCHEMA = [DESCRIPTION_FIELD];
const BUNDLE_SYNC_SCHEMA = [
  { key: "endpoint_url", type: "string", label: "Endpoint URL", required: true },
  {
    key: "auth_scheme",
    type: "select",
    label: "Authentication",
    default: "none",
    options: [
      { value: "none", label: "None (public endpoint)" },
      { value: "bearer", label: "Bearer token" },
      { value: "basic", label: "Basic (user:password)" },
    ],
  },
  {
    key: "auth_secret",
    type: "string",
    secret: true,
    label: "Auth secret",
    showWhen: { field: "auth_scheme", equals: ["bearer", "basic"] },
  },
  DESCRIPTION_FIELD,
];
const NOTION_SCHEMA = [
  {
    key: "integration_token",
    type: "string",
    secret: true,
    label: "Internal-integration token",
    required: true,
  },
  DESCRIPTION_FIELD,
];
const CONFLUENCE_SCHEMA = [
  { key: "base_url", type: "string", label: "Confluence site URL", required: true },
  { key: "email", type: "string", label: "Atlassian account email", required: true },
  { key: "space_key", type: "string", label: "Space key", required: true },
  { key: "api_token", type: "string", secret: true, label: "API token", required: true },
  DESCRIPTION_FIELD,
];
const TOKEN_SCHEMA = [
  { key: "api_token", type: "string", secret: true, label: "API token", required: true },
  DESCRIPTION_FIELD,
];

/** All 12 knowledge sources — mirrors BUILTIN_KNOWLEDGE_CATALOG_ROWS. */
const ALL_SLUGS = [
  "okf-upload",
  "bundle-sync",
  "notion-knowledge",
  "confluence",
  "confluence-datacenter",
  "gitbook",
  "zendesk",
  "salesforce-knowledge",
  "intercom",
  "front",
  "helpscout",
  "freshdesk",
] as const;

const KNOWLEDGE_CATALOG = {
  catalog: [
    entry("okf-upload", "Knowledge Base (Upload)", UPLOAD_SCHEMA),
    entry("bundle-sync", "Knowledge Base (Bundle Sync)", BUNDLE_SYNC_SCHEMA),
    entry("notion-knowledge", "Knowledge Base (Notion)", NOTION_SCHEMA),
    entry("confluence", "Knowledge Base (Confluence Cloud)", CONFLUENCE_SCHEMA),
    entry("confluence-datacenter", "Knowledge Base (Confluence Data Center)", TOKEN_SCHEMA),
    entry("gitbook", "Knowledge Base (GitBook)", TOKEN_SCHEMA),
    entry("zendesk", "Knowledge Base (Zendesk Guide)", TOKEN_SCHEMA),
    entry("salesforce-knowledge", "Knowledge Base (Salesforce Knowledge)", UPLOAD_SCHEMA),
    entry("intercom", "Knowledge Base (Intercom)", TOKEN_SCHEMA),
    entry("front", "Knowledge Base (Front)", TOKEN_SCHEMA),
    entry("helpscout", "Knowledge Base (Help Scout Docs)", TOKEN_SCHEMA),
    entry("freshdesk", "Knowledge Base (Freshdesk Solutions)", TOKEN_SCHEMA),
  ],
};

let catalogData: { catalog: IntegrationsCatalogEntry[] } | null = KNOWLEDGE_CATALOG;
let catalogLoading = false;
let catalogError: unknown = null;

void mock.module("@/ui/hooks/use-admin-fetch", () => ({
  useAdminFetch: () => ({
    data: catalogData,
    loading: catalogLoading,
    error: catalogError,
    setError: () => {},
    refetch: () => {},
  }),
  useInProgressSet: () => ({ has: () => false, start: () => {}, stop: () => {} }),
  friendlyError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

const CreateCollectionDialog = (await import("../create-collection-dialog")).CreateCollectionDialog;

let fetchCalls: { url: string; body: Record<string, unknown> }[] = [];
const realFetch = globalThis.fetch;

function stubFetch() {
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    fetchCalls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  fetchCalls = [];
  catalogData = KNOWLEDGE_CATALOG;
  catalogLoading = false;
  catalogError = null;
  stubFetch();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  cleanup();
});

function renderDialog(onCreated = mock(() => {}), existingSlugs: string[] = ["taken"]) {
  render(
    <CreateCollectionDialog open onOpenChange={() => {}} onCreated={onCreated} existingSlugs={existingSlugs} />,
  );
  return onCreated;
}

/** Pick a connector tile, then wait for its install form to mount. */
async function pick(slug: string) {
  fireEvent.click(screen.getByTestId(`connector-${slug}`));
  await screen.findByTestId("create-collection-submit");
}

const setField = (label: RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

/** Secret fields render as a wrapped `<input type="password">` (no label id),
 *  so reach them by type. `nth` disambiguates a form with multiple secrets. */
function setSecret(value: string, nth = 0) {
  const inputs = document.querySelectorAll('input[type="password"]');
  fireEvent.change(inputs[nth]!, { target: { value } });
}

const submit = () => fireEvent.click(screen.getByTestId("create-collection-submit"));

describe("CreateCollectionDialog — data-driven picker (#4619)", () => {
  test("lists all 12 knowledge sources as selectable tiles", () => {
    renderDialog();
    for (const slug of ALL_SLUGS) {
      expect(screen.getByTestId(`connector-${slug}`)).toBeTruthy();
    }
  });

  test("upload source posts just the collection id to okf-upload/install-form", async () => {
    const onCreated = renderDialog();
    await pick("okf-upload");
    setField(/Collection id/i, "runbooks");
    submit();

    await waitFor(() => expect(fetchCalls).toHaveLength(1));
    expect(fetchCalls[0].url).toContain("/api/v1/integrations/okf-upload/install-form");
    expect(fetchCalls[0].body).toEqual({ __install_id__: "runbooks" });
    expect(onCreated).toHaveBeenCalledWith("runbooks", "upload");
  });

  test("endpoint source posts endpoint_url + default auth_scheme (no stray secret)", async () => {
    const onCreated = renderDialog();
    await pick("bundle-sync");
    setField(/Collection id/i, "synced-docs");
    setField(/Endpoint URL/i, "https://kb.example.com/bundle.tar.gz");
    submit();

    await waitFor(() => expect(fetchCalls).toHaveLength(1));
    expect(fetchCalls[0].url).toContain("/api/v1/integrations/bundle-sync/install-form");
    expect(fetchCalls[0].body).toEqual({
      __install_id__: "synced-docs",
      endpoint_url: "https://kb.example.com/bundle.tar.gz",
      auth_scheme: "none",
    });
    expect(onCreated).toHaveBeenCalledWith("synced-docs", "bundle-sync");
  });

  test("notion source posts integration_token to notion-knowledge/install-form", async () => {
    const onCreated = renderDialog();
    await pick("notion-knowledge");
    setField(/Collection id/i, "wiki");
    setSecret("ntn_secret-token");
    submit();

    await waitFor(() => expect(fetchCalls).toHaveLength(1));
    expect(fetchCalls[0].url).toContain("/api/v1/integrations/notion-knowledge/install-form");
    expect(fetchCalls[0].body).toEqual({
      __install_id__: "wiki",
      integration_token: "ntn_secret-token",
    });
    expect(onCreated).toHaveBeenCalledWith("wiki", "notion");
  });

  test("a vendor connector posts every required credential from its config_schema", async () => {
    const onCreated = renderDialog();
    await pick("confluence");
    setField(/Collection id/i, "eng-space");
    setField(/Confluence site URL/i, "https://acme.atlassian.net/wiki");
    setField(/Atlassian account email/i, "ops@acme.com");
    setField(/Space key/i, "ENG");
    setSecret("atlassian-token");
    submit();

    await waitFor(() => expect(fetchCalls).toHaveLength(1));
    expect(fetchCalls[0].url).toContain("/api/v1/integrations/confluence/install-form");
    expect(fetchCalls[0].body).toEqual({
      __install_id__: "eng-space",
      base_url: "https://acme.atlassian.net/wiki",
      email: "ops@acme.com",
      space_key: "ENG",
      api_token: "atlassian-token",
    });
    expect(onCreated).toHaveBeenCalledWith("eng-space", "confluence");
  });

  test("a duplicate collection id is rejected before any install call", async () => {
    renderDialog(mock(() => {}), ["taken"]);
    await pick("okf-upload");
    setField(/Collection id/i, "taken");
    submit();

    await waitFor(() => expect(screen.getByText(/already exists/i)).toBeTruthy());
    expect(fetchCalls).toHaveLength(0);
  });

  test("the Back affordance returns from a connector form to the picker", async () => {
    renderDialog();
    await pick("gitbook");
    fireEvent.click(screen.getByTestId("connector-back"));
    // Back at the picker — every tile is selectable again.
    expect(screen.getByTestId("connector-okf-upload")).toBeTruthy();
    expect(screen.queryByTestId("create-collection-submit")).toBeNull();
  });

  test("search narrows the tile list", () => {
    renderDialog();
    fireEvent.change(screen.getByTestId("connector-search"), { target: { value: "zendesk" } });
    expect(screen.getByTestId("connector-zendesk")).toBeTruthy();
    expect(screen.queryByTestId("connector-okf-upload")).toBeNull();
  });
});

describe("CreateCollectionDialog — edit mode (sync-settings rotation)", () => {
  function renderEdit(onCreated = mock(() => {})) {
    render(
      <CreateCollectionDialog
        open
        onOpenChange={() => {}}
        onCreated={onCreated}
        existingSlugs={[]}
        edit={{
          slug: "synced-docs",
          endpointUrl: "https://kb.example.com/bundle.tar.gz",
          authScheme: "bearer",
          description: "Docs mirror",
        }}
      />,
    );
    return onCreated;
  }

  test("re-drives the bundle-sync install with the EXISTING slug — rotating the secret in place", async () => {
    const onCreated = renderEdit();
    const button = screen.getByTestId("create-collection-submit") as HTMLButtonElement;
    expect(button.disabled).toBe(true); // secret required for bearer, starts blank
    fireEvent.change(screen.getByTestId("collection-secret"), {
      target: { value: "new-rotated-token" },
    });
    fireEvent.click(screen.getByTestId("create-collection-submit"));

    await waitFor(() => expect(fetchCalls).toHaveLength(1));
    expect(fetchCalls[0].url).toContain("/api/v1/integrations/bundle-sync/install-form");
    expect(fetchCalls[0].body).toEqual({
      __install_id__: "synced-docs",
      description: "Docs mirror",
      endpoint_url: "https://kb.example.com/bundle.tar.gz",
      auth_scheme: "bearer",
      auth_secret: "new-rotated-token",
    });
    expect(onCreated).toHaveBeenCalledWith("synced-docs", "bundle-sync");
  });

  test("a none-scheme edit needs no secret and posts auth_scheme none (no stray auth_secret)", async () => {
    const onCreated = mock(() => {});
    render(
      <CreateCollectionDialog
        open
        onOpenChange={() => {}}
        onCreated={onCreated}
        existingSlugs={[]}
        edit={{
          slug: "public-docs",
          endpointUrl: "https://kb.example.com/public.zip",
          authScheme: "none",
          description: null,
        }}
      />,
    );
    const button = screen.getByTestId("create-collection-submit") as HTMLButtonElement;
    expect(button.disabled).toBe(false); // no secret required for a public endpoint
    fireEvent.click(button);

    await waitFor(() => expect(fetchCalls).toHaveLength(1));
    expect(fetchCalls[0].body).toEqual({
      __install_id__: "public-docs",
      endpoint_url: "https://kb.example.com/public.zip",
      auth_scheme: "none",
    });
    expect(onCreated).toHaveBeenCalledWith("public-docs", "bundle-sync");
  });

  test("edit mode hides the connector picker — the identity is fixed", () => {
    renderEdit();
    expect(screen.queryByTestId("connector-search")).toBeNull();
    expect(screen.queryByTestId("connector-okf-upload")).toBeNull();
  });
});
