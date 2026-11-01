import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReplayCorrelation } from "./useReplayCorrelation";
import { fetchReplayCorrelationConfig } from "../endpoints/replayCorrelation";

const state = vi.hoisted(() => ({
  session: {
    data: {
      user: { id: "one", role: "member" },
      session: { id: "session-one", activeOrganizationId: "org" },
    } as unknown,
    isPending: false,
  },
  site: { data: { permissions: ["replay:read"] }, isLoading: false },
  path: "/7/replay",
  privateKey: null as string | null,
}));
vi.mock("@/lib/auth", () => ({ authClient: { useSession: () => state.session } }));
vi.mock("./useSites", () => ({ useGetSite: () => state.site }));
vi.mock("next/navigation", () => ({ usePathname: () => state.path }));
vi.mock("@/api/requestContext", () => ({ getRequestPrivateKey: () => state.privateKey }));
vi.mock("../endpoints/replayCorrelation", () => ({ fetchReplayCorrelationConfig: vi.fn() }));
let client: QueryClient;
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  state.session = {
    data: { user: { id: "one", role: "member" }, session: { id: "session-one", activeOrganizationId: "org" } },
    isPending: false,
  };
  state.site = { data: { permissions: ["replay:read"] }, isLoading: false };
  state.path = "/7/replay";
  state.privateKey = null;
  vi.mocked(fetchReplayCorrelationConfig).mockResolvedValue({ enabled: true, profiles: [] });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.resetAllMocks();
});

describe("correlation configuration authorization and cache scope", () => {
  it("does not fetch until opened and masks cached data immediately on close/logout/revocation", async () => {
    const { result, rerender } = renderHook(({ open }) => useReplayCorrelation(7, open), {
      initialProps: { open: false },
      wrapper,
    });
    expect(fetchReplayCorrelationConfig).not.toHaveBeenCalled();
    rerender({ open: true });
    await waitFor(() => expect(result.current.config?.enabled).toBe(true));
    rerender({ open: false });
    expect(result.current.config).toBeUndefined();
    state.site.data.permissions = [];
    rerender({ open: true });
    expect(result.current.authorized).toBe(false);
    expect(result.current.config).toBeUndefined();
    state.site.data.permissions = ["replay:read"];
    state.session.data = null;
    rerender({ open: true });
    expect(result.current.config).toBeUndefined();
    expect(fetchReplayCorrelationConfig).toHaveBeenCalledTimes(1);
  });
  it.each(["route", "context", "pending", "no-permission"])("never fetches in a %s denied context", mode => {
    if (mode === "route") state.path = "/7/abcdef123456/replay";
    if (mode === "context") state.privateKey = "abcdef123456";
    if (mode === "pending") state.session.isPending = true;
    if (mode === "no-permission") state.site.data.permissions = [];
    const { result } = renderHook(() => useReplayCorrelation(7, true), { wrapper });
    expect(result.current.authorized).toBe(false);
    expect(fetchReplayCorrelationConfig).not.toHaveBeenCalled();
  });
  it("isolates site/principal/authorization changes and removes successful links during a 403 revalidation", async () => {
    const { result, rerender } = renderHook(({ siteId }) => useReplayCorrelation(siteId, true), {
      initialProps: { siteId: 7 },
      wrapper,
    });
    await waitFor(() => expect(result.current.config?.enabled).toBe(true));
    let reject!: (reason: Error) => void;
    vi.mocked(fetchReplayCorrelationConfig).mockImplementation(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        })
    );
    act(() => {
      void result.current.refetch();
    });
    await waitFor(() => expect(result.current.config).toBeUndefined());
    await act(async () => reject(Object.assign(new Error("Forbidden"), { status: 403 })));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.config).toBeUndefined();
    state.session.data = {
      user: { id: "two", role: "member" },
      session: { id: "session-two", activeOrganizationId: "other" },
    };
    rerender({ siteId: 8 });
    expect(result.current.config).toBeUndefined();
    expect(result.current.isError).toBe(false);
    expect(
      client
        .getQueryCache()
        .getAll()
        .some(query => query.queryKey.includes("two") && query.queryKey.includes(8))
    ).toBe(true);
  });
  it("revalidates on reopening without exposing the previous configuration while pending", async () => {
    const { result, rerender } = renderHook(({ open }) => useReplayCorrelation(7, open), {
      initialProps: { open: true },
      wrapper,
    });
    await waitFor(() => expect(result.current.config?.enabled).toBe(true));
    rerender({ open: false });
    vi.mocked(fetchReplayCorrelationConfig).mockImplementation(() => new Promise(() => {}));
    rerender({ open: true });
    expect(result.current.config).toBeUndefined();
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(fetchReplayCorrelationConfig).toHaveBeenCalledTimes(2));
  });
});
