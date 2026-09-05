import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "@openai/codex-sdk",
    "@solarisdk/browser",
    "@solarisdk/sandbox",
    "@solarisdk/desktop",
    "patchright-core",
  ],
};

export default nextConfig;
