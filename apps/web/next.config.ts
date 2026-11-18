import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@arcatic/ui", "@arcatic/core"],
  poweredByHeader: false,
  webpack: (cfg) => {
    // workspace packages use NodeNext-style "./x.js" specifiers that point at .ts sources
    cfg.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"], ".mjs": [".mts", ".mjs"] };
    return cfg;
  },
};
export default config;
