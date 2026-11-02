import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// No SDK mock: construction is local; no API method is called in these tests.
// Dotenv alone is isolated so a developer's .env cannot influence the matrix.
vi.mock("dotenv", () => ({ default: { config: vi.fn() } }));

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("real Stripe SDK construction gate", () => {
  it.each([undefined, "false", "TRUE"])("returns null with CLOUD=%s even when a key exists", async cloud => {
    vi.stubEnv("CLOUD", cloud);
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_synthetic_no_network");
    expect((await import("./stripe.js")).stripe).toBeNull();
  });

  it.each([undefined, ""])("returns null for cloud with an absent/empty key (%s)", async key => {
    vi.stubEnv("CLOUD", "true");
    vi.stubEnv("STRIPE_SECRET_KEY", key);
    expect((await import("./stripe.js")).stripe).toBeNull();
  });

  it("constructs the real SDK for exact cloud true plus a synthetic key without requesting an API", async () => {
    vi.stubEnv("CLOUD", "true");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_synthetic_no_network");
    const { stripe } = await import("./stripe.js");
    expect(stripe).toBeInstanceOf(Stripe);
    expect(stripe?.customers.retrieve).toBeTypeOf("function");
  });
});
