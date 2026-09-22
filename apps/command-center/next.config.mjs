/** @type {import('next').NextConfig} */
const nextConfig = {
  output: process.env.NEXT_STANDALONE === '1' ? 'standalone' : undefined,
  reactStrictMode: true,
  eslint: { ignoreDuringBuilds: true },
  // Next 14 does not load src/instrumentation.ts without this; the Command Center's
  // fail-closed env check runs there (see src/instrumentation.ts).
  experimental: { instrumentationHook: true },
};

export default nextConfig;
