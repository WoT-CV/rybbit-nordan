import { User } from "better-auth";
import { create } from "zustand";
import { authClient } from "./auth";

export const userStore = create<{
  user: User | null;
  isPending: boolean;
  setSession: (user: User) => void;
  setIsPending: (isPending: boolean) => void;
}>(set => ({
  user: null,
  isPending: true,
  setSession: user => set({ user, isPending: false }),
  setIsPending: isPending => set({ isPending }),
}));

// This module is also evaluated by Next during SSR. A browser session must not
// be fetched into a process-wide server store (or through a browser-only URL).
if (typeof window !== "undefined") {
  const initialState = userStore.getState();
  const finishBootstrap = (user: User | null) => {
    // A login/logout or other explicit session update wins over this older read.
    if (userStore.getState() === initialState) {
      userStore.setState({ user, isPending: false });
    } else if (userStore.getState().isPending) {
      // Native login/signup paths may write only `user`. Complete this initial
      // read without replacing their more recent identity.
      userStore.setState({ isPending: false });
    }
  };
  void Promise.resolve()
    .then(() => authClient.getSession())
    .then(({ data: session }) => finishBootstrap(session?.user ?? null))
    .catch(() => finishBootstrap(null));
}
