import type { SalesSkillToolPortOptions } from './tool-port.js';
import { SalesSkillToolError } from './quote-payment-guards.js';

export interface ProductItem {
  readonly product_id?: string;
  readonly id?: string;
  readonly sku?: string;
  readonly sku_id?: string;
  readonly name?: string;
  readonly title?: string;
  readonly description?: string;
  readonly category?: string;
  readonly use_case?: string;
  readonly key_attribute?: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
  readonly original_list_price?: number;
  readonly list_price?: number;
  readonly price?: number;
  readonly currency?: string;
  readonly status?: string;
  readonly is_active?: boolean;
  readonly active?: boolean;
  readonly tenant_id?: string;
  readonly categories?: readonly string[];
  readonly tags?: readonly string[];
  readonly category_path?: string | readonly string[];
}

export interface InventoryItem {
  readonly tenant_id?: string;
  readonly sku_id?: string;
  readonly sku?: string;
  readonly total_available_to_promise?: number;
}

interface ProviderEnvelope<T> {
  readonly snapshot_at?: string;
  readonly updated_at?: string;
  readonly observed_at?: string;
  readonly tenant_id?: string;
  readonly items?: readonly T[];
}

interface ErpReadResultRecord {
  readonly value: unknown;
  readonly observed_at: string;
  readonly tenant_id: string;
}

export interface CatalogRead {
  readonly snapshot_at: string;
  readonly observed_at: string;
  readonly tenant_id: string;
  readonly items: readonly ProductItem[];
}

export interface InventoryRead {
  readonly snapshot_at: string;
  readonly observed_at: string;
  readonly tenant_id: string;
  readonly item: InventoryItem;
}

export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim().length === 0) return false;
  return !Number.isNaN(new Date(value).getTime());
}

export function isActiveProduct(product: ProductItem): boolean {
  if (typeof product.is_active === 'boolean') return product.is_active;
  if (typeof product.active === 'boolean') return product.active;
  return typeof product.status === 'string' && product.status.toUpperCase() === 'ACTIVE';
}

export function productSku(product: ProductItem): string | undefined {
  return product.sku ?? product.sku_id;
}

export function productName(product: ProductItem): string | undefined {
  return product.name ?? product.title;
}

