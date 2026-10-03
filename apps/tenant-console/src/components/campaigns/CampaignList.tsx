'use client';

import Link from 'next/link';
import { useApi } from '@agentos/ui-foundation/data';
import { EmptyState, ErrorBanner, PageHeader, Skeleton } from '@agentos/ui-foundation/react';

import { CampaignCard } from './CampaignCard';
import {
  CAMPAIGN_GROUPS,
  campaignGroup,
  type CampaignGroupKey,
  type CampaignSummary,
} from './campaign-model';

function selectCampaigns(body: unknown): readonly CampaignSummary[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  if (!('items' in body)) return [];
  const items = body.items;
  if (!Array.isArray(items)) return [];
  return items.filter((item): item is CampaignSummary => !!item && typeof item === 'object');
}

export function CampaignList() {
  const { data, error, loading, refresh } = useApi<readonly CampaignSummary[]>('/api/v1/campaigns?limit=100', {
    select: selectCampaigns,
  });
  const campaigns = data ?? [];
  const grouped: Record<CampaignGroupKey, CampaignSummary[]> = {
    drafting: [],
    awaiting_approval: [],
    approved: [],
    failed: [],
  };
  for (const campaign of campaigns) {
    grouped[campaignGroup(campaign.status)].push(campaign);
  }
  const visibleGroups = CAMPAIGN_GROUPS.filter((group) => grouped[group.key].length > 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Chiến dịch"
        description="Theo dõi bản nháp và trạng thái phê duyệt của Marketing."
        actions={<Link className="ui-button ui-button--primary" href="/campaigns/new">Tạo bản nháp</Link>}
      />
      {error ? <ErrorBanner error={error} onRetry={refresh} /> : null}
      {loading ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton variant="card" />
          <Skeleton variant="card" />
        </div>
      ) : visibleGroups.length === 0 ? (
        <EmptyState
          status="NO_DATA"
          title="Chưa có chiến dịch"
          description="Tạo bản nháp đầu tiên để AI soạn nội dung và trình phê duyệt."
        />
      ) : (
        visibleGroups.map((group) => {
          const items = grouped[group.key];
          return (
            <section key={group.key} className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">{group.label}</h2>
                <span className="text-sm text-muted">{items.length}</span>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                {items.map((campaign, index) => (
                  <CampaignCard key={campaign.run_id ?? campaign.campaign_id ?? `${group.key}-${index}`} campaign={campaign} />
                ))}
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}
