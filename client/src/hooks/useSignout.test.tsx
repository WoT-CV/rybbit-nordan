import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), signOut: vi.fn(), push: vi.fn(), toastError: vi.fn() }));
vi.mock("@/lib/auth", () => ({ authClient: { getSession: mocks.getSession, signOut: mocks.signOut } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("next-intl", () => ({ useExtracted: () => (message: string) => message }));
vi.mock("@/components/ui/sonner", () => ({ toast: { error: mocks.toastError } }));
const user = {
  id: "old-user",
  name: "User",
  email: "qa@example.test",
  emailVerified: true,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};
let client: QueryClient;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  client = new QueryClient();
  client.setQueryData(["private-user-data"], { secret: "synthetic" });
  mocks.getSession.mockReturnValue(new Promise(() => {}));
});
afterEach(() => {
  cleanup();
  client.clear();
});

describe("confirmed native logout", () => {
  it.each(["resolve", "reject"])(
    "clears state/cache and navigates only after success; late bootstrap %s cannot restore identity",
    async outcome => {
      const bootstrap = deferred<{ data: { user: typeof user } }>();
      const logout = deferred<{ data: { success: true }; error: null }>();
      mocks.getSession.mockReturnValue(bootstrap.promise);
      mocks.signOut.mockReturnValue(logout.promise);
      const { useSignout } = await import("./useSignout");
      const { userStore } = await import("@/lib/userStore");
      const { result } = renderHook(() => useSignout(), { wrapper });
      await waitFor(() => expect(mocks.getSession).toHaveBeenCalledOnce());
      let completion!: Promise<boolean>;
      act(() => {
        completion = result.current();
      });
      expect(userStore.getState().isPending).toBe(true);
      expect(client.getQueryData(["private-user-data"])).toEqual({ secret: "synthetic" });
      expect(mocks.push).not.toHaveBeenCalled();
      await act(async () => {
        logout.resolve({ data: { success: true }, error: null });
        expect(await completion).toBe(true);
      });
      expect(userStore.getState()).toMatchObject({ user: null, isPending: false });
      expect(client.getQueryData(["private-user-data"])).toBeUndefined();
      expect(mocks.push).toHaveBeenCalledExactlyOnceWith("/login");
      await act(async () => {
        if (outcome === "resolve") bootstrap.resolve({ data: { user } });
        else bootstrap.reject(new Error("late failure"));
        await new Promise(resolve => setTimeout(resolve, 0));
      });
      expect(userStore.getState()).toMatchObject({ user: null, isPending: false });
      expect(mocks.toastError).not.toHaveBeenCalled();
    }
  );
  it.each(["returned error", "rejection", "unconfirmed response"])(
    "retains identity/cache/navigation on %s",
    async outcome => {
      const { useSignout } = await import("./useSignout");
      const { userStore } = await import("@/lib/userStore");
      userStore.getState().setSession(user);
      const prior = userStore.getState();
      if (outcome === "rejection") mocks.signOut.mockRejectedValue(new Error("offline"));
      else
        mocks.signOut.mockResolvedValue(
          outcome === "returned error"
            ? { data: null, error: { message: "Denied" } }
            : { data: { success: false }, error: null }
        );
      const callback = vi.fn();
      const { result } = renderHook(() => useSignout(callback), { wrapper });
      await act(async () => expect(await result.current()).toBe(false));
      expect(userStore.getState()).toBe(prior);
      expect(client.getQueryData(["private-user-data"])).toEqual({ secret: "synthetic" });
      expect(mocks.push).not.toHaveBeenCalled();
      expect(callback).not.toHaveBeenCalled();
      expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith("An error occurred. Please try again later.");
    }
  );
  it("settles an existing session before the caller's transfer reload callback", async () => {
    mocks.signOut.mockResolvedValue({ data: { success: true }, error: null });
    const { useSignout } = await import("./useSignout");
    const { userStore } = await import("@/lib/userStore");
    userStore.getState().setSession(user);
    const callback = vi.fn(() => {
      expect(userStore.getState()).toMatchObject({ user: null, isPending: false });
      expect(client.getQueryCache().getAll()).toHaveLength(0);
    });
    const { result } = renderHook(() => useSignout(callback), { wrapper });
    await act(async () => expect(await result.current()).toBe(true));
    expect(callback).toHaveBeenCalledOnce();
    expect(mocks.push).not.toHaveBeenCalled();
  });
});
