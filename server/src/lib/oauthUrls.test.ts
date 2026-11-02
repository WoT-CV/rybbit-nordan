import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOAuthPlugins, getAuthBaseUrl } from "./oauth.js";

vi.mock("./const.js", () => ({ IS_CLOUD: false }));

const frontend = "http://127.0.0.1:13002";
const api = "http://127.0.0.1:13001";
afterEach(() => vi.unstubAllEnvs());

describe("validated API auth origin", () => {
  it("uses the explicit API while retaining same-origin and development defaults", () => {
    expect(getAuthBaseUrl({ BASE_URL: frontend, SERVER_URL: `${api}/` })).toBe(api);
    expect(getAuthBaseUrl({ BASE_URL: `${frontend}/` })).toBe(frontend);
    expect(getAuthBaseUrl({})).toBe("http://localhost:3002");
    expect(getAuthBaseUrl({ BETTER_AUTH_URL: "https://auth.example.com/api/auth/" })).toBe("https://auth.example.com");
  });
  it.each([
    "",
    " ",
    "file:///tmp",
    "https://api.example.com/path",
    "https://user:secret@api.example.com",
    "https://api.example.com/?query=1",
  ])("does not fall back to the frontend for an invalid explicit SERVER_URL: %s", SERVER_URL => {
    expect(() => getAuthBaseUrl({ BASE_URL: frontend, SERVER_URL })).toThrow("valid HTTP(S) origin");
  });
  it("keeps OAuth UI pages on the frontend while exposing the API resource", () => {
    const plugins = createOAuthPlugins(api, frontend);
    const mcpPlugin = plugins.find(plugin => plugin.id === "oauth-provider");
    expect(mcpPlugin).toBeDefined();
    // Real provider options, not a second hand-built URL implementation.
    expect(mcpPlugin && "options" in mcpPlugin ? mcpPlugin.options : undefined).toMatchObject({
      loginPage: `${frontend}/login`,
      consentPage: `${frontend}/auth/consent`,
      resources: [`${api}/api/mcp`],
    });
  });
  it("real Better Auth generates verification/reset API links but trusts frontend callbacks", async () => {
    const verificationLinks: string[] = [];
    const resetLinks: string[] = [];
    const now = new Date();
    const database = {
      user: [
        {
          id: "user1",
          name: "Fixture",
          email: "person@example.com",
          emailVerified: false,
          createdAt: now,
          updatedAt: now,
        },
      ],
      account: [],
      session: [],
      verification: [],
    };
    const auth = betterAuth({
      baseURL: getAuthBaseUrl({ BASE_URL: frontend, SERVER_URL: api }),
      secret: "synthetic-auth-url-test-secret-at-least-32-characters",
      database: memoryAdapter(database),
      trustedOrigins: [frontend],
      logger: { disabled: true },
      // Better Auth disables this check by default under NODE_ENV=test.
      advanced: { disableOriginCheck: false },
      emailVerification: {
        sendVerificationEmail: async ({ url }) => {
          verificationLinks.push(url);
        },
      },
      // The production reset flow uses OTP. This optional native callback tests
      // the SDK's generated link origin without enabling a new production flow.
      emailAndPassword: {
        enabled: true,
        sendResetPassword: async ({ url }) => {
          resetLinks.push(url);
        },
      },
    });
    const request = (path: string, body: Record<string, string>) =>
      auth.handler(
        new Request(`${api}/api/auth${path}`, {
          method: "POST",
          headers: { origin: frontend, "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      );
    const verification = await request("/send-verification-email", {
      email: "person@example.com",
      callbackURL: `${frontend}/settings/account`,
    });
    expect(verification.status, await verification.clone().text()).toBe(200);
    const verificationUrl = new URL(verificationLinks[0]);
    expect(verificationUrl.origin).toBe(api);
    expect(verificationUrl.pathname).toBe("/api/auth/verify-email");
    expect(verificationUrl.searchParams.get("callbackURL")).toBe(`${frontend}/settings/account`);
    const verified = await auth.handler(new Request(verificationUrl));
    expect(verified.status).toBe(302);
    expect(verified.headers.get("location")).toBe(`${frontend}/settings/account`);
    const reset = await request("/request-password-reset", {
      email: "person@example.com",
      redirectTo: `${frontend}/reset-password`,
    });
    expect(reset.status, await reset.clone().text()).toBe(200);
    const resetUrl = new URL(resetLinks[0]);
    expect(resetUrl.origin).toBe(api);
    expect(resetUrl.pathname).toMatch(/^\/api\/auth\/reset-password\//);
    expect(resetUrl.searchParams.get("callbackURL")).toBe(`${frontend}/reset-password`);
    const resetCallback = await auth.handler(new Request(resetUrl));
    expect(resetCallback.status).toBe(302);
    const resetDestination = new URL(resetCallback.headers.get("location")!);
    expect(resetDestination.origin).toBe(frontend);
    expect(resetDestination.pathname).toBe("/reset-password");
    expect(resetDestination.searchParams.get("token")).toBeTruthy();
    const untrusted = await request("/request-password-reset", {
      email: "person@example.com",
      redirectTo: "https://untrusted.example/reset-password",
    });
    expect(untrusted.status).toBe(403);
    expect(resetLinks).toHaveLength(1);
  });
});
