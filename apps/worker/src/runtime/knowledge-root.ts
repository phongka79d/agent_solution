import { isAbsolute, resolve as resolvePath } from 'node:path';

/**
 * A server-owned knowledge root resolver. A configured root is usable only when
 * its tenant scope is explicit; the resolver never derives scope from a caller
 * or falls back to another root.
 */
export interface TenantKnowledgeRootResolver {
  readonly root_dir: string;
  resolve(tenant_id: string): string;
}

export interface TenantKnowledgeRootResolverOptions {
  readonly root_dir: string;
  /** Explicit tenant allowlist for the configured root. */
  readonly tenant_ids?: readonly string[];
  /** A single server-verified tenant binding, equivalent to a one-item allowlist. */
  readonly tenant_id?: string;
  /** Only for the package default root and injected fake-root test seams. */
  readonly allow_unbound?: boolean;
}

export class TenantKnowledgeRootError extends Error {
  readonly code:

    | 'KNOWLEDGE_ROOT_INVALID'
    | 'KNOWLEDGE_ROOT_TENANT_BINDING_REQUIRED'
    | 'KNOWLEDGE_ROOT_TENANT_INVALID'
    | 'KNOWLEDGE_ROOT_TENANT_MISMATCH';

  constructor(code: TenantKnowledgeRootError['code'], message: string) {
    super(`[${code}] ${message}`);
    this.name = 'TenantKnowledgeRootError';
    this.code = code;
  }
}

function normalizeTenantIds(options: TenantKnowledgeRootResolverOptions): readonly string[] {
  if (options.tenant_ids !== undefined && !Array.isArray(options.tenant_ids)) {
    throw new TenantKnowledgeRootError(
      'KNOWLEDGE_ROOT_TENANT_INVALID',
      'Configured knowledge root tenant allowlist must be an array',
    );
  }
  const values = [
    ...(options.tenant_ids ?? []),
    ...(options.tenant_id === undefined ? [] : [options.tenant_id]),
  ];
  const normalized = values.map((value) => {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new TenantKnowledgeRootError(
        'KNOWLEDGE_ROOT_TENANT_INVALID',
        'Configured knowledge root tenant binding must contain only non-empty tenant IDs',
      );
    }
    return value.trim();
  });
  return Object.freeze([...new Set(normalized)]);
}

/**
 * Creates a resolver for one physical knowledge root.
 *
 * `allow_unbound` is deliberately opt-in and is used only by the shipped
 * package root (whose draft documents are still filtered) and direct injected
 * fake-root tests. Configured roots MUST provide tenant_ids or tenant_id.
 */
export function createTenantKnowledgeRootResolver(
  options: TenantKnowledgeRootResolverOptions,
): TenantKnowledgeRootResolver {
  if (!options || typeof options.root_dir !== 'string' || options.root_dir.trim().length === 0) {
    throw new TenantKnowledgeRootError(
      'KNOWLEDGE_ROOT_INVALID',
      'Knowledge root must be a non-empty absolute directory path',
    );
  }

  const rootDir = options.root_dir.trim();
  if (!isAbsolute(rootDir)) {
    throw new TenantKnowledgeRootError(
      'KNOWLEDGE_ROOT_INVALID',
      'Knowledge root must be an absolute directory path',
    );
  }

  const tenantIds = normalizeTenantIds(options);
  const allowUnbound = options.allow_unbound === true;

  return Object.freeze({
    root_dir: resolvePath(rootDir),
    resolve(tenant_id: string): string {
      if (typeof tenant_id !== 'string' || tenant_id.trim().length === 0) {
        throw new TenantKnowledgeRootError(
          'KNOWLEDGE_ROOT_TENANT_INVALID',
          'Tenant ID must be a non-empty string',
        );
      }

      const normalizedTenant = tenant_id.trim();
      if (tenantIds.length === 0 && !allowUnbound) {
        throw new TenantKnowledgeRootError(
          'KNOWLEDGE_ROOT_TENANT_BINDING_REQUIRED',
          'Configured knowledge root has no explicit tenant binding',
        );
      }
      if (tenantIds.length > 0 && !tenantIds.includes(normalizedTenant)) {
        throw new TenantKnowledgeRootError(
          'KNOWLEDGE_ROOT_TENANT_MISMATCH',
          `Tenant '${normalizedTenant}' is not bound to this knowledge root`,
        );
      }
      return resolvePath(rootDir);
    },
  });
}

/** Parses a comma-separated tenant allowlist without introducing a startup requirement. */
export function parseTenantAllowlist(raw?: string): readonly string[] {
  if (raw === undefined) return Object.freeze([]);
  if (typeof raw !== 'string') {
    throw new TenantKnowledgeRootError(
      'KNOWLEDGE_ROOT_TENANT_INVALID',
      'Tenant allowlist must be a comma-separated string',
    );
  }
  const values = raw.split(',').map((value) => value.trim()).filter(Boolean);
  return Object.freeze([...new Set(values)]);
}
