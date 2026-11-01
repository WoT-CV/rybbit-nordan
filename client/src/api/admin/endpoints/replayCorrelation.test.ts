import { afterEach, describe, expect, it, vi } from "vitest";
import { setPrivateKeyResolver } from "../../requestContext";
import { authedFetch } from "../../utils";
import { fetchReplayCorrelationConfig } from "./replayCorrelation";
vi.mock("../../utils", () => ({
  authedFetch: vi.fn(),
  ApiError: class extends Error {
    constructor(
      message: string,
      public status: number
    ) {
      super(message);
    }
  },
}));
afterEach(() => {
  vi.clearAllMocks();
  setPrivateKeyResolver(() => null);
});
describe("private correlation configuration endpoint", () => {
  it("uses the native authenticated request and abort signal", async () => {
    vi.mocked(authedFetch).mockResolvedValue({ enabled: false, profiles: [] });
    const controller = new AbortController();
    expect(await fetchReplayCorrelationConfig(7, controller.signal)).toEqual({ enabled: false, profiles: [] });
    expect(authedFetch).toHaveBeenCalledWith("/sites/7/session-replay/correlation-config", undefined, {
      signal: controller.signal,
      headers: { "Cache-Control": "no-cache" },
    });
  });
  it("fails closed on malformed responses, invalid site IDs, and private-link request context", async () => {
    vi.mocked(authedFetch).mockResolvedValue({ enabled: true, profiles: [{}] });
    await expect(fetchReplayCorrelationConfig(7)).rejects.toThrow();
    vi.mocked(authedFetch).mockClear();
    await expect(fetchReplayCorrelationConfig(-1)).rejects.toThrow("Invalid site ID");
    setPrivateKeyResolver(() => "abcdef123456");
    await expect(fetchReplayCorrelationConfig(7)).rejects.toMatchObject({ status: 403 });
    expect(authedFetch).not.toHaveBeenCalled();
  });
});
