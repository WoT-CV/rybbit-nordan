import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useStore } from "../../lib/store";
import { setPrivateKeyResolver } from "../requestContext";
import { useAnalyticsInfiniteQuery, useAnalyticsQuery } from "./useAnalyticsQuery";
import { useUserSummary } from "./hooks/useUserProfile";
import { useUserInfo } from "./hooks/userGetInfo";

const mocks = vi.hoisted(() => ({ fetchAnalytics: vi.fn() }));
vi.mock("./analyticsRequest", async importOriginal => ({
  ...(await importOriginal<typeof import("./analyticsRequest")>()),
  fetchAnalytics: mocks.fetchAnalytics,
}));

let queryClient: QueryClient;
const wrapper = ({ children }: PropsWithChildren) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

beforeEach(() => {
  mocks.fetchAnalytics.mockReset().mockImplementation(() => new Promise(() => {}));
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useStore.setState({ ...useStore.getInitialState(), timezone: "UTC" });
  setPrivateKeyResolver(() => useStore.getState().privateKey);
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  setPrivateKeyResolver(() => null);
});

describe("analytics placeholder isolation", () => {
  it("does not mistake an identified user id in the prefix for the new site scope", async () => {
    mocks.fetchAnalytics.mockResolvedValueOnce({ label: "site-one-user" });
    const { result, rerender } = renderHook(
      ({ site }) =>
        useAnalyticsQuery<{ label: string }>({
          key: ["user-info", "2"],
          path: "user-info/2",
          site,
          useTime: false,
        }),
      { initialProps: { site: "1" }, wrapper }
    );
    await waitFor(() => expect(result.current.data?.label).toBe("site-one-user"));

    rerender({ site: "2" });
    expect(result.current.data).toBeUndefined();
    expect(result.current.isPlaceholderData).toBe(false);
  });

  it("keeps same-site data while a filter changes", async () => {
    mocks.fetchAnalytics.mockResolvedValueOnce({ count: 12 });
    const { result } = renderHook(
      () => useAnalyticsQuery<{ count: number }>({ key: "overview", path: "overview", site: "1" }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.data).toEqual({ count: 12 }));
    act(() => useStore.getState().setFilters([{ parameter: "country", type: "equals", value: ["PL"] }]));
    expect(result.current.data).toEqual({ count: 12 });
    expect(result.current.isPlaceholderData).toBe(true);
  });

  it.each(["invalid-key", "replacement-key", null])(
    "does not reuse cached private data after changing access to %s",
    async privateKey => {
      useStore.getState().setPrivateKey("original-secret");
      mocks.fetchAnalytics.mockResolvedValueOnce({ secret: 12 });
      const { result } = renderHook(
        () => useAnalyticsQuery<{ secret: number }>({ key: "overview", path: "overview", site: "1" }),
        { wrapper }
      );
      await waitFor(() => expect(result.current.data).toEqual({ secret: 12 }));
      act(() => useStore.getState().setPrivateKey(privateKey));
      expect(result.current.data).toBeUndefined();
      expect(result.current.isPlaceholderData).toBe(false);
      await waitFor(() => expect(mocks.fetchAnalytics).toHaveBeenCalledTimes(2));
      expect(mocks.fetchAnalytics.mock.calls[1][1].privateKey).toBe(privateKey);
      const keys = JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map(query => query.queryKey)
      );
      expect(keys).not.toContain("original-secret");
      if (privateKey) expect(keys).not.toContain(privateKey);
    }
  );

  it("does not reuse public data when opening a private link for the same site", async () => {
    mocks.fetchAnalytics.mockResolvedValueOnce({ count: 4 });
    const { result } = renderHook(
      () => useAnalyticsQuery<{ count: number }>({ key: "overview", path: "overview", site: "1" }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.data).toEqual({ count: 4 }));
    act(() => useStore.getState().setPrivateKey("new-secret"));
    expect(result.current.data).toBeUndefined();
    expect(result.current.isPlaceholderData).toBe(false);
  });

  it("keeps a late private response in its old cache without updating the replacement query", async () => {
    let resolveOld!: (data: { secret: number }) => void;
    useStore.getState().setPrivateKey("original-secret");
    mocks.fetchAnalytics.mockReturnValueOnce(new Promise(resolve => (resolveOld = resolve)));
    const { result } = renderHook(
      () => useAnalyticsQuery<{ secret: number }>({ key: "overview", path: "overview", site: "1" }),
      { wrapper }
    );
    act(() => useStore.getState().setPrivateKey("replacement-secret"));
    await act(async () => resolveOld({ secret: 12 }));
    expect(result.current.data).toBeUndefined();
    expect(
      queryClient
        .getQueryCache()
        .getAll()
        .map(query => query.state.data)
    ).toContainEqual({ secret: 12 });
  });

  it("partitions infinite query pages when a private key changes", async () => {
    useStore.getState().setPrivateKey("original-secret");
    mocks.fetchAnalytics.mockResolvedValueOnce([{ secret: 12 }]);
    const { result } = renderHook(
      () =>
        useAnalyticsInfiniteQuery<{ secret: number }[], number>({
          key: "sessions-infinite",
          path: "sessions",
          site: "1",
          initialPageParam: 1,
          pageParams: page => ({ page }),
          getNextPageParam: () => undefined,
        }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.data?.pages).toEqual([[{ secret: 12 }]]));
    act(() => useStore.getState().setPrivateKey("invalid-secret"));
    expect(result.current.data).toBeUndefined();
  });

  it("aborts the old credential's abortable fan-out before a replacement starts", async () => {
    useStore.getState().setPrivateKey("original-secret");
    renderHook(
      () =>
        useAnalyticsInfiniteQuery<unknown[], number>({
          key: "sessions-infinite",
          path: "sessions",
          site: "1",
          initialPageParam: 1,
          pageParams: page => ({ page }),
          getNextPageParam: () => undefined,
          abortable: true,
        }),
      { wrapper }
    );
    await waitFor(() => expect(mocks.fetchAnalytics).toHaveBeenCalledOnce());
    const originalSignal = mocks.fetchAnalytics.mock.calls[0][2] as AbortSignal;
    expect(originalSignal.aborted).toBe(false);
    act(() => useStore.getState().setPrivateKey("replacement-secret"));
    await waitFor(() => expect(mocks.fetchAnalytics).toHaveBeenCalledTimes(2));
    expect(originalSignal.aborted).toBe(true);
    const replacementSignal = mocks.fetchAnalytics.mock.calls[1][2] as AbortSignal;
    expect(replacementSignal.aborted).toBe(false);
  });
});

