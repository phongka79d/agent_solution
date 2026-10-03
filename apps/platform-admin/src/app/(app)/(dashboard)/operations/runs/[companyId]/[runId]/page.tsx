/**
 * Run detail — diagnostic trace route (T8.3, spec §11.2).
 */

import { RunDetailView } from '../../../../../../../components/operations/RunDetailView';

export const metadata = {
  title: 'Chi tiết lượt chạy | AgentOS Platform',
  description: 'Dòng thời gian giai đoạn, lệnh gọi nhà cung cấp và hành động đối soát cho một lượt chạy.',
};

export default function RunDetailPage({
  params,
}: {
  readonly params: { readonly companyId: string; readonly runId: string };
}) {
  return <RunDetailView companyId={params.companyId} runId={params.runId} />;
}
