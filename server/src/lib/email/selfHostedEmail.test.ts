import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../const.js", () => ({ IS_CLOUD: false, SECRET: "synthetic-test-signing-secret" }));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: mocks.send };
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("RESEND_API_KEY", "synthetic-key");
  vi.stubEnv("EMAIL_FROM", "WoT-CV <reports@example.com>");
  vi.stubEnv("EMAIL_REPLY_TO", "support@example.com");
  vi.stubEnv("BASE_URL", "https://analytics.example.com");
  vi.stubEnv("SERVER_URL", undefined);
  mocks.send.mockReset();
  mocks.send.mockResolvedValue({ data: { id: "accepted" }, error: null });
});
afterEach(() => vi.unstubAllEnvs());

describe("self-hosted email", () => {
  it("uses split API origin for signed unsubscribe but keeps dashboard and OTP links on frontend", async () => {
    vi.stubEnv("BASE_URL", "http://127.0.0.1:13002");
    vi.stubEnv("SERVER_URL", "http://127.0.0.1:13001");
    const { sendWeeklyDigestEmail, sendOtpEmail } = await import("./email.js");
    const { verifyExpiringPayload } = await import("../signedToken.js");
    const userId = "000123 + opaque/id";
    await sendWeeklyDigestEmail({
      email: "person@example.com",
      userId,
      digest: { weekStart: "2026-10-26", weekEnd: "2026-11-01", sites: [] },
    });
    const message = mocks.send.mock.calls[0][0];
    const unsubscribe = new URL(message.headers["List-Unsubscribe"].slice(1, -1));
    expect(unsubscribe.origin).toBe("http://127.0.0.1:13001");
    expect(unsubscribe.pathname).toBe("/api/user/unsubscribe-reports-oneclick");
    expect(unsubscribe.searchParams.get("userId")).toBe(userId);
    expect(
      verifyExpiringPayload(
        `unsubscribe-reports:${userId}`,
        unsubscribe.searchParams.get("exp")!,
        unsubscribe.searchParams.get("sig")!
      )
    ).toBe(true);
    expect(message.html).toContain("http://127.0.0.1:13002/settings/account");
    expect(message.html).not.toContain("http://127.0.0.1:13002/api/user/");
    expect(message.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    await sendOtpEmail("person@example.com", "123456", "forget-password");
    expect(mocks.send.mock.calls[1][0].html).toContain("http://127.0.0.1:13002/settings/account");
  });
  it("refuses sends and report links when explicit API origin is invalid", async () => {
    vi.stubEnv("SERVER_URL", "https://api.example.com/not-an-origin");
    const { sendEmail, weeklyReportUnsubscribeUrl } = await import("./email.js");
    expect(() => weeklyReportUnsubscribeUrl("user1")).toThrow("not configured");
    await expect(sendEmail("person@example.com", "Report", "html")).rejects.toThrow("not configured");
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("renders report links and signed unsubscribe using the same configured origin", async () => {
    const { sendWeeklyDigestEmail } = await import("./email.js");
    await sendWeeklyDigestEmail({
      email: "person@example.com",
      userId: "user1",
      digest: { weekStart: "2026-10-26", weekEnd: "2026-11-01", sites: [] },
    });
    const message = mocks.send.mock.calls[0][0];
    expect(message.html).toContain("https://analytics.example.com");
    expect(message.headers["List-Unsubscribe"]).toContain(
      "https://analytics.example.com/api/user/unsubscribe-reports-oneclick?"
    );
    expect(message.html).not.toContain("undefined/");
  });
  it("does not generate report links with a missing BASE_URL even if SERVER_URL is set", async () => {
    vi.stubEnv("BASE_URL", "");
    vi.stubEnv("SERVER_URL", "https://api.example.com");
    const { sendWeeklyDigestEmail } = await import("./email.js");
    await expect(
      sendWeeklyDigestEmail({
        email: "person@example.com",
        userId: "user1",
        digest: { weekStart: "2026-10-26", weekEnd: "2026-11-01", sites: [] },
      })
    ).rejects.toThrow("not configured");
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("uses the configured sender and reply-to without cloud marketing", async () => {
    const { sendEmail, sendWelcomeEmail, sendLifecycleEmail } = await import("./email.js");
    await sendEmail("person@example.com", "Weekly report", "<p>Report</p>");
    expect(mocks.send.mock.calls[0][0]).toMatchObject({
      from: "WoT-CV <reports@example.com>",
      replyTo: "support@example.com",
    });
    await sendWelcomeEmail("person@example.com");
    expect(await sendLifecycleEmail("person@example.com", {} as never)).toBe(false);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
  it("never acknowledges a send when transport is absent", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const { sendEmail } = await import("./email.js");
    await expect(sendEmail("person@example.com", "Report", "html")).rejects.toThrow("not configured");
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("propagates provider rejection", async () => {
    mocks.send.mockResolvedValue({ data: null, error: { name: "validation_error", message: "Rejected" } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { sendEmail } = await import("./email.js");
    await expect(sendEmail("person@example.com", "Report", "html")).rejects.toThrow("Rejected");
  });
});
