/** @type {import('next').NextConfig} */
const nextConfig = {
  // Interne, voll dynamische App: klassisches dynamisches Rendering statt Cache Components.
  cacheComponents: false,
  // Native/WASM-Pakete nicht bundeln.
  serverExternalPackages: ["@electric-sql/pglite", "pg"],
  images: {
    remotePatterns: [{ protocol: "https", hostname: "**" }],
  },
};

export default nextConfig;
