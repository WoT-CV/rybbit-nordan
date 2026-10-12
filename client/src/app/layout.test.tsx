import { describe, expect, it, vi } from "vitest";

vi.mock("next/font/google", () => ({ Inter: () => ({ className: "inter" }) }));
vi.mock("./Providers", () => ({ Providers: () => null }));
vi.mock("../lib/utils", () => ({ cn: (...classes: string[]) => classes.join(" ") }));

import { metadata } from "./layout";

describe("private application metadata", () => {
  it("opts every page out of search indexing, snippets and image indexing", () => {
    expect(metadata.robots).toEqual({
      index: false,
      follow: false,
      nosnippet: true,
      noimageindex: true,
    });
  });

  it("does not advertise search or social metadata", () => {
    for (const key of ["alternates", "description", "keywords", "metadataBase", "openGraph", "twitter"]) {
      expect(metadata).not.toHaveProperty(key);
    }
  });
});
