import { findTenantBffRoute } from './bff-routes';
export function decodeRouteSegments(segments: readonly string[]): string[] | undefined {
  const decoded: string[] = [];
  for (const segment of segments) {
    let value: string;
    try {
      value = decodeURIComponent(segment);
    } catch {
      return undefined;
    }
    // Catch both values decoded by Next and residual encodings from a double-encoded
    // traversal attempt. A path parameter must never become a path separator.
    if (
      value.length === 0
      || value === '.'
      || value === '..'
      || value.includes('/')
      || value.includes('\\')
      || value.includes('..')
      || /%(?:2f|5c|2e)/i.test(value)
    ) return undefined;
    decoded.push(value);
  }
  return decoded;
}

export function routePath(segments: readonly string[] | undefined): string | undefined {
  if (!segments || segments.length === 0) return undefined;
  return decodeRouteSegments(segments)?.join('/');
}

export function isAllowedPath(path: string, method: string): boolean {
  return findTenantBffRoute(path, method) !== undefined;
}
