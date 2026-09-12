/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Consume the TypeScript workspace packages directly (no prebuild step).
  transpilePackages: ['@roomriot/contracts'],
};

export default nextConfig;
