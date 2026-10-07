import type { CompanyActivityProjectionSource } from '@agentos/database';

export interface ActivityItem {
  readonly kind: string;
  readonly sentence_key: string;
  readonly params: Readonly<Record<string, string | number | boolean>>;
  readonly run_id: string;
  readonly domain: 'marketing' | 'sales' | 'care' | 'platform';
  readonly occurred_at: string;
}

export interface ActivityProjection {
  readonly items: readonly ActivityItem[];
  readonly next_cursor: string | null;
}

export interface ActivityProjectionSources {
  readonly activity: readonly CompanyActivityProjectionSource[];
}

export interface ActivityPageOptions {
  readonly limit?: number;
  readonly cursor?: string;
}

function activityDomain(value: string | null): ActivityItem['domain'] {
  const text = value?.toLowerCase() ?? '';
  if (text.includes('marketing') || text.includes('mkt')) return 'marketing';
  if (text.includes('sales') || text.includes('sal')) return 'sales';
  if (text.includes('care') || text.includes('support') || text.includes('cs')) return 'care';
  return 'platform';
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor.length === 0) return 0;
  try {
    const value = Number.parseInt(Buffer.from(cursor, 'base64url').toString('utf8'), 10);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

/** Projects observed response/stage/decision rows into catalog-keyed activity sentences. */
export function mapActivity(
  sources: ActivityProjectionSources,
  options: ActivityPageOptions = {},
): ActivityProjection {
  const limit = options.limit === undefined ? 50 : Math.max(1, Math.min(200, Math.trunc(options.limit)));
  const offset = decodeCursor(options.cursor);
  const ordered = [...sources.activity].sort((left, right) => right.occurred_at.localeCompare(left.occurred_at));
  const page = ordered.slice(offset, offset + limit);
  const items = page.map((source): ActivityItem => {
    if (source.kind === 'RUN_RESPONSE') {
      return {
        kind: 'RUN_COMPLETED',
        sentence_key: 'company.activity.run_completed',
        params: { run_id: source.run_id },
        run_id: source.run_id,
        domain: activityDomain(source.domain),
        occurred_at: source.occurred_at,
      };
    }
    if (source.kind === 'RUN_STAGE') {
      return {
        kind: 'RUN_STAGE_ENTERED',
        sentence_key: 'company.activity.run_stage_entered',
        params: { run_id: source.run_id, stage: source.stage ?? 'unknown' },
        run_id: source.run_id,
        domain: activityDomain(source.domain),
        occurred_at: source.occurred_at,
      };
    }
    return {
      kind: 'APPROVAL_DECIDED',
      sentence_key: 'company.activity.approval_decided',
      params: { run_id: source.run_id, decision: source.decision ?? 'unknown' },
      run_id: source.run_id,
      domain: activityDomain(source.domain),
      occurred_at: source.occurred_at,
    };
  });
  const nextOffset = offset + page.length;
  return { items, next_cursor: nextOffset < ordered.length ? encodeCursor(nextOffset) : null };
}

export const projectActivity = mapActivity;
