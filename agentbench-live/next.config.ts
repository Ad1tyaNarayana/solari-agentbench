import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "@solarisdk/browser",
    "@solarisdk/sandbox",
    "@solarisdk/desktop",
  ],
};

export default nextConfig;
