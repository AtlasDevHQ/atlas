import { describe, it, expect } from "bun:test";
import { deriveDeviceLabel } from "@atlas/api/lib/auth/device-label";

// Parity check — these expectations MUST match what
// `packages/web/src/lib/auth/derive-device-name.ts:deriveDeviceName` returns
// for the same inputs. The two files are intentionally duplicated to avoid
// a server→browser package boundary; this suite (and the matching
// passkey-tile.test.tsx test) is what keeps them aligned.

describe("deriveDeviceLabel", () => {
  it("recognizes Mac Safari", () => {
    expect(
      deriveDeviceLabel(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
      ),
    ).toBe("Mac · Safari");
  });

  it("recognizes Windows Chrome", () => {
    expect(
      deriveDeviceLabel(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      ),
    ).toBe("Windows PC · Chrome");
  });

  it("recognizes iPhone Safari", () => {
    expect(
      deriveDeviceLabel(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("iPhone · Safari");
  });

  it("recognizes Edge over Chrome (Edge UA contains both)", () => {
    expect(
      deriveDeviceLabel(
        "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
      ),
    ).toBe("Windows PC · Edge");
  });

  it("falls back when nothing matches", () => {
    expect(deriveDeviceLabel("ExoticHttpBot/1.0")).toBe("This device");
  });

  it("returns device alone when browser is unknown", () => {
    expect(deriveDeviceLabel("Mozilla/5.0 (Android; Mobile)")).toBe("Android");
  });
});
