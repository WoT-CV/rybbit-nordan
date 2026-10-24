import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useStore } from "../../../lib/store";
import { setPrivateKeyResolver } from "../../requestContext";
import { useGetSite, useSiteHasData } from "./useSites";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../../utils", async importOriginal => ({
  ...(await importOriginal<typeof import("../../utils")>()),
  authedFetch: mocks.fetch,
}));

let client: QueryClient;
const wrapper = ({ children }: PropsWithChildren) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useStore.setState({ ...useStore.getInitialState(), site: "7", privateKey: "valid-secret" });
  setPrivateKeyResolver(() => useStore.getState().privateKey);
  mocks.fetch.mockReset().mockImplementation((path: string) => {
    if (useStore.getState().privateKey !== "valid-secret") return new Promise(() => {});
    return Promise.resolve(
      path.endsWith("/has-data") ? { hasData: true } : { name: "private-site", permissions: ["replay:read"] }
    );
  });
});
afterEach(() => {
  cleanup();
  client.clear();
  setPrivateKeyResolver(() => null);
});

describe("site metadata credential isolation", () => {
  it.each(["invalid-secret", null])(
    "does not reuse site details or has-data after changing access to %s",
    async privateKey => {
      const { result } = renderHook(() => ({ site: useGetSite("7"), hasData: useSiteHasData("7") }), { wrapper });
      await waitFor(() => {
        expect(result.current.site.data?.name).toBe("private-site");
        expect(result.current.hasData.data).toBe(true);
      });
      act(() => useStore.getState().setPrivateKey(privateKey));
      expect(result.current.site.data).toBeUndefined();
      expect(result.current.hasData.data).toBeUndefined();
      await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(4));
      const keys = JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map(query => query.queryKey)
      );
      expect(keys).not.toContain("secret");
    }
  );

  it("keeps a delayed metadata/has-data refetch bound to its original credentials", async () => {
    renderHook(() => ({ site: useGetSite("7"), hasData: useSiteHasData("7") }), { wrapper });
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
    const originalQueries = client.getQueryCache().getAll();
    act(() => useStore.getState().setPrivateKey("replacement-secret"));
    mocks.fetch.mockResolvedValue({ hasData: true });
    for (const query of originalQueries) {
      await act(async () => {
        await query.fetch();
      });
      expect(mocks.fetch.mock.lastCall?.[2]).toEqual({ requestPrivateKey: "valid-secret" });
    }
  });
});
