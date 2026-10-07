import enMessages from './en.js';
import viMessages from './vi.js';

export type Locale = 'vi' | 'en';

export const DEFAULT_LOCALE: Locale = 'vi';

export const messages: Record<Locale, Record<string, string>> = {
  vi: viMessages,
  en: enMessages,
};

function interpolate(template: string, params: Record<string, string | number> | undefined): string {
  if (params === undefined) return template;
  return template.replace(/\{([^{}]+)\}/g, (placeholder, key: string) => {
    const value = params[key];
    return value === undefined ? placeholder : String(value);
  });
}

export function t(
  key: string,
  params?: Record<string, string | number>,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const localized = messages[locale][key] ?? messages.en[key] ?? key;
  return interpolate(localized, params);
}

export function createTranslator(locale: Locale): (
  key: string,
  params?: Record<string, string | number>,
) => string {
  return (key, params) => t(key, params, locale);
}
