import { describe, it, expect } from "bun:test";
import { renderHook } from "@testing-library/react";
import { AtlasProvider, useAtlasContext } from "../../context";
import type { ReactNode } from "react";

function wrapper({ children }: { children: ReactNode }) {
  return (
    <AtlasProvider apiUrl="https://api.example.com" apiKey="test-key">
      {children}
    </AtlasProvider>
  );
}

describe("AtlasProvider", () => {
  it("provides context values to children", () => {
    const { result } = renderHook(() => useAtlasContext(), { wrapper });

    expect(result.current.apiUrl).toBe("https://api.example.com");
    expect(result.current.apiKey).toBe("test-key");
    expect(result.current.isCrossOrigin).toBe(true);
    expect(result.current.authClient).toBeDefined();
  });

  it("throws when useAtlasContext is called outside provider", () => {
    expect(() => {
      renderHook(() => useAtlasContext());
    }).toThrow("useAtlasContext must be used within <AtlasProvider>");
  });

  it("noop auth client warns and returns error on use", async () => {
    const { result } = renderHook(() => useAtlasContext(), { wrapper });

    const session = result.current.authClient.useSession();
    expect(session.data).toBeNull();
    expect(session.isPending).toBe(false);

    const signInResult = await result.current.authClient.signIn.email({
      email: "test@test.com",
      password: "pass",
    });
    expect(signInResult.error?.message).toBe("Auth client not configured");
  });

  it("detects same-origin URLs", () => {
    function sameOriginWrapper({ children }: { children: ReactNode }) {
      return (
        <AtlasProvider apiUrl="">
          {children}
        </AtlasProvider>
      );
    }

    const { result } = renderHook(() => useAtlasContext(), {
      wrapper: sameOriginWrapper,
    });

    expect(result.current.isCrossOrigin).toBe(false);
  });

  it("accepts a custom auth client", () => {
    const customAuthClient = {
      signIn: { email: async () => ({ error: null }) },
      signUp: { email: async () => ({ error: null }) },
      signOut: async () => {},
      useSession: () => ({ data: { user: { email: "test@test.com" } }, isPending: false }),
    };

    function customWrapper({ children }: { children: ReactNode }) {
      return (
        <AtlasProvider apiUrl="https://api.example.com" authClient={customAuthClient}>
          {children}
        </AtlasProvider>
      );
    }

    const { result } = renderHook(() => useAtlasContext(), {
      wrapper: customWrapper,
    });

    const session = result.current.authClient.useSession();
    expect(session.data?.user?.email).toBe("test@test.com");
  });
});
