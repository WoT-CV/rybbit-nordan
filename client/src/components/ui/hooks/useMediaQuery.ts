"use client";

import { useCallback, useSyncExternalStore } from "react";

const getServerSnapshot = () => null;

const useMediaQuery = (query: string) => {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", onChange);
      window.addEventListener("resize", onChange);
      return () => {
        media.removeEventListener("change", onChange);
        window.removeEventListener("resize", onChange);
      };
    },
    [query]
  );
  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);

  // SSR/hydration stay unknown; browser renders read the current media state.
  // Listen to media changes too: they need not coincide with window.resize.
  return useSyncExternalStore<boolean | null>(subscribe, getSnapshot, getServerSnapshot);
};

export default useMediaQuery;
