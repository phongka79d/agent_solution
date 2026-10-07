import { CompanyDetail } from '../../../../components/platform/Companies';

export const metadata = { title: 'Company detail | AgentOS Platform' };
export default async function CompanyDetailRoute({ params }: { readonly params: { readonly id: string } }) {
  return <CompanyDetail id={params.id} />;
}
