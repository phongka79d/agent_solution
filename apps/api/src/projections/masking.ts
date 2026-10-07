/** Identity classes whose raw values are never returned by a company projection. */
export type MaskedIdentityKind = 'email' | 'phone' | 'line' | 'whatsapp' | 'zalo' | 'web' | string;

/** Masks an email while retaining enough shape for an operator to recognise the channel. */
export function maskEmail(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.length === 0) return null;
  const at = value.indexOf('@');
  if (at <= 0 || at === value.length - 1) return '***';
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const domainName = dot > 0 ? domain.slice(0, dot) : domain;
  const suffix = dot > 0 ? domain.slice(dot) : '';
  return `${local.slice(0, 1)}***@${domainName.slice(0, 1)}***${suffix}`;
}

/** Masks a phone or numeric channel identifier, preserving only its final four digits. */
export function maskPhone(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.length === 0) return null;
  const digits = value.replace(/\D/g, '');
  if (digits.length === 0) return '***';
  return `***${digits.slice(-4)}`;
}

/** Masks opaque channel IDs without exposing a customer handle in an API response. */
export function maskOpaqueIdentity(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.length === 0) return null;
  if (value.length <= 4) return '***';
  return `${value.slice(0, 1)}***${value.slice(-2)}`;
}

/** Dispatches to the channel-specific mask; unknown channels fail closed to an opaque mask. */
export function maskIdentity(value: string | null | undefined, kind: MaskedIdentityKind): string | null {
  const normalized = kind.toLowerCase();
  if (normalized === 'email') return maskEmail(value);
  if (normalized === 'phone' || normalized === 'tel' || normalized === 'mobile' || normalized === 'sms') {
    return maskPhone(value);
  }
  return maskOpaqueIdentity(value);
}
