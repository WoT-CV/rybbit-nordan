export function getSourceCodeUrl(value: unknown = process.env.SOURCE_CODE_URL): string | undefined {
  if (typeof value !== "string" || value.length > 2048 || !/^https:\/\//i.test(value) || /[\s\\?#]/.test(value)) {
    return undefined;
  }
  try {
    const url = new URL(value);
    const normalized = url.href;
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      normalized.length <= 2048
      ? normalized
      : undefined;
  } catch {
    return undefined;
  }
}
