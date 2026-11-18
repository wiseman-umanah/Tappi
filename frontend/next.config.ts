import type { NextConfig } from "next";

// Static export: `next build` writes the whole site to out/, which Cloudflare Pages serves.
// Response headers live in public/_headers and the waitlist endpoint in functions/api/waitlist.ts.
const nextConfig: NextConfig = {
  output: "export",
  images: {
    // No image server on static hosting: pick from the WebP sizes made by `pnpm images`.
    loader: "custom",
    loaderFile: "./src/lib/image-loader.ts",
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
