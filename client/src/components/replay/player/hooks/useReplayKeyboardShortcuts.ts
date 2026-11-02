import { useEffect } from "react";

const INTERACTIVE_TARGET_SELECTOR =
  "button,a[href],input,textarea,select,[contenteditable],[role=button],[role=radio],[role=slider],[role=tab]";

interface UseReplayKeyboardShortcutsProps {
  player: any;
  onSkipBack: () => void;
  onSkipForward: () => void;
  onPlayPause: () => void;
}

export const useReplayKeyboardShortcuts = ({
  player,
  onSkipBack,
  onSkipForward,
  onPlayPause,
}: UseReplayKeyboardShortcutsProps) => {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // React and playback listeners can both be delegated to document. A control's
      // stopPropagation does not stop other listeners on that same node, so leave
      // its native keyboard behavior intact here instead of preventing its default.
      if (
        !player ||
        event.defaultPrevented ||
        (event.target instanceof Element && event.target.closest(INTERACTIVE_TARGET_SELECTOR))
      ) {
        return;
      }

      switch (event.key) {
        case "ArrowLeft":
          event.preventDefault();
          onSkipBack();
          break;
        case "ArrowRight":
          event.preventDefault();
          onSkipForward();
          break;
        case " ":
          event.preventDefault();
          onPlayPause();
          break;
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [player, onSkipBack, onSkipForward, onPlayPause]);
};
