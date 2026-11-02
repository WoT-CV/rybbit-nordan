import React, { type ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useReplayKeyboardShortcuts } from "./useReplayKeyboardShortcuts";

function createHandlers() {
  return { onSkipBack: vi.fn(), onSkipForward: vi.fn(), onPlayPause: vi.fn() };
}

function Hotkeys({
  handlers,
  player = {},
  children,
}: {
  handlers: ReturnType<typeof createHandlers>;
  player?: object | null;
  children?: ReactNode;
}) {
  useReplayKeyboardShortcuts({ player, ...handlers });
  return <div data-testid="background">{children}</div>;
}

function press(target: EventTarget, key: string) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

function expectIdle(handlers: ReturnType<typeof createHandlers>) {
  expect(handlers.onSkipBack).not.toHaveBeenCalled();
  expect(handlers.onSkipForward).not.toHaveBeenCalled();
  expect(handlers.onPlayPause).not.toHaveBeenCalled();
}

afterEach(cleanup);

describe("useReplayKeyboardShortcuts", () => {
  it("leaves a focused native button's Space default intact even with document-level stopPropagation", () => {
    const stopPropagation = (event: Event) => event.stopPropagation();
    document.addEventListener("keydown", stopPropagation);
    try {
      const handlers = createHandlers();
      render(
        <Hotkeys handlers={handlers}>
          <button type="button">Request details</button>
        </Hotkeys>
      );
      const button = screen.getByRole("button", { name: "Request details" });
      button.focus();
      const event = press(button, " ");
      expect(document.activeElement).toBe(button);
      expect(event.defaultPrevented).toBe(false);
      expectIdle(handlers);
    } finally {
      document.removeEventListener("keydown", stopPropagation);
    }
  });

  it.each([
    "button",
    "a",
    "input",
    "textarea",
    "select",
    "contenteditable",
    "role-button",
    "role-radio",
    "role-slider",
    "role-tab",
  ])("leaves %s keyboard handling to the control", control => {
    const handlers = createHandlers();
    const target = control.startsWith("role-") ? (
      <div role={control.slice(5)} tabIndex={0}>
        <span data-testid="target">Control</span>
      </div>
    ) : control === "contenteditable" ? (
      <div contentEditable suppressContentEditableWarning>
        <span data-testid="target">Editable</span>
      </div>
    ) : (
      React.createElement(control, { "data-testid": "target", ...(control === "a" ? { href: "/request" } : {}) })
    );
    render(<Hotkeys handlers={handlers}>{target}</Hotkeys>);
    for (const key of [" ", "ArrowLeft", "ArrowRight"]) {
      expect(press(screen.getByTestId("target"), key).defaultPrevented).toBe(false);
    }
    expectIdle(handlers);
  });

  it("recognizes nested SVG elements inside controls", () => {
    const handlers = createHandlers();
    render(
      <Hotkeys handlers={handlers}>
        <button type="button">
          <svg>
            <path data-testid="target" />
          </svg>
        </button>
      </Hotkeys>
    );
    expect(press(screen.getByTestId("target"), " ").defaultPrevented).toBe(false);
    expectIdle(handlers);
  });

  it("respects keyboard events already claimed by another handler", () => {
    const handlers = createHandlers();
    render(<Hotkeys handlers={handlers} />);
    const event = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    event.preventDefault();
    screen.getByTestId("background").dispatchEvent(event);
    expectIdle(handlers);
  });

  it("preserves playback hotkeys on noninteractive background", () => {
    const handlers = createHandlers();
    render(<Hotkeys handlers={handlers} />);
    const background = screen.getByTestId("background");
    expect(press(background, " ").defaultPrevented).toBe(true);
    expect(press(background, "ArrowLeft").defaultPrevented).toBe(true);
    expect(press(background, "ArrowRight").defaultPrevented).toBe(true);
    expect(handlers.onPlayPause).toHaveBeenCalledOnce();
    expect(handlers.onSkipBack).toHaveBeenCalledOnce();
    expect(handlers.onSkipForward).toHaveBeenCalledOnce();
    expect(press(background, "Enter").defaultPrevented).toBe(false);
  });

  it("does not claim keys without a player or after unmount", () => {
    const handlers = createHandlers();
    const view = render(<Hotkeys handlers={handlers} player={null} />);
    expect(press(document, " ").defaultPrevented).toBe(false);
    view.rerender(<Hotkeys handlers={handlers} />);
    view.unmount();
    expect(press(document, " ").defaultPrevented).toBe(false);
    expectIdle(handlers);
  });
});
