import React, { type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReplayObservabilityProfile } from "@rybbit/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setPrivateKeyResolver } from "../../requestContext";

const state = vi.hoisted(() => ({
  site: "1",
  privateKey: null as string | null,
  user: null as { id: string } | null,
  fetchProfiles: vi.fn(),
}));
vi.mock("@/lib/store", () => ({ useStore: (select: (value: { site: string }) => unknown) => select(state) }));
vi.mock("@/lib/userStore", () => ({
  userStore: (select: (value: { user: { id: string } | null }) => unknown) => select(state),
}));
vi.mock("../endpoints/replayObservability", () => ({ fetchReplayObservability: state.fetchProfiles }));

import { useReplayObservability } from "./useReplayObservability";

const profiles: ReplayObservabilityProfile[] = [
  {
    requestOrigin: "https://api.example.com",
    grafanaUrl: "https://grafana.example.com",
    orgId: 1,
    lokiDatasourceUid: "loki",
    serviceName: "api",
    environment: "prod",
    timePaddingMs: 120000,
  },
];
let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  state.site = "1";
  state.privateKey = null;
  setPrivateKeyResolver(() => state.privateKey);
  state.user = null;
  state.fetchProfiles.mockReset().mockResolvedValue({ profiles });
});
afterEach(() => {
  cleanup();
  client.clear();
  setPrivateKeyResolver(() => null);
});

describe("private replay observability query", () => {
  it("does not request profiles for a signed-out/public viewer", () => {
    const { result } = renderHook(useReplayObservability, { wrapper });
    expect(result.current).toBeUndefined();
    expect(state.fetchProfiles).not.toHaveBeenCalled();
  });

  it("hides cached profiles immediately after logout", async () => {
    state.user = { id: "alice" };
    const { result, rerender } = renderHook(useReplayObservability, { wrapper });
    await waitFor(() => expect(result.current).toEqual(profiles));
    state.user = null;
    rerender();
    expect(result.current).toBeUndefined();
    expect(state.fetchProfiles).toHaveBeenCalledTimes(1);
  });

  it.each(["site", "user"])("does not reuse private profiles after changing %s", async changed => {
    state.user = { id: "alice" };
    const { result, rerender } = renderHook(useReplayObservability, { wrapper });
    await waitFor(() => expect(result.current).toEqual(profiles));
    // The new request intentionally remains pending while checking stale-data isolation.
    state.fetchProfiles.mockImplementation(() => new Promise(() => undefined));
    if (changed === "site") state.site = "2";
    else state.user = { id: "bob" };
    rerender();
    expect(result.current).toBeUndefined();
    await waitFor(() => expect(state.fetchProfiles).toHaveBeenCalledTimes(2));
    expect(state.fetchProfiles).toHaveBeenLastCalledWith(state.site, null);
  });

  it.each([403, 503])("leaves playback without links when configuration returns %s", async status => {
    state.user = { id: "alice" };
    state.fetchProfiles.mockRejectedValue(new Error(String(status)));
    const { result } = renderHook(useReplayObservability, { wrapper });
    await waitFor(() =>
      expect(client.getQueryState(["replay-observability", "1", "alice", "default"])?.status).toBe("error")
    );
    expect(result.current).toBeUndefined();
    expect(state.fetchProfiles).toHaveBeenCalledTimes(1);
  });

  it("does not reuse private profiles when the same signed-in user changes private link", async () => {
    state.user = { id: "alice" };
    state.privateKey = "valid-secret";
    const { result, rerender } = renderHook(useReplayObservability, { wrapper });
    await waitFor(() => expect(result.current).toEqual(profiles));
    const originalQuery = client.getQueryCache().getAll()[0];
    state.fetchProfiles.mockImplementation(() => new Promise(() => {}));
    state.privateKey = "invalid-secret";
    rerender();
    expect(result.current).toBeUndefined();
    await waitFor(() => expect(state.fetchProfiles).toHaveBeenCalledTimes(2));
    state.fetchProfiles.mockResolvedValue({ profiles });
    await originalQuery.fetch();
    expect(state.fetchProfiles).toHaveBeenLastCalledWith("1", "valid-secret");
    expect(result.current).toBeUndefined();
  });
});
