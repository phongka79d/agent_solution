/** @type {import('next').NextConfig} */
const isProduction = process.env.NODE_ENV === 'production';

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  ...(isProduction ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }] : []),
];

const nextConfig = {
  output: process.env.NEXT_STANDALONE === '1' ? 'standalone' : undefined,
  reactStrictMode: true,
  eslint: { ignoreDuringBuilds: true },
  async redirects() {
    return [
      { source: '/demo/readiness', destination: '/system-health', permanent: false },
      { source: '/analytics', destination: '/usage', permanent: false },
    ];
  },
  async headers() {
    return [{ source: '/(.*)', headers: securityHeaders }];
  },
  experimental: { instrumentationHook: true },
};
export default nextConfig;
