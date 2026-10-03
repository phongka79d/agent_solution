import { describe, expect, it } from 'vitest';

import { sha256CanonicalJson } from './canonical-json.js';
import { approvalPayloadDigest } from './approval-digest.js';

describe('approvalPayloadDigest', () => {
  it('binds only the schema-normalized skill input, excluding envelope and policy metadata', () => {
    const action = {
      skill_id: 'skill.mkt.dispatch_campaign',
      payload: {
        campaign_id: 'camp-1',
        effect_key: 'server-effect-key',
        ignored_by_schema: true,
      },
      required_authority: 'AUTH-4',
      computed_price_floor: 12,
      policy_annotations: { verdict: 'AWAITING_HUMAN_APPROVAL' },
    } as Parameters<typeof approvalPayloadDigest>[0];
    const normalize = (_skill_id: string, input: Record<string, unknown>) => ({
      campaign_id: input.campaign_id,
      send_mode: input.send_mode ?? 'DRAFT',
    });

    expect(approvalPayloadDigest(action, normalize)).toBe(
      sha256CanonicalJson({ campaign_id: 'camp-1', send_mode: 'DRAFT' }),
    );
    expect(approvalPayloadDigest({ skill_id: action.skill_id, payload: { campaign_id: 'camp-1' } }, normalize))
      .toBe(approvalPayloadDigest(action, normalize));
  });

  it('changes when the normalized skill input changes', () => {
    const digest = approvalPayloadDigest({ skill_id: 'skill.sales.create_order', payload: { order_id: 'o-1' } });
    expect(approvalPayloadDigest({ skill_id: 'skill.sales.create_order', payload: { order_id: 'o-2' } }))
      .not.toBe(digest);
  });
});
