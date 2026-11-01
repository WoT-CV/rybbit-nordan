import { fireEvent } from "@testing-library/dom";
import { describe, expect, it, vi } from "vitest";
import type { GetSessionsResponse } from "@/api/analytics/endpoints";

const mocks = vi.hoisted(() => ({ features: vi.fn() }));
vi.mock("./timelineClusterUtils", () => ({ getUnclusteredFeatures: mocks.features }));
vi.mock("mapbox-gl", () => ({
  default: {
    Marker: class {
      position = { lng: 0, lat: 0 };
      setLngLat([lng, lat]: number[]) {
        this.position = { lng, lat };
        return this;
      }
      getLngLat() {
        return this.position;
      }
      addTo() {
        return this;
      }
      remove() {}
    },
  },
}));

import { updateMarkers, type MarkerData } from "./timelineMarkerManager";

describe("Mapbox native-profile markers", () => {
  it("ignores late cluster results after the owning effect has been disposed", async () => {
    let resolve!: (features: unknown[]) => void;
    mocks.features.mockReturnValueOnce(
      new Promise(done => {
        resolve = done;
      })
    );
    const session = { session_id: "old", user_id: "device" } as unknown as GetSessionsResponse[number];
    const markers = new Map<string, MarkerData>();
    let current = true;
    const pending = updateMarkers(
      {} as any,
      markers,
      true,
      [session],
      { current: null },
      { current: null },
      { current: null },
      vi.fn(),
      8,
      () => current
    );
    current = false;
    resolve([{ properties: session, geometry: { coordinates: [1, 2] } }]);
    await pending;
    expect(markers.size).toBe(0);
  });

  it("resolves original traits after GeoJSON serialization and refreshes the same marker's identity and selection", async () => {
    const session = {
      session_id: 's1"][x="bad',
      user_id: "device",
      identified_user_id: "000123",
      traits: { username: "[OLD] nick", avatarUrl: "https://logos.example/old.png" },
      session_start: "2026-10-01 12:00:00",
      country: "PL",
      channel: "Direct",
    } as unknown as GetSessionsResponse[number];
    mocks.features.mockResolvedValue([
      { properties: { ...session, traits: JSON.stringify(session.traits) }, geometry: { coordinates: [1, 2] } },
    ]);
    const root = document.createElement("div");
    let open = false;
    const popup: any = {
      isOpen: () => open,
      remove: vi.fn(() => {
        open = false;
        return popup;
      }),
      setLngLat: () => popup,
      setHTML: (html: string) => {
        root.innerHTML = html;
        return popup;
      },
      addTo: () => {
        open = true;
        return popup;
      },
      getElement: () => root,
    };
    const map: any = {};
    const selected = vi.fn();
    const markers = new Map<string, MarkerData>();
    const popupRef = { current: popup };
    const openRef = { current: null as string | null };
    const update = (sessions: GetSessionsResponse) =>
      updateMarkers(map, markers, true, sessions, popupRef, openRef, { current: map }, selected, 8);
    await update([session]);
    const marker = markers.get(session.session_id)!;
    expect(marker.element.querySelector("img")!.src).toContain("old.png");
    fireEvent.click(marker.element);
    expect(root.textContent).toContain("[OLD] nick");
    // A map movement alone must not dismiss an open tooltip.
    await update([session]);
    expect(open).toBe(true);
    const current = { ...session, traits: { username: "[NEW] nick", avatarUrl: "https://logos.example/new.png" } };
    await update([current]);
    expect(markers.get(session.session_id)).toBe(marker);
    expect(marker.element.querySelector("img")!.src).toContain("new.png");
    fireEvent.click(marker.element);
    expect(root.textContent).toContain("[NEW] nick");
    fireEvent.click(root.querySelector(".view-session-btn")!);
    expect(selected).toHaveBeenCalledWith(current);
  });
});
