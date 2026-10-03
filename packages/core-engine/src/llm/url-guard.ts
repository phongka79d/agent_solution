import { isIP } from 'node:net';

const NON_PUBLIC_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.test', '.invalid'];

function ipv4IsNonPublic(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts as [number, number, number, number];
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 2 || b === 168))
    || (a === 198 && (b === 18 || b === 19 || b === 51))
    || (a === 203 && b === 0 && c === 113);
}

function ipv6Groups(address: string): readonly number[] | null {
  const normalized = address.toLowerCase().split('%')[0] ?? '';
  if (!normalized.includes(':')) return null;
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const parseHalf = (half: string): number[] => half.length === 0 ? [] : half.split(':').map((group) => Number.parseInt(group, 16));
  const left = parseHalf(halves[0] ?? '');
  const right = parseHalf(halves[1] ?? '');
  if (left.some((group) => !Number.isInteger(group) || group < 0 || group > 65535)
    || right.some((group) => !Number.isInteger(group) || group < 0 || group > 65535)) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function ipv6IsNonPublic(address: string): boolean {
  const groups = ipv6Groups(address);
  if (groups === null) return true;
  const first = groups[0] ?? 0;
  const second = groups[1] ?? 0;
  if (groups.every((group) => group === 0) || (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1)) return true;
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00) return true;
  if (groups.slice(0, 5).every((group) => group === 0) && (groups[5] ?? 0) === 0xffff) {
    const mapped = `${(groups[6] ?? 0) >> 8}.${(groups[6] ?? 0) & 255}.${(groups[7] ?? 0) >> 8}.${(groups[7] ?? 0) & 255}`;
    return ipv4IsNonPublic(mapped);
  }
  // Documentation and benchmarking ranges are not valid provider destinations either.
  return first === 0x2001 && (second === 0x0db8 || second === 0x0002);
}

/** Refuses unsafe provider destinations; local HTTP stubs are limited to local/CI profiles. */
export function assertSafeProviderUrl(value: string, appEnv: string | undefined = process.env.APP_ENV): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('LLM_PROVIDER_URL_INVALID: an absolute HTTPS URL is required.');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const localHttp = url.protocol === 'http:'
    && (appEnv === 'local' || appEnv === 'ci')
    && ['llm-stub', 'localhost', '127.0.0.1', '::1', 'host.docker.internal'].includes(host);
  if ((!localHttp && url.protocol !== 'https:') || host.length === 0 || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new TypeError('LLM_PROVIDER_URL_INVALID: HTTPS URL without userinfo, query, or fragment is required.');
  }
  if (localHttp) return;
  if (NON_PUBLIC_SUFFIXES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix))) {
    throw new TypeError('LLM_PROVIDER_URL_UNSAFE: provider host must be publicly routable.');
  }
  const ipVersion = isIP(host);
  if ((ipVersion === 4 && ipv4IsNonPublic(host)) || (ipVersion === 6 && ipv6IsNonPublic(host))) {
    throw new TypeError('LLM_PROVIDER_URL_UNSAFE: provider host must not be private, loopback, or link-local.');
  }
}
