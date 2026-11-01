const AVATAR_KEYS = ["avatarUrl", "logoUrl", "imageUrl", "avatar_url", "picture"] as const;

export function getUserAvatarUrl(traits: unknown): string | undefined {
  if (!traits || typeof traits !== "object" || Array.isArray(traits)) return undefined;

  const profile = traits as Record<string, unknown>;
  for (const key of AVATAR_KEYS) {
    const candidate = profile[key];
    if (typeof candidate !== "string") continue;
    const value = candidate.trim();
    if (!value || value.length > 2048) continue;
    try {
      const url = new URL(value);
      if (
        (url.protocol === "https:" || url.protocol === "http:") &&
        !url.username &&
        !url.password &&
        url.href.length <= 2048
      ) {
        return url.href;
      }
    } catch {
      // Historical traits can contain invalid URLs; try the next known field.
    }
  }
  return undefined;
}
