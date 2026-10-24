import { act, cleanup, renderHook } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import useMediaQuery from "./useMediaQuery";

const listeners = new Map<string, Set<() => void>>();
const matches = new Map<string, boolean>();

beforeEach(() => {
  listeners.clear();
  matches.clear();
  vi.stubGlobal("matchMedia", (query: string) => {
    const subscribers = listeners.get(query) ?? new Set<() => void>();
    listeners.set(query, subscribers);
    // Deliberately model a captured snapshot. A resize handler must re-read
    // matchMedia, not trust an old unsubscribed MediaQueryList indefinitely.
    return {
      matches: matches.get(query) ?? false,
      addEventListener: (_: string, listener: () => void) => subscribers.add(listener),
      removeEventListener: (_: string, listener: () => void) => subscribers.delete(listener),
    };
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useMediaQuery browser subscription", () => {
  it("renders a stable unknown SSR snapshot without calling browser APIs", () => {
    vi.stubGlobal("matchMedia", () => {
      throw new Error("SSR must not read window.matchMedia");
    });
    function Probe() {
      return <span>{String(useMediaQuery("(max-width: 767px)"))}</span>;
    }
    expect(renderToString(<Probe />)).toBe("<span>null</span>");
  });

  it("updates on a media change even when window resize is not dispatched", () => {
    const query = "(max-width: 767px)";
    matches.set(query, true);
    const { result } = renderHook(() => useMediaQuery(query));
    expect(result.current).toBe(true);
    act(() => {
      matches.set(query, false);
      for (const listener of listeners.get(query) ?? []) listener();
    });
    expect(result.current).toBe(false);
  });

  it("re-reads current matches on resize instead of a captured media object", () => {
    const query = "(max-width: 767px)";
    matches.set(query, true);
    const { result } = renderHook(() => useMediaQuery(query));
    act(() => {
      matches.set(query, false);
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current).toBe(false);
  });

  it("replaces the subscription when query changes and releases it on unmount", () => {
    matches.set("wide", true);
    const { result, rerender, unmount } = renderHook(({ query }) => useMediaQuery(query), {
      initialProps: { query: "wide" },
    });
    expect(result.current).toBe(true);
    rerender({ query: "narrow" });
    expect(result.current).toBe(false);
    expect(listeners.get("wide")?.size ?? 0).toBe(0);
    expect(listeners.get("narrow")?.size).toBe(1);
    unmount();
    expect(listeners.get("narrow")?.size).toBe(0);
  });
});
