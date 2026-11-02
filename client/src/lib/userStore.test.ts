import { beforeEach, expect, it, vi } from "vitest";

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("./auth", () => ({ authClient: { getSession } }));

beforeEach(() => {
  vi.resetModules();
  getSession.mockReset();
});

it("does not fetch or populate a process-wide browser session during SSR", async () => {
  const { userStore } = await import("./userStore");
  await Promise.resolve();
  expect(getSession).not.toHaveBeenCalled();
  expect(userStore.getState()).toMatchObject({ user: null, isPending: true });
});
