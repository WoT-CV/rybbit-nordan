import React, { useEffect, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  pathname: "/2/replay",
  hideSidebar: false,
  replace: vi.fn(),
  setSiteContext: vi.fn(),
  mounted: vi.fn(),
  unmounted: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
  useRouter: () => ({ replace: state.replace }),
}));
vi.mock("@/lib/store", () => ({
  useStore: () => ({ site: "2", privateKey: undefined, setSiteContext: state.setSiteContext }),
}));
vi.mock("@/lib/urlParams", () => ({ useSyncStateWithUrl: () => {} }));
vi.mock("./utils", () => ({ useEmbedPageOptions: () => ({ embed: false, hideSidebar: state.hideSidebar }) }));
vi.mock("@/components/AppSidebar", () => ({ AppSidebar: () => <nav>App navigation</nav> }));
vi.mock("./components/Sidebar/Sidebar", () => ({ Sidebar: () => <nav>Site navigation</nav> }));
vi.mock("./components/Header/Header", () => ({ Header: () => <header>Site header</header> }));
vi.mock("../components/Footer", () => ({ Footer: () => <footer>Site footer</footer> }));

import SiteLayout from "./layout";

function ReplayProbe() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    state.mounted();
    return () => state.unmounted();
  }, []);
  return (
    <div>
      <button onClick={() => setOpen(true)}>Open replay</button>
      {open && <span>Replay remains open</span>}
    </div>
  );
}

function resize(width: number) {
  act(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    window.dispatchEvent(new Event("resize"));
  });
}

describe("site layout replay state across orientation changes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.pathname = "/2/replay";
    state.hideSidebar = false;
    resize(390);
  });
  afterEach(cleanup);

  it("does not remount the route or close an opened replay across the mobile breakpoint", () => {
    render(
      <SiteLayout>
        <ReplayProbe />
      </SiteLayout>
    );
    fireEvent.click(screen.getByRole("button", { name: "Open replay" }));
    expect(screen.getByText("Replay remains open")).toBeTruthy();
    for (const width of [844, 390, 1280, 390]) {
      resize(width);
      expect(screen.getByText("Replay remains open")).toBeTruthy();
    }
    expect(state.mounted).toHaveBeenCalledTimes(1);
    expect(state.unmounted).not.toHaveBeenCalled();
    expect(screen.getAllByText("Site header")).toHaveLength(1);
  });

  it("preserves the private-link site context and embed redirect policy", () => {
    state.pathname = "/2/aaaaaaaaaaaa/replay";
    state.hideSidebar = true;
    render(
      <SiteLayout>
        <ReplayProbe />
      </SiteLayout>
    );
    expect(state.setSiteContext).toHaveBeenCalledWith("2", "aaaaaaaaaaaa");
    expect(state.replace).toHaveBeenCalledWith("/2/aaaaaaaaaaaa/main");
    expect(screen.queryByText("Site navigation")).toBeNull();
  });
});
