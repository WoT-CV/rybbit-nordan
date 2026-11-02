import { beforeEach, expect, it, vi } from "vitest";

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("./auth", () => ({ authClient: { getSession } }));

const user = {
  id: "qa-user",
  name: "Synthetic",
  email: "qa@example.test",
  emailVerified: true,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

beforeEach(() => {
  vi.resetModules();
  getSession.mockReset();
});

it("bootstraps a browser session once", async () => {
  getSession.mockResolvedValue({ data: { user } });
  const { userStore } = await import("./userStore");
  await vi.waitFor(() => expect(userStore.getState()).toMatchObject({ user, isPending: false }));
  await import("./userStore");
  expect(getSession).toHaveBeenCalledTimes(1);
});

it.each([
  ["missing session", () => Promise.resolve({ data: null })],
  ["rejected request", () => Promise.reject(new Error("offline"))],
  [
    "synchronous failure",
    () => {
      throw new Error("unavailable");
    },
  ],
])("finishes pending state with null after %s", async (_label, outcome) => {
  getSession.mockImplementation(outcome);
  const { userStore } = await import("./userStore");
  await vi.waitFor(() => expect(userStore.getState()).toMatchObject({ user: null, isPending: false }));
});

it.each(["login", "logout", "rejected request"])("does not overwrite newer %s state", async kind => {
  let resolve!: (value: { data: { user: typeof user } }) => void;
  let reject!: (error: Error) => void;
  getSession.mockImplementation(
    () =>
      new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      })
  );
  const { userStore } = await import("./userStore");
  await vi.waitFor(() => expect(getSession).toHaveBeenCalledTimes(1));
  const newerUser = kind === "login" ? { ...user, id: "new-session" } : null;
  userStore.setState({ user: newerUser, isPending: false });
  const newerState = userStore.getState();
  if (kind === "rejected request") reject(new Error("late failure"));
  else resolve({ data: { user } });
  await new Promise(res => setTimeout(res, 0));
  expect(userStore.getState()).toBe(newerState);
});

it.each(["resolve", "reject", "setter"])("settles pending after a native user-only update (%s)", async kind => {
  let resolve!: (value: { data: null }) => void;
  let reject!: (error: Error) => void;
  getSession.mockImplementation(
    () =>
      new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      })
  );
  const { userStore } = await import("./userStore");
  await vi.waitFor(() => expect(getSession).toHaveBeenCalledTimes(1));
  if (kind === "setter") userStore.getState().setSession(user);
  else userStore.setState({ user });
  if (kind === "reject") reject(new Error("late failure"));
  else resolve({ data: null });
  await vi.waitFor(() => expect(userStore.getState()).toMatchObject({ user, isPending: false }));
});
