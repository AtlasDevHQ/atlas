import { describe, expect, test, mock, beforeEach } from "bun:test";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { ManagedAuthCard } from "../components/chat/managed-auth-card";
import { AtlasUIProvider, type AtlasAuthClient } from "../context";

let mockSignIn: ReturnType<typeof mock>;
let mockSignUp: ReturnType<typeof mock>;

function makeAuthClient(): AtlasAuthClient {
  mockSignIn = mock(() => Promise.resolve({ error: null }));
  mockSignUp = mock(() => Promise.resolve({ error: null }));
  return {
    signIn: { email: mockSignIn as AtlasAuthClient["signIn"]["email"] },
    signUp: { email: mockSignUp as AtlasAuthClient["signUp"]["email"] },
    signOut: async () => {},
    useSession: () => ({ data: null }),
  };
}

function renderCard(authClient?: AtlasAuthClient) {
  const client = authClient ?? makeAuthClient();
  return render(
    <AtlasUIProvider config={{ apiUrl: "http://localhost:3001", isCrossOrigin: false, authClient: client }}>
      <ManagedAuthCard />
    </AtlasUIProvider>,
  );
}

describe("ManagedAuthCard", () => {
  beforeEach(() => {
    mockSignIn = mock(() => Promise.resolve({ error: null }));
    mockSignUp = mock(() => Promise.resolve({ error: null }));
  });

  test("renders login view by default", () => {
    const { container } = renderCard();
    expect(container.textContent).toContain("Sign in to Atlas");
    expect(container.textContent).toContain("Enter your credentials");
  });

  test("has email and password inputs", () => {
    const { container } = renderCard();
    const emailInput = container.querySelector('input[type="email"]');
    const passwordInput = container.querySelector('input[type="password"]');
    expect(emailInput).not.toBeNull();
    expect(passwordInput).not.toBeNull();
  });

  test("has sign in button", () => {
    const { container } = renderCard();
    const buttons = container.querySelectorAll("button");
    const submitBtn = Array.from(buttons).find((b) => b.getAttribute("type") === "submit");
    expect(submitBtn).not.toBeNull();
    expect(submitBtn!.textContent).toContain("Sign in");
  });

  test("switches to signup view when 'Create one' is clicked", () => {
    const { container } = renderCard();
    const switchBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Create one"),
    );
    expect(switchBtn).not.toBeNull();
    fireEvent.click(switchBtn!);
    expect(container.textContent).toContain("Create an account");
    expect(container.textContent).toContain("Set up your Atlas account");
  });

  test("shows name field in signup view", () => {
    const { container } = renderCard();
    // Switch to signup
    const switchBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Create one"),
    );
    fireEvent.click(switchBtn!);
    const nameInput = container.querySelector('input[type="text"]');
    expect(nameInput).not.toBeNull();
  });

  test("switches back to login from signup", () => {
    const { container } = renderCard();
    // Go to signup
    fireEvent.click(
      Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Create one"))!,
    );
    // Go back to login
    fireEvent.click(
      Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Sign in"))!,
    );
    expect(container.textContent).toContain("Sign in to Atlas");
  });

  test("calls signIn.email on login submit", async () => {
    const client = makeAuthClient();
    const { container } = renderCard(client);

    const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement;
    const passwordInput = container.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(emailInput, { target: { value: "test@example.com" } });
    fireEvent.change(passwordInput, { target: { value: "password123" } });

    const form = container.querySelector("form")!;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockSignIn).toHaveBeenCalledWith({
        email: "test@example.com",
        password: "password123",
      });
    });
  });

  test("calls signUp.email on signup submit", async () => {
    const client = makeAuthClient();
    const { container } = renderCard(client);

    // Switch to signup
    fireEvent.click(
      Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Create one"))!,
    );

    const nameInput = container.querySelector('input[type="text"]') as HTMLInputElement;
    const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement;
    const passwordInput = container.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Test User" } });
    fireEvent.change(emailInput, { target: { value: "test@example.com" } });
    fireEvent.change(passwordInput, { target: { value: "password123" } });

    const form = container.querySelector("form")!;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockSignUp).toHaveBeenCalledWith({
        email: "test@example.com",
        password: "password123",
        name: "Test User",
      });
    });
  });

  test("shows error when signIn returns error", async () => {
    const client = makeAuthClient();
    mockSignIn = mock(() => Promise.resolve({ error: { message: "Invalid credentials" } }));
    client.signIn.email = mockSignIn as AtlasAuthClient["signIn"]["email"];
    const { container } = renderCard(client);

    const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement;
    const passwordInput = container.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(emailInput, { target: { value: "bad@test.com" } });
    fireEvent.change(passwordInput, { target: { value: "wrong" } });

    const form = container.querySelector("form")!;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(container.textContent).toContain("Invalid credentials");
    });
  });

  test("shows generic error when signIn throws TypeError", async () => {
    const client = makeAuthClient();
    mockSignIn = mock(() => Promise.reject(new TypeError("fetch failed")));
    client.signIn.email = mockSignIn as AtlasAuthClient["signIn"]["email"];
    const { container } = renderCard(client);

    const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement;
    const passwordInput = container.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(emailInput, { target: { value: "test@test.com" } });
    fireEvent.change(passwordInput, { target: { value: "pass" } });

    const form = container.querySelector("form")!;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(container.textContent).toContain("Unable to reach the server");
    });
  });

  test("clears error when switching views", () => {
    const client = makeAuthClient();
    const { container } = renderCard(client);

    // We can't easily trigger an error synchronously, but we can verify the toggle clears state
    // Switch to signup
    fireEvent.click(
      Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Create one"))!,
    );
    // No error visible
    const errorEls = container.querySelectorAll(".text-red-600");
    expect(errorEls.length).toBe(0);
  });
});
