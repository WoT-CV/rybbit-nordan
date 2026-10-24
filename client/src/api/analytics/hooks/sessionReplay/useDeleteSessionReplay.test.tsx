import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ deleteReplay: vi.fn() }));
vi.mock("@/lib/store", () => ({ useStore: () => ({ site: 42 }) }));
vi.mock("@/api/analytics/endpoints", () => ({ deleteSessionReplay: mocks.deleteReplay }));

import { useDeleteSessionReplay } from "./useDeleteSessionReplay";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useDeleteSessionReplay", () => {
  it("keeps deletion pending until the same-site replay list finishes invalidation", async () => {
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    let finishRefetch!: () => void;
    const refetch = new Promise<void>(resolve => {
      finishRefetch = resolve;
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockReturnValue(refetch);
    mocks.deleteReplay.mockResolvedValue(undefined);
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(useDeleteSessionReplay, { wrapper });
    let finished = false;
    let deletion!: Promise<unknown>;
    act(() => {
      deletion = result.current.mutateAsync({ sessionId: "deleted" }).then(() => {
        finished = true;
      });
    });
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["session-replays", 42] }));
    expect(mocks.deleteReplay).toHaveBeenCalledWith(42, "deleted");
    expect(finished).toBe(false);
    expect(result.current.isPending).toBe(true);
    await act(async () => {
      finishRefetch();
      await deletion;
    });
    expect(finished).toBe(true);
    queryClient.clear();
  });

  it("does not invalidate the list when deletion fails", async () => {
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    mocks.deleteReplay.mockRejectedValue(new Error("delete failed"));
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(useDeleteSessionReplay, { wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync({ sessionId: "kept" })).rejects.toThrow("delete failed");
    });
    expect(invalidate).not.toHaveBeenCalled();
    queryClient.clear();
  });
});
