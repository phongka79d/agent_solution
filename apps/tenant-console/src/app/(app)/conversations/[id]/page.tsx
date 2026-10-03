import { redirect } from 'next/navigation';

export default function ConversationDeepLinkPage({ params }: { readonly params: { readonly id: string } }) {
  redirect(`/conversations?c=${encodeURIComponent(params.id)}`);
}
