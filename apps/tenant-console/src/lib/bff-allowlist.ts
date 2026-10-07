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
  const verb = method.toUpperCase();
  if (verb === 'GET') {
    if (/^company\/(?:overview|attention|ai-team|activity|integrations)$/.test(path)) return true;
    if (path === 'company/settings/governance') return true;
    if (/^customers(?:\/[^/]+\/(?:profile|timeline))?$/.test(path)) return true;
    if (path === 'campaigns' || (/^campaigns\/[^/]+$/.test(path) && path !== 'campaigns/drafts')) return true;
    if (/^approvals(?:\/[^/]+)?$/.test(path)) return true;
    if (/^conversations(?:\/[^/]+)?$/.test(path)) return true;
    if (/^conversations\/[^/]+\/(?:messages|summary)$/.test(path)) return true;
    if (/^runs\/[^/]+\/trace$/.test(path)) return true;
    if (path === 'demo/catalog') return true;
    if (/^telemetry\/(?:kpi|kpi-snapshot|stream)$/.test(path)) return true;
    return false;
  }
  if (verb === 'POST') {
    if (path === 'demo/widget-session') return true;
    if (path === 'campaigns/drafts') return true;
    if (/^approvals\/[^/]+\/decision$/.test(path)) return true;
    if (/^conversations\/[^/]+\/(?:takeover|takeover\/heartbeat|resume|operator-messages)$/.test(path)) return true;
    if (/^storefront\/(?:stream|events)$/.test(path)) return true;
    return false;
  }
  return false;
}
