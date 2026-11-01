import { afterEach, expect, it, vi } from "vitest";
import { getConfig } from "./getConfig.js";

afterEach(() => vi.unstubAllEnvs());
it("exposes only an explicitly configured valid public source URL", async () => {
  const send = vi.fn();
  vi.stubEnv("SOURCE_CODE_URL", undefined);
  await getConfig({} as never, { send } as never);
  expect(JSON.parse(JSON.stringify(send.mock.calls[0][0]))).not.toHaveProperty("sourceCodeUrl");
  send.mockClear();
  vi.stubEnv("SOURCE_CODE_URL", "https://code.example.com/team/fork");
  await getConfig({} as never, { send } as never);
  expect(send.mock.calls[0][0].sourceCodeUrl).toBe("https://code.example.com/team/fork");
  send.mockClear();
  vi.stubEnv("SOURCE_CODE_URL", "https://secret@code.example.com/team/fork");
  await getConfig({} as never, { send } as never);
  expect(JSON.parse(JSON.stringify(send.mock.calls[0][0]))).not.toHaveProperty("sourceCodeUrl");
});
it("publishes service readiness without secrets or private configuration", async () => {
  for (const [key, value] of Object.entries({
    BASE_URL: "https://analytics.example.com",
    RESEND_API_KEY: "secret-resend",
    EMAIL_FROM: "reports@example.com",
    EMAIL_REPLY_TO: "support@example.com",
    GOOGLE_CLIENT_ID: "private-client",
    GOOGLE_CLIENT_SECRET: "secret-google",
  }))
    vi.stubEnv(key, value);
  const send = vi.fn();
  await getConfig({} as never, { send } as never);
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({ emailEnabled: true, gscEnabled: true, weeklyReportsEnabled: true })
  );
  const body = send.mock.calls[0][0];
  for (const key of [
    "emailFrom",
    "emailReplyTo",
    "publicUrl",
    "gscRedirectUri",
    "RESEND_API_KEY",
    "GOOGLE_CLIENT_SECRET",
  ])
    expect(body).not.toHaveProperty(key);
});
