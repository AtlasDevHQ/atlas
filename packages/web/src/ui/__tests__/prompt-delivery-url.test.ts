import { describe, it, expect } from "bun:test";
import { buildPromptDeliveryUrl } from "../components/prompt-delivery";

/**
 * `deliverPrompt` (the WorkspaceShell modal → chat hand-off) must preserve an
 * active conversation deep link (`?id=`) when prefilling a prompt — otherwise the
 * chat surface reads the missing `?id=` as "new chat" and wipes the open thread
 * (#3081). The end-to-end guarantee the `?prompt=` prefill test asserts on the
 * clear side (clearing `prompt` keeps `id`) only holds if the *delivery* side
 * keeps `id` too; this covers that half against the pure URL builder.
 */
describe("buildPromptDeliveryUrl (#3081)", () => {
  it("preserves an active conversation ?id= on the chat surface", () => {
    expect(buildPromptDeliveryUrl("/", "conv-1", "What's our GMV?")).toBe(
      "/?id=conv-1&prompt=What's%20our%20GMV%3F",
    );
  });

  it("omits id when no conversation is active on chat", () => {
    expect(buildPromptDeliveryUrl("/", null, "hello")).toBe("/?prompt=hello");
  });

  it("preserves ?id= on the notebook surface", () => {
    expect(buildPromptDeliveryUrl("/notebook", "conv-2", "rows by region")).toBe(
      "/notebook?id=conv-2&prompt=rows%20by%20region",
    );
  });

  it("treats nested notebook routes as the notebook surface", () => {
    expect(buildPromptDeliveryUrl("/notebook/abc", "conv-3", "q")).toBe(
      "/notebook?id=conv-3&prompt=q",
    );
  });

  it("drops a dashboards ?id= (it's a dashboard id, not a conversation) when routing to chat", () => {
    // On /dashboards the `?id=` is a dashboard id; carrying it into the chat
    // deep link would open the wrong (or no) conversation, so it's dropped.
    expect(buildPromptDeliveryUrl("/dashboards", "dash-9", "summary")).toBe(
      "/?prompt=summary",
    );
  });

  it("encodes special characters in both id and text", () => {
    expect(buildPromptDeliveryUrl("/", "a b&c", "x=y&z")).toBe(
      "/?id=a%20b%26c&prompt=x%3Dy%26z",
    );
  });
});
