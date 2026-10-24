import { act, cleanup, render } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReplayStore } from "@/components/replay/replayStore";
import { useStore } from "@/lib/store";

const mocks = vi.hoisted(() => ({
  data: undefined as { pages: { data: { session_id: string }[]; totalCount: number }[] } | undefined,
  isLoading: false,
  isFetching: false,
  error: null as Error | null,
  routeSite: "42",
}));
vi.mock("next-intl", () => ({ useExtracted: () => (message: string) => message }));
vi.mock("next/navigation", () => ({ useParams: () => ({ site: mocks.routeSite }) }));
vi.mock("@uidotdev/usehooks", () => ({ useIntersectionObserver: () => [() => {}, { isIntersecting: false }] }));
vi.mock("@/api/analytics/hooks/sessionReplay/useGetSessionReplays", () => ({
  useGetSessionReplays: () => ({ ...mocks, fetchNextPage: () => {}, hasNextPage: false, isFetchingNextPage: false }),
}));
vi.mock("@/components/NothingFound", () => ({ NothingFound: () => null }));
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: PropsWithChildren) => <div>{children}</div>,
}));
vi.mock("./ReplayCard", () => ({ ReplayCard: () => null, ReplayCardSkeleton: () => null }));

import { ReplayList } from "./ReplayList";

function sessions(...ids: string[]) {
  return { pages: [{ data: ids.map(session_id => ({ session_id })), totalCount: ids.length }] };
}

beforeEach(() => {
  useReplayStore.setState(useReplayStore.getInitialState(), true);
  useStore.setState({ site: "42" });
  mocks.data = undefined;
  mocks.isLoading = false;
  mocks.isFetching = false;
  mocks.error = null;
  mocks.routeSite = "42";
});
afterEach(cleanup);

describe("ReplayList selection after deletion and refetch", () => {
  it("selects another replay only after a fresh list no longer contains the deleted selection", () => {
    mocks.data = sessions("deleted", "next");
    useReplayStore.getState().selectSession("deleted", false);
    const view = render(<ReplayList />);
    mocks.isFetching = true;
    view.rerender(<ReplayList />);
    expect(useReplayStore.getState().sessionId).toBe("deleted");
    mocks.data = sessions("next");
    view.rerender(<ReplayList />);
    expect(useReplayStore.getState().sessionId).toBe("deleted");
    mocks.isFetching = false;
    view.rerender(<ReplayList />);
    expect(useReplayStore.getState().sessionId).toBe("next");
    expect(useReplayStore.getState().autoplayRequest).toBeNull();
  });

  it("clears the last deleted selection when the refreshed list is empty", () => {
    mocks.data = sessions("last");
    useReplayStore.getState().selectSession("last", false);
    const view = render(<ReplayList />);
    mocks.data = sessions();
    view.rerender(<ReplayList />);
    expect(useReplayStore.getState().sessionId).toBe("");
  });

  it("preserves a newer manual selection made during refetch", () => {
    mocks.data = sessions("deleted", "next", "chosen");
    useReplayStore.getState().selectSession("deleted", false);
    const view = render(<ReplayList />);
    mocks.isFetching = true;
    view.rerender(<ReplayList />);
    act(() => useReplayStore.getState().selectSession("chosen", true));
    mocks.data = sessions("next", "chosen");
    mocks.isFetching = false;
    view.rerender(<ReplayList />);
    expect(useReplayStore.getState().sessionId).toBe("chosen");
    expect(useReplayStore.getState().autoplayRequest?.sessionId).toBe("chosen");
  });

  it("does not replace the selection with stale data while a new site is loading", () => {
    mocks.data = sessions("old-site");
    useReplayStore.getState().selectSession("old-site", false);
    const view = render(<ReplayList />);
    mocks.data = undefined;
    mocks.isLoading = true;
    view.rerender(<ReplayList />);
    act(() => useReplayStore.getState().selectSession("new-site", true));
    expect(useReplayStore.getState().sessionId).toBe("new-site");
    mocks.data = sessions("new-site");
    mocks.isLoading = false;
    view.rerender(<ReplayList />);
    expect(useReplayStore.getState().sessionId).toBe("new-site");
  });

  it("does not reselect a deleted replay from cached data when the list refetch fails", () => {
    mocks.data = sessions("deleted", "next");
    mocks.error = new Error("refetch failed");
    render(<ReplayList />);
    expect(useReplayStore.getState().sessionId).toBe("");
  });

  it("does not select a settled old-site result before the route context has caught up", () => {
    mocks.data = sessions("old-site");
    mocks.routeSite = "84";
    useReplayStore.getState().selectSession("new-site", true);
    const view = render(<ReplayList />);
    expect(useReplayStore.getState().sessionId).toBe("new-site");
    mocks.data = sessions("new-site");
    act(() => useStore.setState({ site: "84" }));
    view.rerender(<ReplayList />);
    expect(useReplayStore.getState().sessionId).toBe("new-site");
    expect(useReplayStore.getState().autoplayRequest?.sessionId).toBe("new-site");
  });
});
