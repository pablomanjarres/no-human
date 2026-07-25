import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// Pin the workspace root explicitly. Without it Turbopack walks up, finds the
// lockfile in the main checkout instead of this worktree, and resolves `next`
// from the wrong tree.
const here = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The demo must run with no network. Nothing here may reach out at request time.
  images: { unoptimized: true },
  // The floating dev badge sits on top of the transport bar during a demo.
  devIndicators: false,
  turbopack: { root: resolve(here, "..", "..") },
};

export default nextConfig;
