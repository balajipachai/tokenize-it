import path from "node:path";
import type { NextConfig } from "next";

// The deployment record lives at the repo root, outside this app, and is imported
// statically (see lib/deployment.ts). Both the bundler and the file tracer need to be
// told the root is two levels up, or the import resolves outside the project and fails.
const repoRoot = path.resolve(__dirname, "../..");

const nextConfig: NextConfig = {
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
};

export default nextConfig;
