/** Local API gateway origin used when no build-time URL is configured. */
export const DEFAULT_API_ORIGIN = 'http://localhost:4000';

/**
 * Origin of the API gateway. Inlined at build time from `NEXT_PUBLIC_API_URL`;
 * browser code never receives a server-only value or a credential.
 */
export function apiOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_API_URL;

  return configured !== undefined && configured.length > 0 ? configured : DEFAULT_API_ORIGIN;
}
