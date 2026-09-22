export type TenantId = string & { readonly __brand: 'TenantId' };

export interface TenantBinding {
  readonly tenant_id: TenantId;
}
