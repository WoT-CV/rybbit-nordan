import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl/plugin", () => ({ default: () => (config: unknown) => config }));

import nextConfig from "../../next.config";
import { GET as getRobots } from "../app/robots.txt/route";
import { GET as getSitemap } from "../app/sitemap.xml/route";

describe("private application HTTP indexing protection", () => {
  it("applies an unconditional noindex header to all paths, including static files and widgets", async () => {
    expect(await nextConfig.headers!()).toEqual([
      {
        source: "/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow, nosnippet, noimageindex" }],
      },
    ]);
  });

  it.each([
    ["robots.txt", getRobots],
    ["sitemap.xml", getSitemap],
  ])("retires %s without publishing a crawl or sitemap manifest", async (_name, getResponse) => {
    const response = getResponse();
    expect(response.status).toBe(410);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toBe("");
  });
});
