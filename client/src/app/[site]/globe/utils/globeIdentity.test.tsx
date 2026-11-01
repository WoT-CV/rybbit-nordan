import { fireEvent } from "@testing-library/dom";
import { describe, expect, it } from "vitest";
import type { GetSessionsResponse, LiveSessionLocation } from "@/api/analytics/endpoints";
import {
  globeAvatarHTML,
  locationIdentityKey,
  locationTooltipHTML,
  setGlobeAvatar,
  setGlobeTooltip,
} from "./globeIdentity";
import { buildTooltipHTML } from "./timelineTooltipBuilder";

const identity = {
  user_id: "device",
  identified_user_id: "000123",
  traits: { username: "[TAG] nick", avatarUrl: "https://logos.example/clan.png" },
};

describe("Globe current identity adapters", () => {
  it("loads a no-referrer contained clan logo and falls back to the native frog on error", () => {
    const root = document.createElement("div");
    setGlobeAvatar(root, identity, 32);
    const image = root.querySelector("img")!;
    expect(image.src).toBe(identity.traits.avatarUrl);
    expect(image.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(image.style.objectFit).toBe("contain");
    expect(root.querySelector("svg")).not.toBeNull();
    fireEvent.load(image);
    expect(root.querySelector<HTMLElement>("[data-globe-fallback]")!.style.visibility).toBe("hidden");
    fireEvent.error(image);
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector<HTMLElement>("[data-globe-fallback]")!.style.visibility).toBe("");
    setGlobeAvatar(
      root,
      { ...identity, traits: { ...identity.traits, avatarUrl: "https://logos.example/new.png" } },
      32
    );
    expect(root.querySelector("img")!.src).toContain("/new.png");
  });

  it("does not retry a broken image on every marker move or trust unsafe URLs", () => {
    const root = document.createElement("div");
    setGlobeAvatar(root, identity, 32);
    fireEvent.error(root.querySelector("img")!);
    setGlobeAvatar(root, { ...identity }, 32);
    expect(root.querySelector("img")).toBeNull();
    expect(globeAvatarHTML({ ...identity, traits: { picture: "javascript:alert(1)" } }, 32)).not.toContain("<img");
  });

  it("shows a single session's profile but never attributes an aggregate to its sample", () => {
    const location: LiveSessionLocation = {
      lat: 1,
      lon: 2,
      city: "Warsaw<script>",
      country: "PL",
      count: 1,
      sample: { ...identity, session_id: "s1" },
    };
    const root = document.createElement("div");
    setGlobeTooltip(root, locationTooltipHTML(location));
    expect(root.textContent).toContain("[TAG] nick");
    expect(root.textContent).toContain("Warsaw<script>");
    expect(root.querySelector("script")).toBeNull();
    expect(root.querySelector("img")!.src).toBe(identity.traits.avatarUrl);
    const group = locationTooltipHTML({ ...location, count: 2 });
    expect(group).not.toContain("[TAG]");
    expect(group).not.toContain("logos.example");
    expect(group).toContain(">2</span>");
    expect(locationTooltipHTML({ ...location, sample: null })).not.toContain("[TAG]");
  });

  it("matches stale Mapbox features by the full location key, never a reordered response's index", () => {
    const a: LiveSessionLocation = {
      lat: 1,
      lon: 2,
      city: "A",
      country: "PL",
      count: 1,
      sample: { ...identity, session_id: "a" },
    };
    const b: LiveSessionLocation = { ...a, lat: 3, city: "B", sample: { ...identity, session_id: "b" } };
    const oldFeatureKey = locationIdentityKey(a);
    const newResponse = [b, { ...a, count: 2, sample: null }];
    const byKey = new Map(newResponse.map(location => [locationIdentityKey(location), location]));
    expect(byKey.get(oldFeatureKey)).toBe(newResponse[1]);
    expect(locationTooltipHTML(byKey.get(oldFeatureKey)!)).not.toContain("[TAG]");
    expect(new Map([[locationIdentityKey(b), b]]).get(oldFeatureKey)).toBeUndefined();
  });

  it("escapes timeline names, text and attributes without losing the native detail button ID", () => {
    const session = {
      ...identity,
      traits: { ...identity.traits, username: '[TAG] <img src=x onerror="alert(1)">' },
      session_id: 's1"][onclick="bad',
      city: "<script>bad</script>",
      country: "PL",
      browser: 'Chrome" onerror="bad',
      operating_system: "Linux",
      device_type: '\"><script>bad</script>',
      channel: "Direct <script>",
      referrer: "",
      session_start: "2026-10-01 12:00:00",
      session_duration: 5,
      pageviews: 1,
      events: 0,
    } as unknown as GetSessionsResponse[number];
    const root = document.createElement("div");
    setGlobeTooltip(root, buildTooltipHTML(session, 1, 2));
    expect(root.textContent).toContain(session.traits!.username);
    expect(root.querySelector("script")).toBeNull();
    expect(root.querySelector("[onerror], [onclick]")).toBeNull();
    expect(root.querySelector<HTMLButtonElement>(".view-session-btn")!.dataset.sessionId).toBe(session.session_id);
  });
});
