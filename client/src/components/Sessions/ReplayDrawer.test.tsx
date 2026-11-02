import React, { useEffect } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplayDrawer } from "./ReplayDrawer";

const state = vi.hoisted(() => ({ setSessionId: vi.fn(), mounts: 0, unmounts: 0, desktop: false }));

vi.mock("next-intl", () => ({ useExtracted: () => (text: string) => text }));
vi.mock("@/components/replay/replayStore", () => ({
  useReplayStore: (selector: (store: { setSessionId: typeof state.setSessionId }) => unknown) =>
    selector({ setSessionId: state.setSessionId }),
}));
vi.mock("@/components/replay/ReplayBreadcrumbs", () => ({
  ReplayBreadcrumbs: () => <div data-testid="timeline">Key timeline</div>,
}));
vi.mock("@/components/replay/player/ReplayPlayer", () => ({
  ReplayPlayer: () => {
    useEffect(() => {
      state.mounts++;
      return () => {
        state.unmounts++;
      };
    }, []);
    return <div data-testid="native-player">Native player</div>;
  },
}));
vi.mock("@/components/ui/drawer", () => ({
  Drawer: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DrawerContent: ({
    children,
    onEscapeKeyDown,
  }: {
    children: React.ReactNode;
    onEscapeKeyDown: (event: React.KeyboardEvent) => void;
  }) => <div onKeyDown={event => event.key === "Escape" && onEscapeKeyDown(event)}>{children}</div>,
}));

beforeEach(() => {
  state.mounts = 0;
  state.unmounts = 0;
  state.desktop = false;
  state.setSessionId.mockClear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
  vi.stubGlobal("matchMedia", () => ({ matches: state.desktop }));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 390,
    height: 600,
    top: 0,
    left: 0,
    bottom: 600,
    right: 390,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ReplayDrawer mobile timeline", () => {
  it("shares one timeline pane and preserves the mounted native player across toggles", async () => {
    render(<ReplayDrawer sessionId="session-a" open onOpenChange={vi.fn()} />);
    await waitFor(() => expect(screen.queryByTestId("native-player")).not.toBeNull());
    const player = screen.getByTestId("native-player");
    const toggle = screen.getByRole("button", { name: "Timeline" });
    const pane = screen.getByRole("region", { name: "Timeline" });
    expect(toggle.getAttribute("aria-controls")).toBe(pane.id);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(pane.className).toContain("hidden");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(pane.className).not.toContain("hidden");
    expect(player.parentElement?.className).toContain("invisible");
    fireEvent.click(toggle);
    expect(screen.getByTestId("native-player")).toBe(player);
    expect(player.parentElement?.className).not.toContain("invisible");
    expect(screen.getAllByTestId("timeline")).toHaveLength(1);
    expect(state.mounts).toBe(1);
    expect(state.unmounts).toBe(0);
    expect(state.setSessionId.mock.calls).toEqual([["session-a"]]);
  });

  it("Escape returns from the mobile timeline without dismissing the drawer or changing the session", async () => {
    const onOpenChange = vi.fn();
    render(<ReplayDrawer sessionId="session-a" open onOpenChange={onOpenChange} />);
    await waitFor(() => expect(state.mounts).toBe(1));
    const toggle = screen.getByRole("button", { name: "Timeline" });
    fireEvent.click(toggle);
    const notPrevented = fireEvent.keyDown(screen.getByTestId("timeline"), { key: "Escape", cancelable: true });
    expect(notPrevented).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(state.unmounts).toBe(0);
    expect(state.setSessionId).toHaveBeenCalledTimes(1);
  });

  it("does not intercept normal drawer Escape on desktop", () => {
    state.desktop = true;
    render(<ReplayDrawer sessionId="session-a" open onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Timeline" }));
    expect(fireEvent.keyDown(screen.getByTestId("timeline"), { key: "Escape", cancelable: true })).toBe(true);
  });

  it("does not send timeline controls' Space and arrow keys to document playback shortcuts", () => {
    render(<ReplayDrawer sessionId="session-a" open onOpenChange={vi.fn()} />);
    const playbackShortcut = vi.fn();
    document.addEventListener("keydown", playbackShortcut);
    try {
      expect(fireEvent.keyDown(screen.getByRole("button", { name: "Timeline" }), { key: " " })).toBe(true);
      expect(fireEvent.keyDown(screen.getByTestId("timeline"), { key: "ArrowRight" })).toBe(true);
      expect(playbackShortcut).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", playbackShortcut);
    }
  });
});
