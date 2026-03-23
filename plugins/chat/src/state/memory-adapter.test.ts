/**
 * Tests for the in-memory state adapter.
 *
 * Verifies that the memory adapter (Chat SDK's built-in) satisfies the
 * same operations tested against the PG adapter, ensuring behavioral
 * parity between backends.
 */

import { describe, expect, it, beforeEach } from "bun:test";
import { createMemoryState } from "./memory-adapter";

describe("Memory state adapter", () => {
  let adapter: ReturnType<typeof createMemoryState>;

  beforeEach(async () => {
    adapter = createMemoryState();
    await adapter.connect();
  });

  // -- Subscriptions --

  it("subscribe + isSubscribed round-trip", async () => {
    expect(await adapter.isSubscribed("t1")).toBe(false);
    await adapter.subscribe("t1");
    expect(await adapter.isSubscribed("t1")).toBe(true);
  });

  it("unsubscribe removes subscription", async () => {
    await adapter.subscribe("t1");
    await adapter.unsubscribe("t1");
    expect(await adapter.isSubscribed("t1")).toBe(false);
  });

  it("double subscribe is idempotent", async () => {
    await adapter.subscribe("t1");
    await adapter.subscribe("t1");
    expect(await adapter.isSubscribed("t1")).toBe(true);
  });

  // -- Locks --

  it("acquireLock succeeds on first attempt", async () => {
    const lock = await adapter.acquireLock("t1", 30_000);
    expect(lock).not.toBeNull();
    expect(lock!.threadId).toBe("t1");
    expect(lock!.token).toBeTruthy();
  });

  it("acquireLock returns null when already locked", async () => {
    await adapter.acquireLock("t1", 30_000);
    const second = await adapter.acquireLock("t1", 30_000);
    expect(second).toBeNull();
  });

  it("releaseLock allows re-acquisition", async () => {
    const lock = await adapter.acquireLock("t1", 30_000);
    expect(lock).not.toBeNull();
    await adapter.releaseLock(lock!);

    const second = await adapter.acquireLock("t1", 30_000);
    expect(second).not.toBeNull();
  });

  it("forceReleaseLock clears regardless of token", async () => {
    await adapter.acquireLock("t1", 30_000);
    await adapter.forceReleaseLock("t1");

    const second = await adapter.acquireLock("t1", 30_000);
    expect(second).not.toBeNull();
  });

  it("extendLock refreshes TTL", async () => {
    const lock = await adapter.acquireLock("t1", 1_000);
    expect(lock).not.toBeNull();

    const extended = await adapter.extendLock(lock!, 60_000);
    expect(extended).toBe(true);
  });

  // -- Cache --

  it("get/set round-trip", async () => {
    await adapter.set("k1", { data: 42 });
    const val = await adapter.get<{ data: number }>("k1");
    expect(val).toEqual({ data: 42 });
  });

  it("get returns null for missing key", async () => {
    const val = await adapter.get("missing");
    expect(val).toBeNull();
  });

  it("delete removes key", async () => {
    await adapter.set("k1", "value");
    await adapter.delete("k1");
    expect(await adapter.get("k1")).toBeNull();
  });

  it("setIfNotExists returns true when new", async () => {
    const result = await adapter.setIfNotExists("k1", "val");
    expect(result).toBe(true);
    expect(await adapter.get<string>("k1")).toBe("val");
  });

  it("setIfNotExists returns false when exists", async () => {
    await adapter.set("k1", "original");
    const result = await adapter.setIfNotExists("k1", "new");
    expect(result).toBe(false);
    expect(await adapter.get<string>("k1")).toBe("original");
  });

  // -- Lists --

  it("appendToList + getList round-trip", async () => {
    await adapter.appendToList("list1", { role: "user", content: "hi" });
    await adapter.appendToList("list1", { role: "assistant", content: "hello" });

    const items = await adapter.getList<{ role: string; content: string }>("list1");
    expect(items).toHaveLength(2);
    expect(items[0].content).toBe("hi");
    expect(items[1].content).toBe("hello");
  });

  it("getList returns empty array for missing key", async () => {
    const items = await adapter.getList("nonexistent");
    expect(items).toEqual([]);
  });

  it("appendToList trims to maxLength", async () => {
    for (let i = 0; i < 5; i++) {
      await adapter.appendToList("list1", { i }, { maxLength: 3 });
    }

    const items = await adapter.getList<{ i: number }>("list1");
    expect(items).toHaveLength(3);
    // Should keep the 3 newest
    expect(items[0].i).toBe(2);
    expect(items[1].i).toBe(3);
    expect(items[2].i).toBe(4);
  });

  // -- Lifecycle --

  it("disconnect is safe to call", async () => {
    await adapter.disconnect();
    // Should not throw
  });
});