export function productListPrice(product: ProductItem): number | undefined {
  const value = product.original_list_price ?? product.list_price ?? product.price;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function categoryMatches(product: ProductItem, category_id: string | undefined): boolean {
  if (category_id === undefined) return true;
  if (product.category === category_id) return true;
  if (Array.isArray(product.category_path)) return product.category_path.includes(category_id);
  if (typeof product.category_path === 'string' && product.category_path.split('/').includes(category_id)) return true;
  return product.categories?.includes(category_id) ?? false;
}

export async function readCatalogFromSor(options: SalesSkillToolPortOptions, tenant_id: string): Promise<CatalogRead> {
  if (options.erp_read === null) {
    throw new SalesSkillToolError(
      'AUTHORITATIVE_SOURCE_UNAVAILABLE',
      'Authoritative ERP read connector is unavailable',
    );
  }

  let rawResult: unknown;
  try {
    rawResult = await options.erp_read.read({ tenant_id, resource: 'products' });
  } catch {
    throw new SalesSkillToolError(
      'AUTHORITATIVE_SOURCE_UNAVAILABLE',
      'Authoritative ERP catalog read failed',
    );
  }

  if (typeof rawResult !== 'object' || rawResult === null || Array.isArray(rawResult)) {
    throw new SalesSkillToolError(
      'AUTHORITATIVE_SOURCE_UNAVAILABLE',
      'Authoritative ERP catalog response is invalid',
    );
  }

  const readResult = rawResult as ErpReadResultRecord;
  if (readResult.tenant_id !== tenant_id || !isValidIsoDate(readResult.observed_at)) {
    throw new SalesSkillToolError(
      'AUTHORITATIVE_SOURCE_UNAVAILABLE',
      'Authoritative ERP catalog tenant or timestamp is invalid',
    );
  }

  if (
    typeof readResult.value !== 'object'
    || readResult.value === null
    || Array.isArray(readResult.value)
  ) {
    throw new SalesSkillToolError(
      'AUTHORITATIVE_SOURCE_UNAVAILABLE',
      'Authoritative catalog envelope is missing or invalid',
    );
  }

  const envelope = readResult.value as ProviderEnvelope<ProductItem>;
  const snapshot_at = envelope.snapshot_at ?? envelope.updated_at ?? envelope.observed_at;
  if (
    !isValidIsoDate(snapshot_at)
    || !Array.isArray(envelope.items)
    || (envelope.tenant_id !== undefined && envelope.tenant_id !== tenant_id)
  ) {
    throw new SalesSkillToolError(
      'AUTHORITATIVE_SOURCE_UNAVAILABLE',
      'Authoritative catalog envelope is missing or invalid',
    );
  }

  return {
    snapshot_at,
    observed_at: readResult.observed_at,
    tenant_id,
    items: envelope.items,
  };
}

export interface InventoryBatchRead {
  readonly found: ReadonlyMap<string, InventoryRead>;
  readonly missing: ReadonlySet<string>;
}

/**
 * Reads inventory for a bounded set of SKUs concurrently. Missing rows and per-SKU source
 * failures are scoped to that SKU; callers represent either case as unknown stock.
 */
export async function readInventoryFromSorBatch(
  options: SalesSkillToolPortOptions,
  tenant_id: string,
  sku_ids: readonly string[],
): Promise<InventoryBatchRead> {
  const uniqueSkus = [...new Set(sku_ids)];
  const found = new Map<string, InventoryRead>();
  const missing = new Set<string>();
  const pending = [...uniqueSkus];
  const worker = async (): Promise<void> => {
    while (pending.length > 0) {
      const sku_id = pending.shift();
      if (sku_id === undefined) return;
      try {
        found.set(sku_id, await readInventoryFromSor(options, tenant_id, sku_id));
      } catch {
        // A failed or missing authoritative row is unknown stock for this SKU only. Never infer
        // availability from the catalog or from another SKU's result.
        missing.add(sku_id);
      }
    }
  };
  const workerCount = Math.min(8, Math.max(1, uniqueSkus.length));
  await Promise.allSettled(Array.from({ length: workerCount }, () => worker()));
  return { found, missing };
}


export async function readInventoryFromSor(
  options: SalesSkillToolPortOptions,
  tenant_id: string,
  sku_id: string,
): Promise<InventoryRead> {
  if (options.erp_read === null) {
    throw new SalesSkillToolError(
      'AUTHORITATIVE_SOURCE_UNAVAILABLE',
      'Authoritative ERP read connector is unavailable',
    );
  }

  let rawResult: unknown;
  try {
    rawResult = await options.erp_read.read({ tenant_id, resource: 'inventory', key: sku_id });
  } catch {
    throw new SalesSkillToolError(
      'AUTHORITATIVE_SOURCE_UNAVAILABLE',
      'Authoritative ERP inventory read failed',
    );
  }

  if (typeof rawResult !== 'object' || rawResult === null || Array.isArray(rawResult)) {
    throw new SalesSkillToolError(
      'AUTHORITATIVE_SOURCE_UNAVAILABLE',
      'Authoritative ERP inventory response is invalid',
    );
  }

  const readResult = rawResult as ErpReadResultRecord;
  if (readResult.tenant_id !== tenant_id || !isValidIsoDate(readResult.observed_at)) {
    throw new SalesSkillToolError(
      'AUTHORITATIVE_SOURCE_UNAVAILABLE',
      'Authoritative ERP inventory tenant or timestamp is invalid',
    );
  }

  if (
    typeof readResult.value !== 'object'
    || readResult.value === null
    || Array.isArray(readResult.value)
  ) {
    throw new SalesSkillToolError(
      'AUTHORITATIVE_SOURCE_UNAVAILABLE',
      'Authoritative inventory envelope is missing or invalid',
    );
  }

  const envelope = readResult.value as ProviderEnvelope<InventoryItem>;
  const snapshot_at = envelope.snapshot_at ?? envelope.updated_at ?? envelope.observed_at;
  if (
    !isValidIsoDate(snapshot_at)
    || !Array.isArray(envelope.items)
    || (envelope.tenant_id !== undefined && envelope.tenant_id !== tenant_id)
  ) {
    throw new SalesSkillToolError(
      'AUTHORITATIVE_SOURCE_UNAVAILABLE',
      'Authoritative inventory envelope is missing or invalid',
    );
  }

  const item = envelope.items.find((candidate) =>
    (candidate.sku_id === sku_id || candidate.sku === sku_id)
    && candidate.tenant_id === tenant_id
    && Number.isSafeInteger(candidate.total_available_to_promise)
    && candidate.total_available_to_promise >= 0,
  );
  if (item === undefined) {
    throw new SalesSkillToolError(
      'AUTHORITATIVE_SOURCE_UNAVAILABLE',
      'Requested SKU has no valid authoritative inventory record',
    );
  }

  return {
    snapshot_at,
    observed_at: readResult.observed_at,
    tenant_id,
    item,
  };
}
