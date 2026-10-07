import { RequirePermission } from '../../../components/auth/RequirePermission';
import { ConversationWorkspace } from '../../../components/conversation/ConversationWorkspace';

export const metadata = {
  title: 'Hội thoại | AgentOS',
  description: 'Theo dõi và tiếp quản hội thoại khách hàng.',
};

export default function ConversationsPage() {
  return (
    <RequirePermission permission="conversation:takeover">
      <ConversationWorkspace />
    </RequirePermission>
  );
}
