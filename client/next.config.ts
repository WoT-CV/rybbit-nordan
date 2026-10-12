import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const withNextIntl = createNextIntlPlugin({
  experimental: {
    srcPath: "./src",
    extract: true,
    messages: {
      sourceLocale: "en",
      path: "./messages",
      format: "json",
      locales: ["en", "de", "fr", "zh", "es", "pl", "it", "ko", "pt", "ja", "cs", "uk"],
    },
  },
});

const nextConfig: NextConfig = {
  // Repository-specific agent guidance is maintained explicitly, not generated.
  agentRules: false,
  output: "standalone",
  outputFileTracingRoot: repositoryRoot,
  transpilePackages: ["@rybbit/shared"],
  turbopack: {
    root: repositoryRoot,
    resolveAlias: {
      "@rybbit/shared": "./shared/src/index.ts",
    },
  },
  env: {
    NEXT_PUBLIC_BACKEND_URL: process.env.NEXT_PUBLIC_BACKEND_URL,
    NEXT_PUBLIC_DISABLE_SIGNUP: process.env.NEXT_PUBLIC_DISABLE_SIGNUP,
    NEXT_PUBLIC_LITE_DASHBOARD: process.env.NEXT_PUBLIC_LITE_DASHBOARD,
    NEXT_PUBLIC_APP_VERSION: process.env.npm_package_version,
    NEXT_PUBLIC_WOTCV_GIT_SHA: process.env.NEXT_PUBLIC_WOTCV_GIT_SHA,
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow, nosnippet, noimageindex" }],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
