import { describe, expect, it } from "vitest";
import { getUserAvatarUrl } from "./userAvatar";

describe("profile avatar URLs", () => {
  it("prefers the current WoT-CV clan logo over historical fields", () => {
    expect(
      getUserAvatarUrl({ avatarUrl: " https://cdn.example.com/clan.png ", picture: "https://old.example.com/a" })
    ).toBe("https://cdn.example.com/clan.png");
  });

  it.each(["logoUrl", "imageUrl", "avatar_url", "picture"])("retains the historical %s field", key => {
    expect(getUserAvatarUrl({ [key]: "https://cdn.example.com/a" })).toBe("https://cdn.example.com/a");
  });

  it("tries lower-priority valid fields after invalid values", () => {
    expect(
      getUserAvatarUrl({ avatarUrl: "javascript:alert(1)", logoUrl: 42, imageUrl: "https://cdn.example.com/a" })
    ).toBe("https://cdn.example.com/a");
  });

  it.each([
    null,
    undefined,
    42,
    "https://cdn.example.com/a",
    [],
    { avatarUrl: {} },
    { avatarUrl: ["https://cdn.example.com/a"] },
  ])("does not coerce malformed traits: %j", traits => expect(getUserAvatarUrl(traits)).toBeUndefined());

  it.each([
    "",
    "/relative.png",
    "//cdn.example.com/a",
    "data:image/svg+xml,evil",
    "javascript:alert(1)",
    "file:///a",
    "https://user:password@example.com/a",
    "https://cdn.example.com/" + "a".repeat(2048),
    "https://cdn.example.com/" + "ż".repeat(500),
  ])("rejects invalid, credential-bearing or oversized URL: %s", avatarUrl =>
    expect(getUserAvatarUrl({ avatarUrl })).toBeUndefined()
  );

  it("normalizes only the URL, not any user identity", () => {
    expect(getUserAvatarUrl({ avatarUrl: "HTTP://CDN.EXAMPLE.COM/a.png" })).toBe("http://cdn.example.com/a.png");
  });
});
