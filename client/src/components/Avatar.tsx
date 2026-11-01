"use client";

import { DateTime } from "luxon";
import { useExtracted } from "next-intl";
import { useState } from "react";
import { useDateTimeFormat } from "../hooks/useDateTimeFormat";
import { getTimezone } from "../lib/store";
import { getUserAvatarUrl } from "../lib/userAvatar";
import { FrogAvatar } from "./FrogAvatar";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

export { generateName } from "../lib/generateName";

export function Avatar({
  id,
  size = 20,
  lastActiveTime,
  traits,
}: {
  id: string;
  size?: number;
  lastActiveTime?: DateTime;
  traits?: unknown;
}) {
  const t = useExtracted();
  const avatarUrl = getUserAvatarUrl(traits);
  const [failedUrl, setFailedUrl] = useState<string>();
  const { formatRelative } = useDateTimeFormat();
  const timeSinceEnd = lastActiveTime ? -lastActiveTime.setZone(getTimezone()).diffNow().toMillis() / 1000 : 0;
  const online = lastActiveTime ? timeSinceEnd < 300 : false;
  // Half the avatar, ring included: big enough to read, small enough to leave the face alone.
  const dot = Math.max(8, Math.round(size / 2));
  return (
    <div className="relative">
      {avatarUrl && failedUrl !== avatarUrl ? (
        // Profile images are dynamic external URLs; no server-side image fetch or referrer is needed.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={avatarUrl}
          src={avatarUrl}
          alt=""
          width={size}
          height={size}
          className="block object-contain"
          style={{ width: size, height: size }}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailedUrl(avatarUrl)}
        />
      ) : (
        <FrogAvatar id={id} size={size} />
      )}
      {online && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className="absolute -bottom-0.5 -right-0.5 bg-green-500 rounded-full border-2 border-white dark:border-neutral-900"
              style={{ width: dot, height: dot }}
            />
          </TooltipTrigger>
          <TooltipContent>
            <p>{t("Active {time}", { time: lastActiveTime ? formatRelative(lastActiveTime) : "" })}</p>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
