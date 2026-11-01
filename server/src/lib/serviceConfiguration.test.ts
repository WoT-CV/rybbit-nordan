import { describe, expect, it } from "vitest";
import { getServiceConfiguration } from "./serviceConfiguration.js";

const configured = {
  RESEND_API_KEY: "synthetic-key",
  EMAIL_FROM: "WoT-CV <reports@example.com>",
  EMAIL_REPLY_TO: "support@example.com",
  BASE_URL: "https://analytics.example.com",
  GOOGLE_CLIENT_ID: "client",
  GOOGLE_CLIENT_SECRET: "secret",
};

describe("service readiness", () => {
  it("preserves the exact path slash of an explicitly registered OAuth callback", () => {
    const redirect = "https://analytics.example.com/api/gsc/callback/";
    expect(getServiceConfiguration({ ...configured, GOOGLE_REDIRECT_URI: redirect }, false).gscRedirectUri).toBe(
      redirect
    );
  });
  it.each([
    { SERVER_URL: "https://api.example.com/subpath" },
    { SERVER_URL: "file:///tmp" },
    { GOOGLE_REDIRECT_URI: "javascript:alert(1)" },
  ])("does not offer GSC with invalid callback configuration %o", override => {
    expect(getServiceConfiguration({ ...configured, ...override }, false).gscEnabled).toBe(false);
  });
  it.each([
    "https://analytics.example.com?x=1",
    "https://analytics.example.com/#hash",
    "https://analytics.example.com/subpath",
    "https://user:password@analytics.example.com",
  ])("rejects an ambiguous public base: %s", BASE_URL => {
    expect(getServiceConfiguration({ ...configured, BASE_URL }, false)).toMatchObject({
      publicUrl: "",
      weeklyReportsEnabled: false,
      gscEnabled: false,
    });
  });
  it("normalizes origins before constructing the same GSC callback", () => {
    expect(
      getServiceConfiguration(
        { ...configured, BASE_URL: "https://analytics.example.com/", SERVER_URL: "https://api.example.com/" },
        false
      )
    ).toMatchObject({
      publicUrl: "https://analytics.example.com",
      gscRedirectUri: "https://api.example.com/api/gsc/callback",
    });
  });
  it("requires BASE_URL for actual frontend links even with SERVER_URL configured", () => {
    expect(
      getServiceConfiguration({ ...configured, BASE_URL: "", SERVER_URL: "https://api.example.com" }, false)
    ).toMatchObject({ weeklyReportsEnabled: false, gscEnabled: false });
  });
  it("does not mistake self-hosted for unconfigured", () => {
    expect(getServiceConfiguration(configured, false)).toMatchObject({
      emailEnabled: true,
      weeklyReportsEnabled: true,
      gscEnabled: true,
    });
  });
  it.each(["RESEND_API_KEY", "EMAIL_FROM", "EMAIL_REPLY_TO"])("requires own %s for self-hosted email", key => {
    expect(getServiceConfiguration({ ...configured, [key]: " " }, false)).toMatchObject({
      emailEnabled: false,
      weeklyReportsEnabled: false,
    });
  });
  it("requires a usable base URL for actual transactional and report links", () => {
    expect(getServiceConfiguration({ ...configured, BASE_URL: "file:///tmp" }, false)).toMatchObject({
      emailEnabled: false,
      weeklyReportsEnabled: false,
      gscEnabled: false,
    });
  });
  it.each(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"])("requires %s even when the other credential exists", key => {
    expect(getServiceConfiguration({ ...configured, [key]: "" }, false).gscEnabled).toBe(false);
  });
  it("accepts an explicit GSC callback without enabling email", () => {
    expect(
      getServiceConfiguration(
        {
          BASE_URL: "https://analytics.example.com",
          GOOGLE_CLIENT_ID: "id",
          GOOGLE_CLIENT_SECRET: "secret",
          GOOGLE_REDIRECT_URI: "https://analytics.example.com/api/gsc/callback",
        },
        false
      )
    ).toMatchObject({ gscEnabled: true, emailEnabled: false, weeklyReportsEnabled: false });
  });
  it("retains cloud sender defaults without leaking them to self-hosted", () => {
    expect(
      getServiceConfiguration({ RESEND_API_KEY: "key", BASE_URL: "https://analytics.example.com" }, true).emailEnabled
    ).toBe(true);
    expect(
      getServiceConfiguration({ RESEND_API_KEY: "key", BASE_URL: "https://analytics.example.com" }, false).emailEnabled
    ).toBe(false);
  });
});
