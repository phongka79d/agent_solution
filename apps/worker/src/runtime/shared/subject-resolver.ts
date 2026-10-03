import { OrchestratorError } from '@agentos/core-engine/contracts';
import type {
  Customer360Fact,
  DefaultShippingAddress,
  SignalSubject,
} from '@agentos/core-engine/contracts';
import type { ConversationRecord, CustomerProfileRow } from '@agentos/database';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SubjectResolverRepositories {
  readonly getProfile: (tenantId: string, customerId: string) => Promise<CustomerProfileRow | null>;
  readonly getConversation: (tenantId: string, conversationId: string) => Promise<ConversationRecord | null>;
}

export interface ResolvedSubject {
  readonly customer: Customer360Fact | null;
  readonly conversation: ConversationRecord | null;
  readonly default_shipping_address?: DefaultShippingAddress;
}

function mismatch(reason: string): never {
  throw new OrchestratorError(
    'SUBJECT_BINDING_MISMATCH',
    `Gateway subject does not match its tenant-scoped record: ${reason}.`,
  );
}

function timestamp(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

const DEFAULT_SHIPPING_ADDRESS_FIELDS: Readonly<Record<string, true>> = {
  recipient_name: true,
  phone: true,
  postal_code: true,
  city: true,
  district: true,
  address_line1: true,
  cvs_store_id: true,
  cvs_store_name: true,
};

function readDefaultShippingAddress(value: unknown): DefaultShippingAddress | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const address = value as Record<string, unknown>;
  if (Object.keys(address).some((key) => DEFAULT_SHIPPING_ADDRESS_FIELDS[key] !== true)) return undefined;
  const requiredFields = ['recipient_name', 'phone', 'postal_code', 'city', 'district', 'address_line1'] as const;
  for (const key of requiredFields) {
    const field = address[key];
    if (typeof field !== 'string' || field.trim().length === 0 || field.length > 255) return undefined;
  }
  for (const key of ['cvs_store_id', 'cvs_store_name'] as const) {
    const field = address[key];
    if (field !== undefined && (typeof field !== 'string' || field.trim().length === 0 || field.length > 255)) {
      return undefined;
    }
  }
  return {
    recipient_name: address.recipient_name as string,
    phone: address.phone as string,
    postal_code: address.postal_code as string,
    city: address.city as string,
    district: address.district as string,
    address_line1: address.address_line1 as string,
    ...(typeof address.cvs_store_id === 'string' ? { cvs_store_id: address.cvs_store_id } : {}),
    ...(typeof address.cvs_store_name === 'string' ? { cvs_store_name: address.cvs_store_name } : {}),
  };
}
function customerFact(profile: CustomerProfileRow): Customer360Fact {
  return {
    customer_id: profile.customer_id,
    tenant_id: profile.tenant_id,
    verified_phone: profile.verified_phone ?? null,
    verified_email: profile.verified_email ?? null,
    total_spent: Number(profile.total_spent ?? 0),
    order_count: Number(profile.order_count ?? 0),
    rfm_segment_hypothesis: profile.rfm_segment_hypothesis ?? 'UNKNOWN',
    consent_marketing: Boolean(profile.consent_marketing),
    consent_updated_at: timestamp(profile.consent_updated_at),
    suppression_active: Boolean(profile.suppression_active),
    created_at: profile.created_at instanceof Date ? profile.created_at.toISOString() : String(profile.created_at),
  };
}

/** Resolves only gateway-stamped identity and conversation bindings; channel handles never infer identity. */
export async function resolveSubject(
  tenant_id: string,
  subject: SignalSubject,
  repositories: SubjectResolverRepositories,
): Promise<ResolvedSubject> {
  let customer: Customer360Fact | null = null;
  let default_shipping_address: DefaultShippingAddress | undefined;
  const verified_customer_id = subject.verified_customer_id;
  if (verified_customer_id !== undefined) {
    if (typeof verified_customer_id !== 'string' || !UUID.test(verified_customer_id)) {
      mismatch('verified_customer_id is not a customer UUID');
    }
    const profile = await repositories.getProfile(tenant_id, verified_customer_id);
    if (profile === null || profile.tenant_id !== tenant_id || profile.customer_id !== verified_customer_id) {
      mismatch('verified_customer_id is not owned by this tenant');
    }
    customer = customerFact(profile);
    default_shipping_address = readDefaultShippingAddress(profile.default_shipping_address);
  }

  let conversation: ConversationRecord | null = null;
  const conversation_id = subject.conversation_id;
  if (conversation_id !== undefined) {
    if (typeof conversation_id !== 'string' || !UUID.test(conversation_id)) {
      mismatch('conversation_id is not a conversation UUID');
    }
    conversation = await repositories.getConversation(tenant_id, conversation_id);
    if (conversation === null
      || conversation.tenant_id !== tenant_id
      || conversation.conversation_id !== conversation_id) {
      mismatch('conversation_id is not owned by this tenant');
    }
    if (conversation.external_thread_id !== subject.session_id) {
      mismatch('conversation_id is not bound to this session');
    }
    if (conversation.channel !== subject.channel_type
      || typeof subject.channel_identifier !== 'string'
      || conversation.external_thread_id !== subject.channel_identifier) {
      mismatch('conversation_id is not bound to this channel session');
    }
    if (conversation.customer_id !== (customer?.customer_id ?? null)) {
      mismatch('conversation_id is not bound to this verified customer or anonymous session');
    }
  }

  return {
    customer,
    conversation,
    ...(default_shipping_address === undefined ? {} : { default_shipping_address }),
  };
}
