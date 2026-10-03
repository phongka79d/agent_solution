/** @type {import('next').NextConfig} */

function appUrlIsHttps() {
  const raw = process.env.NEXT_PUBLIC_APP_URL ?? process.env.APP_URL ?? process.env.NEXTAUTH_URL;
  if (!raw) return false;
  try {
    return new URL(raw).protocol === 'https:';
  } catch {
    return false;
  }
}

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  ...(process.env.NODE_ENV === 'production' && appUrlIsHttps()
    ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }]
    : []),
];

const nextConfig = {
  output: process.env.NEXT_STANDALONE === '1' ? 'standalone' : undefined,
  reactStrictMode: true,
  eslint: { ignoreDuringBuilds: true },
  // Next 14 does not load src/instrumentation.ts without this; the Tenant Console's
  // fail-closed env check runs there (see src/instrumentation.ts).
  experimental: { instrumentationHook: true },
  async headers() {
    return [{ source: '/(.*)', headers: securityHeaders }];
  },
  async redirects() {
    return [
      { source: '/demo/operations', destination: '/conversations', permanent: false },
      { source: '/takeover', destination: '/conversations', permanent: false },
      { source: '/demo/campaigns', destination: '/campaigns', permanent: false },
      { source: '/demo/trace', has: [{ type: 'query', key: 'run_id' }], destination: '/runs/:run_id', permanent: false },
      { source: '/demo/trace', destination: '/', permanent: false },
      { source: '/demo/storefront', destination: '/ai-team/sales/try', permanent: false },
    ];
  },
};

export default nextConfig;
