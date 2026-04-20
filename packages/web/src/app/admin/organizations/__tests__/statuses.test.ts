import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { CheckCircle2, CreditCard, Pause, Trash2 } from "lucide-react";
import { _resetWarnSets, planBadge, statusBadge } from "../statuses";

describe("statusBadge", () => {
  let warnSpy: ReturnType<typeof spyOn<Console, "warn">>;

  beforeEach(() => {
    _resetWarnSets();
  });

  afterEach(() => {
    warnSpy?.mockRestore();
  });

  test("active resolves to CheckCircle2 + emerald classes", () => {
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const { Icon, className, label } = statusBadge("active");
    expect(Icon).toBe(CheckCircle2);
    expect(className).toContain("text-emerald-700");
    expect(label).toBe("Active");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("suspended resolves to Pause + amber classes", () => {
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const { Icon, className, label } = statusBadge("suspended");
    expect(Icon).toBe(Pause);
    expect(className).toContain("text-amber-700");
    expect(label).toBe("Suspended");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("deleted resolves to Trash2 + red classes", () => {
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const { Icon, className, label } = statusBadge("deleted");
    expect(Icon).toBe(Trash2);
    expect(className).toContain("text-red-700");
    expect(label).toBe("Deleted");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("unknown statuses render the raw value as the label and warn once", () => {
    // Fail-safe rendering: a server that ships a new workspace_status enum
    // value before the web bundle catches up must not crash the row. The
    // neutral fallback labels with the raw value so the operator can see
    // what came back; the one-time `console.warn` lets devtools / Sentry
    // surface the drift without spamming on every render.
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const unknown = statusBadge("hibernating-test-status");
    expect(unknown.label).toBe("hibernating-test-status");
    expect(unknown.className).toContain("text-muted-foreground");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("hibernating-test-status");

    // Same value second time — dedup suppresses the warn.
    statusBadge("hibernating-test-status");
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // A different unknown value warns exactly once more.
    statusBadge("another-test-status");
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  test("empty status falls back to 'Unknown' label", () => {
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const { label } = statusBadge("");
    expect(label).toBe("Unknown");
  });
});

describe("planBadge", () => {
  let warnSpy: ReturnType<typeof spyOn<Console, "warn">>;

  beforeEach(() => {
    _resetWarnSets();
  });

  afterEach(() => {
    warnSpy?.mockRestore();
  });

  test("free resolves to CreditCard + muted classes", () => {
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const { Icon, className, label } = planBadge("free");
    expect(Icon).toBe(CreditCard);
    expect(className).toContain("text-muted-foreground");
    expect(label).toBe("Free");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("trial resolves to blue classes", () => {
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const { className, label } = planBadge("trial");
    expect(className).toContain("text-blue-700");
    expect(label).toBe("Trial");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("starter resolves to primary classes", () => {
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const { className, label } = planBadge("starter");
    expect(className).toContain("text-primary");
    expect(label).toBe("Starter");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("pro resolves to violet classes", () => {
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const { className, label } = planBadge("pro");
    expect(className).toContain("text-violet-700");
    expect(label).toBe("Pro");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("business resolves to purple classes", () => {
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const { className, label } = planBadge("business");
    expect(className).toContain("text-purple-700");
    expect(label).toBe("Business");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("unknown plan tiers render the raw value as the label and warn once", () => {
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const unknown = planBadge("enterprise-tier-test");
    expect(unknown.label).toBe("enterprise-tier-test");
    expect(unknown.className).toContain("text-muted-foreground");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("enterprise-tier-test");

    planBadge("enterprise-tier-test");
    expect(warnSpy).toHaveBeenCalledTimes(1);

    planBadge("another-plan-test");
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  test("empty plan tier falls back to 'Unknown' label", () => {
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const { label } = planBadge("");
    expect(label).toBe("Unknown");
  });
});
