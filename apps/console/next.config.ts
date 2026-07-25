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
  // One deployment, one URL: the static landing page from apps/sick-clone-ui is
  // synced into public/ and served at /, and the workspace lives under /console.
  async rewrites() {
    return [{ source: "/", destination: "/index.html" }];
  },
  // The /api/ask route reads the built RAG index off disk at request time.
  // Next's tracer cannot see a path assembled at runtime, so the 4 MB artifact
  // would be missing from the serverless bundle and every request would 500 in
  // production while working perfectly in `next dev`. Trace it in explicitly.
  outputFileTracingRoot: resolve(here, "..", ".."),
  outputFileTracingIncludes: {
    "/api/ask": ["../../sick-catalog-dataset/rag-index.json"],
  },
};

export default nextConfig;
