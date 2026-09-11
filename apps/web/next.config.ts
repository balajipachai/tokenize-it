import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The deployment record is read at build/runtime from the repo root.
  outputFileTracingRoot: process.cwd(),
};

export default nextConfig;
