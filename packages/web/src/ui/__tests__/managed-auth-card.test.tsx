import { describe, expect, test, mock } from "bun:test";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { ManagedAuthCard } from "../components/chat/managed-auth-card";
import { AtlasUIProvider, type AtlasAuthClient } from "../context";

function makeAuthClient() {
  const signIn = mock(() => Promise.resolve({ error: null }));
  const signUp = mock(() => Promise.resolve({ error: null }));
  const client: AtlasAuthClient = {
    signIn: { email: signIn as AtlasAuthClient["signIn"]["email"] },
    signUp: { email: signUp as AtlasAuthClient["signUp"]["email"] },
    signOut: async () => {},
    useSession: () => ({ data: null }),
  };
  return { client, signIn, signUp };
}

function renderCard(authClient?: AtlasAuthClient) {
  const ac = authClient ?? makeAuthClient().client;
  return render(
    <AtlasUIProvider config={{ apiUrl: "http://localhost:3001", isCrossOrigin: false, authClient: ac }}>
      <ManagedAuthCard />
    </AtlasUIProvider>,
  );
}

/** Switch the card to signup view. */
function switchToSignup(container: HTMLElement) {
  fireEvent.click(
    Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Create one"))!,
  );
}

describe("ManagedAuthCard", () => {
  test("renders login view by default", () => {
    const { container } = renderCard();
    expect(container.textContent).toContain("Sign in to Atlas");
    expect(container.textContent).toContain("AI-powered data analyst");
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
    switchToSignup(container);
    expect(container.textContent).toContain("Create an account");
    expect(container.textContent).toContain("Get started with Atlas");
  });

  test("shows name field in signup view", () => {
    const { container } = renderCard();
    switchToSignup(container);
    const nameInput = container.querySelector('input[type="text"]');
    expect(nameInput).not.toBeNull();
  });

  test("switches back to login from signup", () => {
    const { container } = renderCard();
    switchToSignup(container);
    fireEvent.click(
      Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Sign in"))!,
    );
    expect(container.textContent).toContain("Sign in to Atlas");
  });

  test("calls signIn.email on login submit", async () => {
    const { client, signIn } = makeAuthClient();
    const { container } = renderCard(client);

    const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement;
    const passwordInput = container.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(emailInput, { target: { value: "test@example.com" } });
    fireEvent.change(passwordInput, { target: { value: "password123" } });

    fireEvent.submit(container.querySelector("form")!);

    await waitFor(() => {
      expect(signIn).toHaveBeenCalledWith({
        email: "test@example.com",
        password: "password123",
      });
    });
  });

  test("calls signUp.email on signup submit", async () => {
    const { client, signUp } = makeAuthClient();
    const { container } = renderCard(client);
    switchToSignup(container);

    const nameInput = container.querySelector('input[type="text"]') as HTMLInputElement;
    const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement;
    const passwordInput = container.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Test User" } });
    fireEvent.change(emailInput, { target: { value: "test@example.com" } });
    fireEvent.change(passwordInput, { target: { value: "password123" } });

    fireEvent.submit(container.querySelector("form")!);

    await waitFor(() => {
      expect(signUp).toHaveBeenCalledWith({
        email: "test@example.com",
        password: "password123",
        name: "Test User",
      });
    });
  });

  test("uses email prefix as name when name field is empty", async () => {
    const { client, signUp } = makeAuthClient();
    const { container } = renderCard(client);
    switchToSignup(container);

    // Leave name field empty
    const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement;
    const passwordInput = container.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(emailInput, { target: { value: "alice@example.com" } });
    fireEvent.change(passwordInput, { target: { value: "password123" } });

    fireEvent.submit(container.querySelector("form")!);

    await waitFor(() => {
      expect(signUp).toHaveBeenCalledWith({
        email: "alice@example.com",
        password: "password123",
        name: "alice",
      });
    });
  });

  test("shows error when signIn returns error", async () => {
    const { client } = makeAuthClient();
    client.signIn.email = mock(() =>
      Promise.resolve({ error: { message: "Invalid credentials" } }),
    ) as AtlasAuthClient["signIn"]["email"];
    const { container } = renderCard(client);

    fireEvent.change(container.querySelector('input[type="email"]')!, { target: { value: "bad@test.com" } });
    fireEvent.change(container.querySelector('input[type="password"]')!, { target: { value: "wrong" } });
    fireEvent.submit(container.querySelector("form")!);

    await waitFor(() => {
      expect(container.textContent).toContain("Invalid credentials");
    });
  });

  test("shows generic error when signIn throws TypeError", async () => {
    const { client } = makeAuthClient();
    client.signIn.email = mock(() =>
      Promise.reject(new TypeError("fetch failed")),
    ) as AtlasAuthClient["signIn"]["email"];
    const { container } = renderCard(client);

    fireEvent.change(container.querySelector('input[type="email"]')!, { target: { value: "test@test.com" } });
    fireEvent.change(container.querySelector('input[type="password"]')!, { target: { value: "pass" } });
    fireEvent.submit(container.querySelector("form")!);

    await waitFor(() => {
      expect(container.textContent).toContain("Unable to reach the server");
    });
  });

  test("shows error when signUp returns error", async () => {
    const { client } = makeAuthClient();
    client.signUp.email = mock(() =>
      Promise.resolve({ error: { message: "Email already taken" } }),
    ) as AtlasAuthClient["signUp"]["email"];
    const { container } = renderCard(client);
    switchToSignup(container);

    fireEvent.change(container.querySelector('input[type="email"]')!, { target: { value: "dup@test.com" } });
    fireEvent.change(container.querySelector('input[type="password"]')!, { target: { value: "password123" } });
    fireEvent.submit(container.querySelector("form")!);

    await waitFor(() => {
      expect(container.textContent).toContain("Email already taken");
    });
  });

  test("shows network error when signUp throws TypeError", async () => {
    const { client } = makeAuthClient();
    client.signUp.email = mock(() =>
      Promise.reject(new TypeError("fetch failed")),
    ) as AtlasAuthClient["signUp"]["email"];
    const { container } = renderCard(client);
    switchToSignup(container);

    fireEvent.change(container.querySelector('input[type="email"]')!, { target: { value: "test@test.com" } });
    fireEvent.change(container.querySelector('input[type="password"]')!, { target: { value: "password123" } });
    fireEvent.submit(container.querySelector("form")!);

    await waitFor(() => {
      expect(container.textContent).toContain("Unable to reach the server");
    });
  });

  test("clears error when switching views", async () => {
    // Trigger an actual login error first
    const { client } = makeAuthClient();
    client.signIn.email = mock(() =>
      Promise.resolve({ error: { message: "Bad creds" } }),
    ) as AtlasAuthClient["signIn"]["email"];
    const { container } = renderCard(client);

    fireEvent.change(container.querySelector('input[type="email"]')!, { target: { value: "x@x.com" } });
    fireEvent.change(container.querySelector('input[type="password"]')!, { target: { value: "wrong" } });
    fireEvent.submit(container.querySelector("form")!);

    await waitFor(() => {
      expect(container.textContent).toContain("Bad creds");
    });

    // Switch to signup — error should be cleared
    switchToSignup(container);
    expect(container.textContent).not.toContain("Bad creds");
  });
});
