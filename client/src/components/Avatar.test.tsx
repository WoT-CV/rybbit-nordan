import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { DateTime } from "luxon";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Avatar } from "./Avatar";

vi.mock("next-intl", () => ({ useExtracted: () => (text: string) => text }));
vi.mock("../hooks/useDateTimeFormat", () => ({ useDateTimeFormat: () => ({ formatRelative: () => "now" }) }));
vi.mock("../lib/store", () => ({ getTimezone: () => "UTC" }));
vi.mock("./ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
afterEach(cleanup);

describe("visitor clan avatar", () => {
  it("renders the current logo without changing the online indicator", () => {
    const { container } = render(
      <Avatar
        id="000123"
        size={40}
        traits={{ avatarUrl: "https://cdn.example.com/clan.png" }}
        lastActiveTime={DateTime.now()}
      />
    );
    const image = container.querySelector("img")!;
    expect(image.src).toBe("https://cdn.example.com/clan.png");
    expect(image.width).toBe(40);
    expect(image.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(image.className).toContain("object-contain");
    expect(container.querySelector(".bg-green-500")).not.toBeNull();
  });

  it("falls back on error and accepts a new logo URL after a profile update", () => {
    const { container, rerender } = render(
      <Avatar id="000123" traits={{ avatarUrl: "https://cdn.example.com/old.png" }} />
    );
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
    rerender(<Avatar id="000123" traits={{ avatarUrl: "https://cdn.example.com/new.png" }} />);
    expect(container.querySelector("img")?.src).toBe("https://cdn.example.com/new.png");
    rerender(<Avatar id="000123" traits={null} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("retains native anonymous avatars and offline behavior", () => {
    const { container } = render(
      <Avatar
        id="anonymous"
        traits={{ avatarUrl: "javascript:alert(1)" }}
        lastActiveTime={DateTime.now().minus({ hours: 1 })}
      />
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.querySelector(".bg-green-500")).toBeNull();
  });

  it("does not apply a late error from the previous image to the updated logo", () => {
    const { container, rerender } = render(
      <Avatar id="000123" traits={{ avatarUrl: "https://cdn.example.com/old.png" }} />
    );
    const oldImage = container.querySelector("img")!;
    rerender(<Avatar id="000123" traits={{ avatarUrl: "https://cdn.example.com/new.png" }} />);
    expect(container.querySelector("img")).not.toBe(oldImage);
    fireEvent.error(oldImage);
    expect(container.querySelector("img")?.src).toBe("https://cdn.example.com/new.png");
  });
});
