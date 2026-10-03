import type { FastifyInstance } from 'fastify';

import type { CredentialStore } from '../../gateway/principal.js';
import { authenticate, requireOperator } from '../../gateway/principal.js';
import { correlationIdOf, fail, replyFailure } from '../../gateway/http.js';
import type { CompanyProfileValues, GatewayRuntime } from '../../gateway/ports.js';

interface CompanyProfileRequest {
  readonly company_name: unknown;
  readonly industry: unknown;
  readonly locale: unknown;
  readonly timezone: unknown;
  readonly currency: unknown;
  readonly brand_profile: unknown;
}

const PROFILE_FIELDS: Record<string, true> = {
  company_name: true,
  industry: true,
  locale: true,
  timezone: true,
  currency: true,
  brand_profile: true,
};
const BRAND_FIELDS: Record<string, true> = {
  voice: true,
  prohibited_claims_url: true,
  logo_url: true,
};

const profileBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['company_name', 'industry', 'locale', 'timezone', 'currency', 'brand_profile'],
  properties: {
    company_name: { type: 'string', minLength: 1, maxLength: 120 },
    industry: { anyOf: [{ type: 'null' }, { type: 'string', maxLength: 128 }] },
    locale: { type: 'string' },
    timezone: { type: 'string' },
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    brand_profile: {
      type: 'object',
      additionalProperties: false,
      properties: {
        voice: { type: 'string', minLength: 1 },
        prohibited_claims_url: { type: 'string', format: 'uri' },
        logo_url: { type: 'string', format: 'uri' },
      },
    },
  },
} as const;
const profileResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['tenant_id', 'company_name', 'industry', 'locale', 'timezone', 'currency', 'brand_profile', 'version', 'updated_at'],
  properties: {
    tenant_id: { type: 'string', format: 'uuid' },
    company_name: { type: 'string', maxLength: 120 },
    industry: { anyOf: [{ type: 'null' }, { type: 'string' }] },
    locale: { type: 'string' },
    timezone: { type: 'string' },
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    brand_profile: profileBodySchema.properties.brand_profile,
    version: { type: 'integer', minimum: 1 },
    updated_at: { type: 'string', format: 'date-time' },
  },
} as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Exported so tenant provisioning reuses the exact company-profile field validators. */
export function isTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** Exported so tenant provisioning reuses the exact company-profile field validators. */
export function isCurrency(value: string): boolean {
  if (!/^[A-Z]{3}$/.test(value)) return false;
  try {
    const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
    if (intl.supportedValuesOf !== undefined) return intl.supportedValuesOf('currency').includes(value);
    new Intl.NumberFormat('en', { style: 'currency', currency: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** Exported so tenant provisioning reuses the exact company-profile field validators. */
export function isLocale(value: string): boolean {
  if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(value)) return false;
  try {
    return Intl.getCanonicalLocales(value).length === 1;
  } catch {
    return false;
  }
}

function requireHttpsUrl(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') fail('VALIDATION_FAILED', `${field} must be an HTTPS URL`);
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname.length > 0 && url.username.length === 0 && url.password.length === 0) {
      return url.toString();
    }
  } catch {
    // The field is reported as a stable validation refusal below.
  }
  fail('VALIDATION_FAILED', `${field} must be an HTTPS URL`);
}

function profileValues(value: unknown): CompanyProfileValues {
  if (!isObject(value)) fail('VALIDATION_FAILED', 'profile body must be an object');
  if (Object.keys(value).some((key) => PROFILE_FIELDS[key] !== true)) fail('VALIDATION_FAILED', 'profile body contains an unknown field');
  const body = value as unknown as CompanyProfileRequest;
  if (typeof body.company_name !== 'string' || body.company_name.trim().length < 1 || body.company_name.trim().length > 120) {
    fail('VALIDATION_FAILED', 'company_name must contain 1 to 120 characters');
  }
  if (body.industry !== null && (typeof body.industry !== 'string' || body.industry.trim().length === 0 || body.industry.trim().length > 128)) {
    fail('VALIDATION_FAILED', 'industry must be null or a non-empty string of at most 128 characters');
  }
  if (typeof body.locale !== 'string' || !isLocale(body.locale)) fail('VALIDATION_FAILED', 'locale must be a valid BCP-47 locale');
  if (typeof body.timezone !== 'string' || !isTimezone(body.timezone)) fail('VALIDATION_FAILED', 'timezone must be an IANA timezone');
  if (typeof body.currency !== 'string' || !isCurrency(body.currency)) fail('VALIDATION_FAILED', 'currency must be a supported ISO-4217 code');
  if (!isObject(body.brand_profile)) fail('VALIDATION_FAILED', 'brand_profile must be an object');

  const brand = body.brand_profile;
  if (Object.keys(brand).some((key) => BRAND_FIELDS[key] !== true)) fail('VALIDATION_FAILED', 'brand_profile contains an unknown field');
  if (brand.voice !== undefined && (typeof brand.voice !== 'string' || brand.voice.trim().length === 0)) {
    fail('VALIDATION_FAILED', 'brand_profile.voice must be a non-empty string');
  }
  const prohibited_claims_url = requireHttpsUrl(brand.prohibited_claims_url, 'brand_profile.prohibited_claims_url');
  const logo_url = requireHttpsUrl(brand.logo_url, 'brand_profile.logo_url');
  return {
    company_name: body.company_name.trim(),
    industry: body.industry === null ? null : (body.industry as string).trim(),
    locale: body.locale,
    timezone: body.timezone,
    currency: body.currency,
    brand_profile: {
      ...(brand.voice === undefined ? {} : { voice: brand.voice.trim() as string }),
      ...(prohibited_claims_url === undefined ? {} : { prohibited_claims_url }),
      ...(logo_url === undefined ? {} : { logo_url }),
    },
  };
}

function expectedVersion(value: string | string[] | undefined): number {
  if (typeof value !== 'string') fail('VALIDATION_FAILED', 'If-Match must contain the profile version');
  const match = /^(?:"([1-9]\d*)"|([1-9]\d*))$/.exec(value);
  const version = Number(match?.[1] ?? match?.[2]);
  if (match === null || !Number.isSafeInteger(version)) fail('VALIDATION_FAILED', 'If-Match must contain a positive profile version');
  return version;
}


/** Company profile read/write endpoints, tenant-bound to the authenticated operator. */
export function registerCompanyProfileRoutes(
  app: FastifyInstance,
  deps: { readonly runtime: GatewayRuntime; readonly credentials: CredentialStore },
): void {
  const preHandler = authenticate(deps);

  app.get(
    '/company/settings/profile',
    {
      preHandler,
      schema: {
        tags: ['Company settings'],
        summary: 'Get company profile',
        response: { 200: profileResponseSchema },
      },
    },
    async (request, reply) => {
      const runtime = deps.runtime;
      try {
        const principal = requireOperator(request);
        const profiles = runtime.companyProfile;
        if (profiles === undefined) fail('PROVIDER_TIMEOUT', 'company profile settings are unavailable');
        const profile = await profiles.get(principal.tenant_id);
        if (profile === null) fail('NOT_FOUND', 'company profile was not found');
        reply.header('ETag', `"${profile.version}"`);
        return reply.code(200).send(profile);
      } catch (error) {
        return replyFailure(reply, error, correlationIdOf(request, runtime));
      }
    },
  );

  app.put<{ Body: unknown }>(
    '/company/settings/profile',
    {
      preHandler,
      schema: {
        tags: ['Company settings'],
        summary: 'Update company profile',
        body: profileBodySchema,
        response: { 200: profileResponseSchema },
      },
    },
    async (request, reply) => {
      const runtime = deps.runtime;
      try {
        const principal = requireOperator(request, 'settings:manage');
        const profiles = runtime.companyProfile;
        if (profiles === undefined) fail('PROVIDER_TIMEOUT', 'company profile settings are unavailable');
        const correlation_id = correlationIdOf(request, runtime);
        const result = await profiles.update({
          tenant_id: principal.tenant_id,
          values: profileValues(request.body),
          expected_version: expectedVersion(request.headers['if-match']),
          actor_kind: principal.kind,
          actor_id: principal.operator_id ?? principal.kind,
          correlation_id,
        });
        if (result.status === 'VERSION_CONFLICT') {
          fail('VERSION_CONFLICT', 'company profile changed since it was loaded', { current_version: result.current_version });
        }
        reply.header('ETag', `"${result.profile.version}"`);
        return reply.code(200).send(result.profile);
      } catch (error) {
        return replyFailure(reply, error, correlationIdOf(request, runtime));
      }
    },
  );
}
