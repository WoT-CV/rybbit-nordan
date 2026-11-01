import type { LiveSessionLocation } from "@/api/analytics/endpoints/sessions";
import { frogAvatarSVG } from "@/lib/frogAvatar";
import { getUserAvatarUrl } from "@/lib/userAvatar";
import { getUserDisplayName } from "@/lib/utils";
import { renderCountryFlag } from "./renderCountryFlag";

type GlobeIdentity = {
  user_id: string;
  identified_user_id?: string;
  traits?: Record<string, unknown> | null;
};

export const locationIdentityKey = (location: Pick<LiveSessionLocation, "lat" | "lon" | "city" | "country">): string =>
  JSON.stringify([location.lat, location.lon, location.city, location.country]);

export const escapeGlobeHTML = (value: unknown): string =>
  String(value ?? "").replace(
    /[&<>"']/g,
    character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!
  );

export function globeIdentityKey(identity: GlobeIdentity): string {
  return JSON.stringify([identity.user_id, getUserDisplayName(identity), getUserAvatarUrl(identity.traits)]);
}

// The native frog stays visible until a real logo loads, and on any load error.
// Event handlers are attached through DOM APIs, never inline HTML/JavaScript.
export function globeAvatarHTML(identity: GlobeIdentity, size: number): string {
  const url = getUserAvatarUrl(identity.traits);
  const frog = frogAvatarSVG(identity.user_id, size);
  if (!url) return frog;
  return `<span data-globe-avatar style="display:block;position:relative;width:${size}px;height:${size}px">
    <span data-globe-fallback>${frog}</span>
    <img src="${escapeGlobeHTML(url)}" alt="" width="${size}" height="${size}" loading="lazy" referrerpolicy="no-referrer"
      style="position:absolute;inset:0;display:block;width:100%;height:100%;object-fit:contain;opacity:0" />
  </span>`;
}

export function hydrateGlobeAvatars(root: HTMLElement | undefined): void {
  if (!root) return;
  root.querySelectorAll<HTMLElement>("[data-globe-avatar]").forEach(avatar => {
    const image = avatar.querySelector("img");
    const fallback = avatar.querySelector<HTMLElement>("[data-globe-fallback]");
    if (!image || !fallback) return;
    image.onload = () => {
      image.style.opacity = "1";
      fallback.style.visibility = "hidden";
    };
    image.onerror = () => {
      fallback.style.visibility = "";
      image.remove();
    };
    if (image.complete) {
      if (image.naturalWidth > 0) image.onload(new Event("load"));
      else image.onerror(new Event("error"));
    }
  });
}

export function setGlobeAvatar(element: HTMLElement, identity: GlobeIdentity, size: number): void {
  const key = `${size}:${globeIdentityKey(identity)}`;
  if (element.dataset.globeIdentity === key) return;
  element.dataset.globeIdentity = key;
  element.innerHTML = globeAvatarHTML(identity, size);
  hydrateGlobeAvatars(element);
}

export function setGlobeTooltip(element: HTMLElement, html: string): void {
  element.innerHTML = html;
  hydrateGlobeAvatars(element);
}

export function locationTooltipHTML(location: LiveSessionLocation): string {
  const sample = location.count === 1 ? location.sample : null;
  const identity = sample
    ? `<div class="flex items-center gap-2 mb-2">${globeAvatarHTML(sample, 28)}<span class="text-sm font-medium text-white">${escapeGlobeHTML(getUserDisplayName(sample))}</span></div>`
    : "";
  return `<div class="bg-neutral-850 border border-neutral-750 rounded-lg p-2 shadow-lg" style="pointer-events:none">
    ${identity}
    <div class="flex items-center gap-2 mb-1">${renderCountryFlag(location.country)}<span class="text-sm font-medium text-white">${escapeGlobeHTML(location.city || "Unknown")}</span></div>
    <div class="text-sm"><span class="font-bold text-accent-400">${location.count.toLocaleString()}</span><span class="text-neutral-300"> sessions</span></div>
  </div>`;
}
