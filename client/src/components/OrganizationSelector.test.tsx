import { act, cleanup, waitFor } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ ready: false }));
vi.mock("next-intl", () => ({ useExtracted: () => (message: string) => message }));
vi.mock("../lib/auth", () => ({
  authClient: {
    useActiveOrganization: () => ({ data: state.ready ? { id: "org-1" } : null, isPending: !state.ready }),
    organization: { setActive: vi.fn() },
  },
}));
vi.mock("../api/admin/hooks/useOrganizations", () => ({
  useUserOrganizations: () => ({
    data: state.ready ? [{ id: "org-1", name: "Synthetic QA" }] : undefined,
    isLoading: !state.ready,
  }),
}));

import { OrganizationSelector } from "./OrganizationSelector";

afterEach(() => {
  cleanup();
  state.ready = false;
});

it("hydrates the loading selector when the active organization resolves before hydration", async () => {
  const container = document.createElement("div");
  container.innerHTML = renderToString(<OrganizationSelector />);
  expect(container.textContent).toContain("Loading...");
  document.body.append(container);

  state.ready = true;
  const onRecoverableError = vi.fn();
  let root: ReturnType<typeof hydrateRoot> | undefined;
  try {
    await act(async () => {
      root = hydrateRoot(container, <OrganizationSelector />, { onRecoverableError });
    });
    expect(onRecoverableError).not.toHaveBeenCalled();
    await waitFor(() => expect(container.querySelector("button")?.textContent).toContain("Synthetic QA"));
  } finally {
    await act(async () => root?.unmount());
    container.remove();
  }
});
