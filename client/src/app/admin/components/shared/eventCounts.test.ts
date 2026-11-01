import { describe, expect, it } from "vitest";
import { formatEventCount, sumEventCounts } from "./eventCounts";

describe("admin observations", () => {
  it("keeps failed observations unknown instead of adding zero", () => {
    expect(sumEventCounts([12, null, 7])).toBeNull();
    expect(formatEventCount(null)).toBe("—");
  });
  it("distinguishes a measured zero from unavailable data", () => {
    expect(sumEventCounts([0, 0])).toBe(0);
    expect(formatEventCount(0)).toBe("0");
    expect(sumEventCounts([12, 7])).toBe(19);
  });
});
