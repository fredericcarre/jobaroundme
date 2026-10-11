import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["unpdf"],
  // PDF.js is loaded by a disposable child process at runtime, so static
  // tracing cannot discover the parser or its entry script from the route.
  outputFileTracingIncludes: {
    "/api/cv": [
      "./lib/pdf-extractor-child.cjs",
      "./node_modules/unpdf/package.json",
      "./node_modules/unpdf/dist/index.cjs",
      "./node_modules/unpdf/dist/pdfjs.mjs",
    ],
  },
  // Next 16.4 defaults to its CLI bridge, whose --showConfig capture is
  // incompatible with the current TypeScript 6 wrapper in this runtime.
  experimental: {
    useTypeScriptCli: false,
  },
};

export default nextConfig;
