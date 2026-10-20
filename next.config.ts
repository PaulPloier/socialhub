import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Interne, voll dynamische App: klassisches dynamisches Rendering statt Cache Components.
  cacheComponents: false,
  // Native/WASM-Pakete nicht bundeln.
  serverExternalPackages: ["@electric-sql/pglite", "pg"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  images: {
    remotePatterns: [{ protocol: "https", hostname: "**" }],
  },
};

export default nextConfig;
