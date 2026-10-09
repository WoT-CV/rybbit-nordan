import { createElement } from "react";
// @ts-ignore - React 19 has built-in types
import { renderToStaticMarkup } from "react-dom/server";
import * as CountryFlags from "country-flag-icons/react/3x2";
import { getChannelIconComponent } from "../../../../../../components/Channel";
import { frogAvatarSVG } from "../../../../../../lib/frogAvatar";
import { escapeHtmlAttribute, resolveUserIdentity, type UserIdentityLike } from "../../../../../../lib/userIdentity";
import { BROWSER_TO_LOGO } from "../../../../components/shared/icons/Browser";
import { getDeviceIconComponent } from "../../../../components/shared/icons/Device";
import { OS_TO_LOGO } from "../../../../components/shared/icons/OperatingSystem";

export function generateAvatarSVG(userId: string, size: number): string {
  return frogAvatarSVG(userId, size);
}

export function generateUserAvatarHTML(user: UserIdentityLike, size: number): string {
  const identity = resolveUserIdentity(user);
  const fallbackAvatar = generateAvatarSVG(identity.avatarId, size);
  const avatarUrl = identity.avatarUrl;

  if (!avatarUrl) return fallbackAvatar;

  const fallbackDataUri = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(fallbackAvatar)}`;
  const escapedUrl = escapeHtmlAttribute(avatarUrl);
  const escapedAlt = escapeHtmlAttribute(identity.displayName);

  return `
    <span
      style="display:block;width:${size}px;height:${size}px;border-radius:9999px;overflow:hidden;background-image:url('${fallbackDataUri}');background-size:cover;background-position:center;"
    >
      <img
        src="${escapedUrl}"
        alt="${escapedAlt}"
        style="width:100%;height:100%;object-fit:cover;display:block;"
        onerror="this.style.display='none';"
      />
    </span>
  `;
}
// Render country flag to static SVG
export function renderCountryFlag(countryCode: string): string {
  if (!countryCode || countryCode.length !== 2) return "";
  const FlagComponent = CountryFlags[countryCode.toUpperCase() as keyof typeof CountryFlags];
  if (!FlagComponent) return "";
  const flagElement = createElement(FlagComponent, { className: "w-4 h-3 inline-block" });
  return renderToStaticMarkup(flagElement);
}

// Render device icon based on device type
export function renderDeviceIcon(deviceType: string): string {
  const Icon = getDeviceIconComponent(deviceType);
  const iconElement = createElement(Icon, { size: 14, className: "inline-block" });
  return renderToStaticMarkup(iconElement);
}

// Render channel icon
export function renderChannelIcon(channel: string): string {
  const IconComponent = getChannelIconComponent(channel);
  if (!IconComponent) return "";
  const iconElement = createElement(IconComponent, { size: 14, className: "inline-block" });
  return renderToStaticMarkup(iconElement);
}

// Get browser icon path
export function getBrowserIconPath(browser: string): string {
  return BROWSER_TO_LOGO[browser] ? `/browsers/${BROWSER_TO_LOGO[browser]}` : "";
}

// Get OS icon path
export function getOSIconPath(os: string): string {
  return OS_TO_LOGO[os] ? `/operating-systems/${OS_TO_LOGO[os]}` : "";
}
