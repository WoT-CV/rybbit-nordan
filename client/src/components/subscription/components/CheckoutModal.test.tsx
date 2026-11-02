import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadStripe: vi.fn(),
  eagerRootImport: vi.fn(),
  provider: vi.fn(),
  stripePromise: Promise.resolve(null),
}));
vi.mock("@stripe/stripe-js", () => {
  mocks.eagerRootImport();
  throw new Error("Eager Stripe SDK root must not be imported");
});
vi.mock("@stripe/stripe-js/pure", () => ({ loadStripe: mocks.loadStripe }));
vi.mock("@stripe/react-stripe-js", () => ({
  EmbeddedCheckoutProvider: (props: { children: ReactNode; stripe: unknown; options: unknown }) => {
    mocks.provider(props);
    return <section>{props.children}</section>;
  },
  EmbeddedCheckout: () => <div>Embedded checkout</div>,
}));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? children : null),
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.loadStripe.mockReturnValue(mocks.stripePromise);
  vi.stubEnv("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "pk_test_synthetic");
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("checkout module environment boundary", () => {
  it.each([undefined, "false", "TRUE", "1"])("neither initializes nor renders Stripe when CLOUD=%j", async cloud => {
    vi.stubEnv("NEXT_PUBLIC_CLOUD", cloud);
    const { CheckoutModal } = await import("./CheckoutModal");
    expect(mocks.loadStripe).not.toHaveBeenCalled();
    expect(mocks.eagerRootImport).not.toHaveBeenCalled();
    const { container } = render(<CheckoutModal clientSecret="synthetic_client_secret" open onOpenChange={vi.fn()} />);
    expect(container.innerHTML).toBe("");
    expect(mocks.provider).not.toHaveBeenCalled();
  });
  it("preserves the cloud SDK promise and embedded client-secret flow", async () => {
    vi.stubEnv("NEXT_PUBLIC_CLOUD", "true");
    const { CheckoutModal } = await import("./CheckoutModal");
    await import("./CheckoutModal");
    expect(mocks.loadStripe).toHaveBeenCalledExactlyOnceWith("pk_test_synthetic");
    expect(mocks.eagerRootImport).not.toHaveBeenCalled();
    const { rerender } = render(<CheckoutModal clientSecret={null} open onOpenChange={vi.fn()} />);
    expect(screen.queryByText("Embedded checkout")).toBeNull();
    rerender(<CheckoutModal clientSecret="synthetic_client_secret" open onOpenChange={vi.fn()} />);
    expect(screen.getByText("Embedded checkout")).not.toBeNull();
    expect(mocks.provider.mock.calls[0][0]).toMatchObject({
      stripe: mocks.stripePromise,
      options: { clientSecret: "synthetic_client_secret" },
    });
    expect(mocks.loadStripe).toHaveBeenCalledTimes(1);
  });
  it("can import the actual pure loader and React bindings without an eager root import or injected script", async () => {
    const loader = await vi.importActual<typeof import("@stripe/stripe-js/pure")>("@stripe/stripe-js/pure");
    const bindings = await vi.importActual<typeof import("@stripe/react-stripe-js")>("@stripe/react-stripe-js");
    await Promise.resolve();
    expect(typeof loader.loadStripe).toBe("function");
    expect(typeof bindings.EmbeddedCheckoutProvider).toBe("function");
    expect(mocks.eagerRootImport).not.toHaveBeenCalled();
    expect(document.querySelector('script[src*="stripe.com"]')).toBeNull();
  });
});
