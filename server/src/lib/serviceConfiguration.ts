import { IS_CLOUD } from "./const.js";

const present = (value: string | undefined) => Boolean(value?.trim());

function httpUrl(value: string | undefined, rootOnly = false): string {
  try {
    const url = new URL(value ?? "");
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (!rootOnly || url.pathname === "/")
      ? rootOnly
        ? url.origin
        : url.toString()
      : "";
  } catch {
    return "";
  }
}

export function getServiceConfiguration(env: NodeJS.ProcessEnv = process.env, isCloud = IS_CLOUD) {
  const publicUrl = httpUrl(env.BASE_URL, true);
  // A separately exposed API must not silently fall back to the frontend when
  // its explicitly configured origin is invalid.
  const apiUrl = env.SERVER_URL === undefined ? publicUrl : httpUrl(env.SERVER_URL, true);
  const gscRedirectUri = env.GOOGLE_REDIRECT_URI
    ? httpUrl(env.GOOGLE_REDIRECT_URI)
    : apiUrl
      ? `${apiUrl}/api/gsc/callback`
      : "";
  const emailFrom = env.EMAIL_FROM?.trim() || (isCloud ? "Rybbit <automail@email.rybbit.com>" : "");
  const emailReplyTo = env.EMAIL_REPLY_TO?.trim() || (isCloud ? "hello@rybbit.com" : "");
  const emailEnabled =
    present(env.RESEND_API_KEY) && present(emailFrom) && present(emailReplyTo) && Boolean(publicUrl) && Boolean(apiUrl);
  return {
    publicUrl,
    apiUrl,
    gscRedirectUri,
    emailFrom,
    emailReplyTo,
    emailEnabled,
    gscEnabled:
      present(env.GOOGLE_CLIENT_ID) &&
      present(env.GOOGLE_CLIENT_SECRET) &&
      Boolean(publicUrl) &&
      Boolean(apiUrl) &&
      Boolean(httpUrl(gscRedirectUri)),
    weeklyReportsEnabled: emailEnabled && Boolean(publicUrl),
  };
}