describe("real profile consumers with custom placeholder policies", () => {
  const privateData = { sessions: 12, name: "private-user" };

  function useProfile(site: number, userId: string) {
    return { summary: useUserSummary(userId), info: useUserInfo(site, userId) };
  }

  it.each(["credential", "site"])("does not retain the same user's profile after changing %s", async changed => {
    useStore.setState({ site: "7", privateKey: "valid-secret" });
    mocks.fetchAnalytics.mockResolvedValueOnce(privateData).mockResolvedValueOnce(privateData);
    const { result, rerender } = renderHook(({ site, userId }) => useProfile(site, userId), {
      initialProps: { site: 7, userId: "same-user" },
      wrapper,
    });
    await waitFor(() => {
      expect(result.current.summary.data).toEqual(privateData);
      expect(result.current.info.data).toEqual(privateData);
    });
    if (changed === "credential") act(() => useStore.getState().setPrivateKey("invalid-secret"));
    else {
      act(() => useStore.setState({ site: "8" }));
      rerender({ site: 8, userId: "same-user" });
    }
    expect(result.current.summary.data).toBeUndefined();
    expect(result.current.info.data).toBeUndefined();
    expect(result.current.summary.isPlaceholderData).toBe(false);
    expect(result.current.info.isPlaceholderData).toBe(false);
  });

  it("keeps the caller's narrower same-user date-refresh policy without carrying it to another user", async () => {
    useStore.setState({ site: "7", privateKey: "valid-secret" });
    mocks.fetchAnalytics.mockResolvedValueOnce(privateData).mockResolvedValueOnce(privateData);
    const { result, rerender } = renderHook(({ userId }) => useProfile(7, userId), {
      initialProps: { userId: "same-user" },
      wrapper,
    });
    await waitFor(() => {
      expect(result.current.summary.data).toEqual(privateData);
      expect(result.current.info.data).toEqual(privateData);
    });
    act(() => useStore.getState().setTime({ mode: "day", day: "2026-10-23" }));
    expect(result.current.summary.data).toEqual(privateData);
    expect(result.current.info.data).toEqual(privateData);
    expect(result.current.summary.isPlaceholderData).toBe(true);
    expect(result.current.info.isPlaceholderData).toBe(true);
    rerender({ userId: "another-user" });
    expect(result.current.summary.data).toBeUndefined();
    expect(result.current.info.data).toBeUndefined();
  });
});
