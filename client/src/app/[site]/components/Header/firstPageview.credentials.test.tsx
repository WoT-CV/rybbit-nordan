import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildAnalyticsQueryKey, buildAnalyticsRequest } from "../../../../api/analytics/analyticsRequest";
import { setPrivateKeyResolver } from "../../../../api/requestContext";
import { useStore } from "../../../../lib/store";
import { useFirstSession } from "./firstPageview";

let queryClient: QueryClient;
const wrapper = ({ children }: PropsWithChildren) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

beforeEach(() => {
  queryClient = new QueryClient();
  useStore.setState({ ...useStore.getInitialState(), privateKey: "valid-secret" });
  setPrivateKeyResolver(() => useStore.getState().privateKey);
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  setPrivateKeyResolver(() => null);
});

describe("first-visitor cache reader credential isolation", () => {
  it("does not show a cached visitor from a different private link", () => {
    const request = buildAnalyticsRequest({ path: "sessions" }, { time: null, timeZone: "UTC" });
    const key = [...buildAnalyticsQueryKey("sessions-infinite", "7", request), "infinite"];
    const visitor = { session_id: "private-visitor", session_start: "2026-10-24 10:00:00" };
    queryClient.setQueryData(key, { pages: [[visitor]], pageParams: [1] });
    const { result } = renderHook(() => useFirstSession("7", true), { wrapper });
    expect(result.current).toBe(visitor);
    act(() => useStore.getState().setPrivateKey("invalid-secret"));
    expect(result.current).toBeUndefined();
    act(() => useStore.getState().setPrivateKey(null));
    expect(result.current).toBeUndefined();
  });
});
