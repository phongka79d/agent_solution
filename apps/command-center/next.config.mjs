/** @type {import('next').NextConfig} */
const nextConfig = {
  output: process.env.NEXT_STANDALONE === '1' ? 'standalone' : undefined,
  reactStrictMode: true,
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
