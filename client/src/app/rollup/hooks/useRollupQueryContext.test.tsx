import { cleanup, renderHook } from "@testing-library/react";
import type { UseQueryResult } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";

import { useSettledSnapshot } from "./useRollupQueryContext";

afterEach(cleanup);

describe("rollup settled snapshot credential isolation", () => {
  it("keeps a snapshot only while the same credential context refetches", () => {
    const settled = [{ isPending: false, isFetching: false }] as UseQueryResult[];
    const pending = [{ isPending: true, isFetching: true }] as UseQueryResult[];
    const { result, rerender } = renderHook(
      ({ value, queries, accessScope }) => useSettledSnapshot(value, queries, accessScope),
      { initialProps: { value: [12], queries: settled, accessScope: "shared:one" } }
    );
    expect(result.current.data).toEqual([12]);
    rerender({ value: [], queries: pending, accessScope: "shared:one" });
    expect(result.current.data).toEqual([12]);
    rerender({ value: [], queries: pending, accessScope: "shared:two" });
    expect(result.current).toEqual({ data: undefined, isLoading: true });
  });
});
