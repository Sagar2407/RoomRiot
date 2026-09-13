/** @type {import('next').NextConfig} */
const staticExport = process.env.BUILD_STATIC === '1';

const nextConfig = {
  reactStrictMode: true,
  // Consume the TypeScript workspace packages directly (no prebuild step).
  transpilePackages: ['@roomriot/contracts'],
  // Single-service build: export a static site the game server serves on one origin.
  ...(staticExport ? { output: 'export', trailingSlash: true, images: { unoptimized: true } } : {}),
};

export default nextConfig;
