import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplayPlayerAdapter } from "@/components/replay/player/ReplayPlayerAdapter";
import { useReplayStore } from "@/components/replay/replayStore";

const mocks = vi.hoisted(() => ({ mutateAsync: vi.fn(), site: "42" }));
vi.mock("next-intl", () => ({ useExtracted: () => (message: string) => message }));
vi.mock("@/lib/store", () => ({ getTimezone: () => "UTC", useStore: { getState: () => ({ site: mocks.site }) } }));
vi.mock("@/hooks/useDateTimeFormat", () => ({ useDateTimeFormat: () => ({ formatRelative: () => "today" }) }));
vi.mock("@/hooks/usePermissions", () => ({ useCanOnSite: () => true }));
vi.mock("@/api/analytics/hooks/sessionReplay/useDeleteSessionReplay", () => ({
  useDeleteSessionReplay: () => ({ mutateAsync: mocks.mutateAsync, isPending: false }),
}));
vi.mock("@/components/Avatar", () => ({ Avatar: () => null }));
vi.mock("@/components/IdentifiedBadge", () => ({ IdentifiedBadge: () => null }));
vi.mock("@/components/TooltipIcons/TooltipIcons", () => ({
  BrowserTooltipIcon: () => null,
  CountryFlagTooltipIcon: () => null,
  DeviceTypeTooltipIcon: () => null,
  OperatingSystemTooltipIcon: () => null,
}));

import { ReplayCard } from "./ReplayCard";

const replay = {
  session_id: "deleted",
  user_id: "user",
  identified_user_id: "",
  traits: null,
  start_time: "2026-10-24 10:00:00",
  page_url: "https://example.com/",
  event_count: 3,
  country: "PL",
  region: "",
  city: "",
  browser: "Safari",
  browser_version: "26",
  operating_system: "iOS",
  operating_system_version: "26",
  device_type: "mobile",
  screen_width: 390,
  screen_height: 844,
};

async function confirmDelete() {
  fireEvent.click(screen.getByRole("button", { name: "Delete Session Replay" }));
  const confirm = await screen.findByRole("button", { name: "Delete" });
  await act(async () => fireEvent.click(confirm));
}

beforeEach(() => {
  useReplayStore.setState(useReplayStore.getInitialState(), true);
  mocks.mutateAsync.mockReset();
  mocks.site = "42";
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ReplayCard deletion ownership", () => {
  it("clears a successfully deleted selection, including the last replay", async () => {
    useReplayStore.getState().selectSession("deleted", true);
    const player = { pause: vi.fn() } as unknown as ReplayPlayerAdapter;
    useReplayStore.getState().setPlayer(player);
    mocks.mutateAsync.mockResolvedValue(undefined);
    render(<ReplayCard replay={replay} />);
    await confirmDelete();
    expect(mocks.mutateAsync).toHaveBeenCalledWith({ sessionId: "deleted" });
    expect(player.pause).toHaveBeenCalledOnce();
    expect(useReplayStore.getState()).toMatchObject({ sessionId: "", player: null, autoplayRequest: null });
  });

  it("does not clear a newer selection made while deletion is pending", async () => {
    let finishDelete!: () => void;
    mocks.mutateAsync.mockReturnValue(
      new Promise<void>(resolve => {
        finishDelete = resolve;
      })
    );
    useReplayStore.getState().selectSession("deleted", false);
    render(<ReplayCard replay={replay} />);
    await confirmDelete();
    act(() => useReplayStore.getState().selectSession("chosen", true));
    await act(async () => finishDelete());
    expect(useReplayStore.getState().sessionId).toBe("chosen");
    expect(useReplayStore.getState().autoplayRequest?.sessionId).toBe("chosen");
  });

  it("does not disturb playback when a non-selected replay is deleted", async () => {
    useReplayStore.getState().selectSession("chosen", true);
    const player = { pause: vi.fn() } as unknown as ReplayPlayerAdapter;
    useReplayStore.getState().setPlayer(player);
    mocks.mutateAsync.mockResolvedValue(undefined);
    render(<ReplayCard replay={replay} />);
    await confirmDelete();
    expect(useReplayStore.getState().sessionId).toBe("chosen");
    expect(useReplayStore.getState().player).toBe(player);
    expect(player.pause).not.toHaveBeenCalled();
  });

  it("does not clear a different site's selection when an older delete finishes", async () => {
    let finishDelete!: () => void;
    mocks.mutateAsync.mockReturnValue(
      new Promise<void>(resolve => {
        finishDelete = resolve;
      })
    );
    useReplayStore.getState().selectSession("deleted", false);
    render(<ReplayCard replay={replay} />);
    await confirmDelete();
    mocks.site = "84";
    const nextSitePlayer = { pause: vi.fn() } as unknown as ReplayPlayerAdapter;
    act(() => useReplayStore.getState().setPlayer(nextSitePlayer));
    await act(async () => finishDelete());
    expect(useReplayStore.getState()).toMatchObject({ sessionId: "deleted", player: nextSitePlayer });
    expect(nextSitePlayer.pause).not.toHaveBeenCalled();
  });

  it("retains the selected replay when the delete request fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    useReplayStore.getState().selectSession("deleted", true);
    mocks.mutateAsync.mockRejectedValue(new Error("delete failed"));
    render(<ReplayCard replay={replay} />);
    await confirmDelete();
    expect(useReplayStore.getState().sessionId).toBe("deleted");
  });

  it("does not select the card when the delete button receives keyboard activation", () => {
    useReplayStore.getState().selectSession("chosen", false);
    render(<ReplayCard replay={replay} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Delete Session Replay" }), { key: "Enter" });
    expect(useReplayStore.getState().sessionId).toBe("chosen");
  });
});
