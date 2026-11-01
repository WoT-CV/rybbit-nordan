import mapboxgl from "mapbox-gl";
import type { GetSessionsResponse } from "../../../../../../api/analytics/endpoints";
import { globeIdentityKey, hydrateGlobeAvatars, setGlobeAvatar } from "../../../utils/globeIdentity";
import { getUnclusteredFeatures } from "./timelineClusterUtils";
import { buildTooltipHTML } from "../../../utils/timelineTooltipBuilder";

export type MarkerData = {
  marker: mapboxgl.Marker;
  element: HTMLDivElement;
  cleanup: () => void;
  update: (session: GetSessionsResponse[number], lng: number, lat: number) => void;
};

/**
 * Create an avatar marker for a session
 */
export function createAvatarMarker(
  session: GetSessionsResponse[number],
  lng: number,
  lat: number,
  mapInstance: mapboxgl.Map,
  popupRef: React.RefObject<mapboxgl.Popup | null>,
  openTooltipSessionIdRef: React.MutableRefObject<string | null>,
  map: React.RefObject<mapboxgl.Map | null>,
  setSelectedSession: (session: GetSessionsResponse[number]) => void
): MarkerData {
  let currentSession = session;
  let currentLng = lng;
  let currentLat = lat;
  const avatarContainer = document.createElement("div");
  avatarContainer.className = "timeline-avatar-marker";
  avatarContainer.style.cssText =
    "cursor: pointer; width: 32px; height: 32px; filter: drop-shadow(0 1px 2px rgba(0,0,0,0.55));";

  setGlobeAvatar(avatarContainer, session, 32);

  const marker = new mapboxgl.Marker({
    element: avatarContainer,
    anchor: "center",
  })
    .setLngLat([lng, lat])
    .addTo(mapInstance);

  // Add click event for tooltip
  const toggleTooltip = (e: MouseEvent) => {
    e.stopPropagation();
    if (!map.current || !popupRef.current) return;

    // If clicking the same marker that has the tooltip open, close it
    if (popupRef.current.isOpen() && openTooltipSessionIdRef.current === currentSession.session_id) {
      popupRef.current.remove();
      openTooltipSessionIdRef.current = null;
      return;
    }

    // If clicking a different marker (or no tooltip is open), show this one
    if (popupRef.current.isOpen()) {
      popupRef.current.remove();
    }

    const html = buildTooltipHTML(currentSession, currentLng, currentLat);

    popupRef.current.setLngLat([currentLng, currentLat]).setHTML(html).addTo(map.current);
    hydrateGlobeAvatars(popupRef.current.getElement());
    openTooltipSessionIdRef.current = currentSession.session_id;

    // Add click handler to the button
    const button = popupRef.current.getElement()?.querySelector(".view-session-btn");
    if (button) {
      button.addEventListener("click", e => {
        e.stopPropagation();
        setSelectedSession(currentSession);
        popupRef.current?.remove();
        openTooltipSessionIdRef.current = null;
      });
    }
  };

  avatarContainer.addEventListener("click", toggleTooltip);

  const cleanup = () => {
    avatarContainer.removeEventListener("click", toggleTooltip);
  };

  const update = (nextSession: GetSessionsResponse[number], nextLng: number, nextLat: number) => {
    const identityChanged = globeIdentityKey(currentSession) !== globeIdentityKey(nextSession);
    currentSession = nextSession;
    currentLng = nextLng;
    currentLat = nextLat;
    setGlobeAvatar(avatarContainer, currentSession, 32);
    const position = marker.getLngLat();
    if (position.lng !== nextLng || position.lat !== nextLat) marker.setLngLat([nextLng, nextLat]);
    // An already-open popup must not retain the profile from its creation.
    if (
      identityChanged &&
      openTooltipSessionIdRef.current === currentSession.session_id &&
      popupRef.current?.isOpen()
    ) {
      popupRef.current.remove();
      openTooltipSessionIdRef.current = null;
    }
  };
  return { marker, element: avatarContainer, cleanup, update };
}

/**
 * Update all markers on the map based on current unclustered features
 */
export async function updateMarkers(
  mapInstance: mapboxgl.Map,
  markersMap: Map<string, MarkerData>,
  shouldShowClusters: boolean,
  activeSessions: GetSessionsResponse,
  popupRef: React.RefObject<mapboxgl.Popup | null>,
  openTooltipSessionIdRef: React.MutableRefObject<string | null>,
  map: React.RefObject<mapboxgl.Map | null>,
  setSelectedSession: (session: GetSessionsResponse[number]) => void,
  spreadStartZoom: number,
  isCurrent: () => boolean = () => true
): Promise<void> {
  // Get unclustered features (including expanded small clusters)
  const unclusteredFeatures = await getUnclusteredFeatures(
    mapInstance,
    shouldShowClusters,
    activeSessions,
    spreadStartZoom
  );
  if (!isCurrent()) return;

  // Build set of current session IDs
  const currentSessionIds = new Set(
    unclusteredFeatures.flatMap(f => {
      const sessionId = f.properties?.session_id;
      return sessionId ? [sessionId] : [];
    })
  );

  // Remove markers that are no longer unclustered
  const toRemove: string[] = [];
  markersMap.forEach(({ marker, cleanup }, sessionId) => {
    if (!currentSessionIds.has(sessionId)) {
      cleanup();
      marker.remove();
      toRemove.push(sessionId);
    }
  });
  toRemove.forEach(id => markersMap.delete(id));

  const sessionsById = new Map(activeSessions.map(session => [session.session_id, session]));
  // Mapbox serializes nested properties. Resolve the original typed session,
  // rather than pretending that feature.properties.traits is still an object.
  unclusteredFeatures.forEach(feature => {
    const session = sessionsById.get(feature.properties?.session_id);
    if (!session) return;

    const existing = markersMap.get(session.session_id);
    const [lng, lat] = (feature.geometry as any).coordinates;

    if (existing) {
      existing.update(session, lng, lat);
    } else {
      // Create new marker
      const markerData = createAvatarMarker(
        session,
        lng,
        lat,
        mapInstance,
        popupRef,
        openTooltipSessionIdRef,
        map,
        setSelectedSession
      );
      markersMap.set(session.session_id, markerData);
    }
  });
}

/**
 * Remove all markers from the map and clear the markers map
 */
export function clearAllMarkers(markersMap: Map<string, MarkerData>): void {
  markersMap.forEach(({ marker, cleanup }) => {
    cleanup();
    marker.remove();
  });
  markersMap.clear();
}
