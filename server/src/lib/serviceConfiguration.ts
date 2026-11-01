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
  const gscRedirectUri = env.GOOGLE_REDIRECT_URI
    ? httpUrl(env.GOOGLE_REDIRECT_URI)
    : `${env.SERVER_URL ? httpUrl(env.SERVER_URL, true) : publicUrl}/api/gsc/callback`;
  const emailFrom = env.EMAIL_FROM?.trim() || (isCloud ? "Rybbit <automail@email.rybbit.com>" : "");
  const emailReplyTo = env.EMAIL_REPLY_TO?.trim() || (isCloud ? "hello@rybbit.com" : "");
  const emailEnabled = present(env.RESEND_API_KEY) && present(emailFrom) && present(emailReplyTo) && Boolean(publicUrl);
  return {
    publicUrl,
    gscRedirectUri,
    emailFrom,
    emailReplyTo,
    emailEnabled,
    gscEnabled:
      present(env.GOOGLE_CLIENT_ID) &&
      present(env.GOOGLE_CLIENT_SECRET) &&
      Boolean(publicUrl) &&
      Boolean(httpUrl(gscRedirectUri)),
    weeklyReportsEnabled: emailEnabled && Boolean(publicUrl),
  };
}
