import { act } from "@testing-library/react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ signedIn: false, pathname: "/2/replay" }));
vi.mock("@/lib/auth", () => ({
  authClient: { useSession: () => ({ data: mocks.signedIn ? { user: { id: "cached-user" } } : null }) },
}));
vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname }));
vi.mock("next-intl", () => ({ useExtracted: () => (message: string) => message }));

import { CommandPaletteTrigger } from "./CommandPaletteTrigger";

const mounted: { root: Root; container: HTMLDivElement }[] = [];

beforeEach(() => {
  mocks.signedIn = false;
  mocks.pathname = "/2/replay";
});
afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
});

async function hydrateCachedSession() {
  const container = document.createElement("div");
  container.innerHTML = renderToString(<CommandPaletteTrigger />);
  document.body.append(container);
  // Better Auth can fill its browser cache before a streamed sidebar hydrates.
  mocks.signedIn = true;
  const onRecoverableError = vi.fn();
  await act(async () => {
    const root = hydrateRoot(container, <CommandPaletteTrigger />, { onRecoverableError });
    mounted.push({ root, container });
  });
  return { container, onRecoverableError };
}

describe("command palette availability during hydration", () => {
  it("hydrates server-anonymous markup after a fast cached sign-in without adding a mismatched button", async () => {
    const { container, onRecoverableError } = await hydrateCachedSession();
    expect(container.querySelector("button")?.textContent).toContain("Search");
    expect(onRecoverableError).not.toHaveBeenCalled();
  });

  it("keeps private-link visitors excluded after the same cached session hydration", async () => {
    mocks.pathname = "/2/aaaaaaaaaaaa/replay";
    const { container, onRecoverableError } = await hydrateCachedSession();
    expect(container.querySelector("button")).toBeNull();
    expect(onRecoverableError).not.toHaveBeenCalled();
  });
});
