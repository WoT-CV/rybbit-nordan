import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ cloud: false, organizationId: "org-1" as string | undefined }));
const mocks = vi.hoisted(() => ({ authedFetch: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  authClient: { useActiveOrganization: () => ({ data: state.organizationId ? { id: state.organizationId } : null }) },
}));
vi.mock("../const", () => ({
  get IS_CLOUD() {
    return state.cloud;
  },
}));
vi.mock("../../api/utils", () => ({ authedFetch: mocks.authedFetch }));

import { useStripeSubscription } from "./useStripeSubscription";

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  state.cloud = false;
  state.organizationId = "org-1";
  mocks.authedFetch.mockReset();
});
afterEach(cleanup);

describe("subscription availability", () => {
  it("keeps the self-hosted query idle instead of resolving it with undefined", async () => {
    const { result } = renderHook(() => useStripeSubscription(), { wrapper });
    await act(async () => {});
    expect(result.current.fetchStatus).toBe("idle");
    expect(result.current.isError).toBe(false);
    expect(mocks.authedFetch).not.toHaveBeenCalled();
  });

  it("still loads the selected cloud organization's subscription", async () => {
    state.cloud = true;
    mocks.authedFetch.mockResolvedValue({ planName: "pro" });
    const { result } = renderHook(() => useStripeSubscription("org-2"), { wrapper });
    await waitFor(() => expect(result.current.data?.planName).toBe("pro"));
    expect(mocks.authedFetch).toHaveBeenCalledWith("/stripe/subscription?organizationId=org-2");
  });

  it("waits for an organization before loading a cloud subscription", async () => {
    state.cloud = true;
    state.organizationId = undefined;
    const { result } = renderHook(() => useStripeSubscription(), { wrapper });
    await act(async () => {});
    expect(result.current.fetchStatus).toBe("idle");
    expect(mocks.authedFetch).not.toHaveBeenCalled();
  });
});
