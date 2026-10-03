'use client';

import Link from 'next/link';
import { Mail, MessageCircle, MessageSquare, Send, Smartphone, type LucideIcon } from 'lucide-react';
import { StatusBadge } from '@agentos/ui-foundation/react';

import {
  audienceText,
  campaignGroup,
  campaignStatusView,
  channelLabel,
  firstChannel,
  failureReasonText,
  objectiveLabel,
  type CampaignSummary,
} from './campaign-model';

const CHANNEL_ICONS: Readonly<Record<string, LucideIcon>> = {
  EMAIL_HTML: Mail,
  SMS_TEXT: Smartphone,
  ZALO_ZNS: MessageSquare,
  MESSENGER_GENERIC: MessageCircle,
  WHATSAPP_TEMPLATE: MessageCircle,
  LINE_FLEX: MessageSquare,
  TIKTOK_CARD: Send,
  INSTAGRAM_DIRECT: Send,
};

export interface CampaignCardProps {
  readonly campaign: CampaignSummary;
}

export function CampaignCard({ campaign }: CampaignCardProps) {
  const status = campaign.status;
  const state = campaignStatusView(status);
  const group = campaignGroup(status);
  const channel = firstChannel(campaign.channels);
  const ChannelIcon = channel ? CHANNEL_ICONS[channel] ?? Send : Send;
  const detailHref = campaign.run_id ? `/campaigns/${encodeURIComponent(campaign.run_id)}` : null;
  const reason = group === 'failed' ? failureReasonText(campaign.failure_reason_key) : null;

  const name = campaign.name ?? 'Chiến dịch';
  const title = detailHref ? (
    <Link href={detailHref} className="font-semibold text-ink hover:text-primary">
      {name}
    </Link>
  ) : (
    <span className="font-semibold text-ink">{name}</span>
  );

  return (
    <article className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="mt-1 text-sm text-muted">{objectiveLabel(campaign.objective)}</p>
        </div>
        <StatusBadge tone={state.tone} label={state.label} />
      </div>
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted">Đối tượng</dt>
          <dd className="mt-1 text-ink">{audienceText(campaign.audience_count)}</dd>
        </div>
        <div>
          <dt className="text-muted">Kênh</dt>
          <dd className="mt-1 flex items-center gap-2 text-ink">
            <ChannelIcon size={16} aria-hidden="true" focusable="false" />
            {channelLabel(channel)}
          </dd>
        </div>
      </dl>
      {reason ? <p className="text-sm text-danger">Lý do: {reason}</p> : null}
      <div className="mt-auto flex flex-wrap items-center gap-3 text-sm">
        {group === 'awaiting_approval' ? (
          <Link href="/approvals" className="ui-button ui-button--primary">
            Chờ bạn phê duyệt → Xem
          </Link>
        ) : null}
        {detailHref ? (
          <Link href={detailHref} className="text-primary hover:underline">
            Xem chi tiết
          </Link>
        ) : null}
      </div>
    </article>
  );
}
